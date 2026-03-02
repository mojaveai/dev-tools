use std::ops::Range;

use egui::text::LayoutJob;
use egui::{Color32, FontId, Rect, RichText, ScrollArea, TextFormat, Ui, Vec2};

use crate::state::{DiffData, LineStatus, StyledSpan};
use crate::theme;

/// Row height used for virtual scrolling.  We zero out `item_spacing.y` inside
/// the code scroll area so this value is the *total* row stride.  With
/// monospace 13.0 the text is ~17 px; 20.0 gives comfortable line spacing.
pub const ROW_HEIGHT: f32 = 20.0;

/// Width of the colored diff gutter strip on the left margin.
const GUTTER_WIDTH: f32 = 4.0;

/// Horizontal padding between the gutter strip and the code text.
const GUTTER_PAD: f32 = 6.0;

/// A single display row — either a real code line or an inline deleted line.
#[derive(Clone, Copy)]
enum DisplayRow {
    /// A line from the current file (index into the `jobs` slice).
    Code(usize),
    /// A deleted line from a diff section (section index, line within section).
    Deleted(usize, usize),
}

/// Build the interleaved display row list.
///
/// When diff data is present, deleted lines are inserted before their
/// corresponding code line — but only within the `focus` range.  Without
/// diff data, rows map 1:1 to code lines.
fn build_display_rows(
    num_lines: usize,
    diff: Option<&DiffData>,
    focus: Option<&Range<usize>>,
) -> Vec<DisplayRow> {
    let Some(diff) = diff else {
        return (0..num_lines).map(DisplayRow::Code).collect();
    };

    let in_focus = |line: usize| focus.is_none_or(|r| r.contains(&line));

    let mut rows = Vec::with_capacity(num_lines + diff.deleted_sections.len() * 2);
    for i in 0..num_lines {
        // Insert any deleted lines that belong before this code line
        if in_focus(i) {
            for (si, section) in diff.deleted_sections.iter().enumerate() {
                if section.before_line == i {
                    for li in 0..section.lines.len() {
                        rows.push(DisplayRow::Deleted(si, li));
                    }
                }
            }
        }
        rows.push(DisplayRow::Code(i));
    }
    // Deletions at end of file (before_line == num_lines)
    if in_focus(num_lines.saturating_sub(1)) {
        for (si, section) in diff.deleted_sections.iter().enumerate() {
            if section.before_line == num_lines {
                for li in 0..section.lines.len() {
                    rows.push(DisplayRow::Deleted(si, li));
                }
            }
        }
    }
    rows
}

/// Compute the display-row index for a given code line, accounting for
/// interleaved deleted lines within the `focus` range.  Used to convert
/// code-line scroll targets into pixel offsets.
pub fn display_row_for_line(
    line: usize,
    diff: Option<&DiffData>,
    focus: Option<&Range<usize>>,
) -> usize {
    let Some(diff) = diff else { return line };
    let in_focus = |l: usize| focus.is_none_or(|r| r.contains(&l));
    let extra: usize = diff
        .deleted_sections
        .iter()
        .filter(|s| s.before_line <= line && in_focus(s.before_line))
        .map(|s| s.lines.len())
        .sum();
    line + extra
}

/// Pre-compute `LayoutJob`s from server-provided highlight spans.
///
/// If `focus` is `Some(range)`, only lines within that range get full color;
/// all other lines are rendered in a muted gray. If `None`, every line is
/// highlighted normally (used when a file has no functions).
pub fn prepare(
    lines: &[Vec<StyledSpan>],
    focus: Option<Range<usize>>,
    unfocused_color: Color32,
) -> Vec<LayoutJob> {
    let code_font = FontId::monospace(13.0);
    lines
        .iter()
        .enumerate()
        .map(|(i, spans)| {
            let in_focus = focus.as_ref().is_none_or(|r| r.contains(&i));
            if in_focus {
                build_layout_job(spans, &code_font)
            } else {
                build_gray_layout_job(spans, &code_font, unfocused_color)
            }
        })
        .collect()
}

/// Optional diff overlay for the code viewer.
pub struct DiffOverlay<'a> {
    pub data: &'a DiffData,
    /// Restrict diff highlighting to this line range (the active function).
    /// `None` highlights every changed line.
    pub focus: Option<Range<usize>>,
}

/// Render pre-computed layout jobs with virtual scrolling and inline diffs.
///
/// `scroll_y` is applied as the initial vertical offset when the scroll area
/// is first created (after a `scroll_generation` bump). Pass `None` on
/// subsequent frames to let the user scroll freely.
///
/// When `diff` is present, deleted lines are shown inline with a red
/// background, and changed code lines get colored gutter strips and
/// subtle backgrounds (green = added, yellow = modified).  Diff
/// highlighting is restricted to the overlay's `focus` range (the active
/// function); pass `None` to highlight all lines.
#[allow(clippy::too_many_arguments)]
pub fn render(
    ui: &mut Ui,
    jobs: &[LayoutJob],
    path: &str,
    scroll_generation: u64,
    scroll_y: Option<f32>,
    function_label: Option<&str>,
    diff: Option<DiffOverlay<'_>>,
) {
    let has_diff = diff.is_some();
    let (diff_data, focus) = match &diff {
        Some(ov) => (Some(ov.data), ov.focus.as_ref()),
        None => (None, None),
    };
    let display_rows = build_display_rows(jobs.len(), diff_data, focus);
    let total_rows = display_rows.len();

    ui.vertical(|ui| {
        // File path header, optionally with focused function name
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(path)
                    .color(theme::text_muted(ui))
                    .size(12.0)
                    .monospace(),
            );
            if let Some(name) = function_label {
                ui.label(
                    RichText::new(format!(" \u{2192} {name}"))
                        .color(theme::accent(ui))
                        .size(12.0)
                        .strong()
                        .monospace(),
                );
            }
        });
        ui.add_space(4.0);
        ui.separator();
        ui.add_space(4.0);

        // Zero out vertical item spacing so ROW_HEIGHT is the exact row stride.
        ui.spacing_mut().item_spacing.y = 0.0;

        // Reserve left padding for the gutter when diff data is present.
        if has_diff {
            ui.spacing_mut().indent = GUTTER_WIDTH + GUTTER_PAD;
        }

        let mut area = ScrollArea::both()
            .id_salt(scroll_generation)
            .auto_shrink([false, false]);

        if let Some(y) = scroll_y {
            area = area.scroll_offset(egui::vec2(0.0, y));
        }

        let code_font = FontId::monospace(13.0);

        area.show_rows(ui, ROW_HEIGHT, total_rows, |ui, visible_range| {
            // Capture colors once per frame
            let added_gutter = theme::diff_added(ui);
            let deleted_gutter = theme::diff_deleted(ui);
            let added_bg = theme::diff_added_bg(ui);
            let deleted_bg = theme::diff_deleted_bg(ui);
            let deleted_text = theme::diff_deleted(ui);

            for i in visible_range {
                let row_top = ui.cursor().min.y;
                let content_x = ui.cursor().min.x;

                match display_rows[i] {
                    DisplayRow::Code(line_idx) => {
                        // Paint diff background and gutter BEFORE the text
                        // so the source remains visible on top.
                        // Only highlight lines within the focused function.
                        let in_focus = focus.is_none_or(|r| r.contains(&line_idx));
                        if in_focus
                            && let Some(diff) = diff_data
                            && let Some(status) = diff.line_statuses.get(line_idx)
                        {
                            let (gutter_color, bg_color) = match status {
                                LineStatus::Added | LineStatus::Modified => {
                                    (Some(added_gutter), Some(added_bg))
                                }
                                LineStatus::Unchanged => (None, None),
                            };

                            // Full-width row background for changed lines
                            if let Some(bg) = bg_color {
                                let bg_rect = Rect::from_min_max(
                                    egui::pos2(ui.clip_rect().min.x, row_top),
                                    egui::pos2(ui.clip_rect().max.x, row_top + ROW_HEIGHT),
                                );
                                ui.painter()
                                    .rect_filled(bg_rect, egui::CornerRadius::ZERO, bg);
                            }

                            // Gutter strip
                            if let Some(color) = gutter_color {
                                let gutter_rect = Rect::from_min_size(
                                    egui::pos2(content_x - GUTTER_PAD - GUTTER_WIDTH, row_top),
                                    Vec2::new(GUTTER_WIDTH, ROW_HEIGHT),
                                );
                                ui.painter().rect_filled(
                                    gutter_rect,
                                    egui::CornerRadius::ZERO,
                                    color,
                                );
                            }
                        }

                        // Draw text on top of the background
                        ui.label(jobs[line_idx].clone());
                    }
                    DisplayRow::Deleted(section_idx, line_idx) => {
                        let diff = diff_data.expect("Deleted rows only exist with diff data");
                        let text = &diff.deleted_sections[section_idx].lines[line_idx];

                        // Full-width deleted background (painted first)
                        let bg_rect = Rect::from_min_max(
                            egui::pos2(ui.clip_rect().min.x, row_top),
                            egui::pos2(ui.clip_rect().max.x, row_top + ROW_HEIGHT),
                        );
                        ui.painter()
                            .rect_filled(bg_rect, egui::CornerRadius::ZERO, deleted_bg);

                        // Red gutter strip
                        let gutter_rect = Rect::from_min_size(
                            egui::pos2(content_x - GUTTER_PAD - GUTTER_WIDTH, row_top),
                            Vec2::new(GUTTER_WIDTH, ROW_HEIGHT),
                        );
                        ui.painter().rect_filled(
                            gutter_rect,
                            egui::CornerRadius::ZERO,
                            deleted_gutter,
                        );

                        // Draw deleted text on top
                        let mut job = LayoutJob::default();
                        let display_text = if text.is_empty() { " " } else { text };
                        job.append(
                            display_text,
                            0.0,
                            TextFormat {
                                font_id: code_font.clone(),
                                color: deleted_text,
                                strikethrough: egui::Stroke::new(1.0, deleted_text),
                                ..Default::default()
                            },
                        );
                        ui.label(job);
                    }
                }
            }
        });
    });
}

fn build_layout_job(spans: &[StyledSpan], code_font: &FontId) -> LayoutJob {
    let mut job = LayoutJob::default();
    if spans.is_empty() {
        job.append(
            " ",
            0.0,
            TextFormat {
                font_id: code_font.clone(),
                color: Color32::TRANSPARENT,
                ..Default::default()
            },
        );
    } else {
        for span in spans {
            job.append(
                &span.text,
                0.0,
                TextFormat {
                    font_id: code_font.clone(),
                    color: Color32::from_rgb(span.r, span.g, span.b),
                    ..Default::default()
                },
            );
        }
    }
    job
}

/// Build a layout job where all text is rendered in muted gray.
fn build_gray_layout_job(spans: &[StyledSpan], code_font: &FontId, color: Color32) -> LayoutJob {
    let mut job = LayoutJob::default();
    if spans.is_empty() {
        job.append(
            " ",
            0.0,
            TextFormat {
                font_id: code_font.clone(),
                color: Color32::TRANSPARENT,
                ..Default::default()
            },
        );
    } else {
        for span in spans {
            job.append(
                &span.text,
                0.0,
                TextFormat {
                    font_id: code_font.clone(),
                    color,
                    ..Default::default()
                },
            );
        }
    }
    job
}

/// Render the empty state when no file is selected.
pub fn render_empty(ui: &mut Ui, zen_mode: bool) {
    let msg = if zen_mode {
        "Press \u{27A1} or click Next to start reviewing"
    } else {
        "Select a file to view"
    };
    ui.centered_and_justified(|ui| {
        ui.label(RichText::new(msg).color(theme::text_muted(ui)).size(18.0));
    });
}
