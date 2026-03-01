use std::ops::Range;

use egui::text::LayoutJob;
use egui::{Color32, FontId, RichText, ScrollArea, TextFormat, Ui};

use crate::state::StyledSpan;
use crate::theme;

/// Row height used for virtual scrolling.  We zero out `item_spacing.y` inside
/// the code scroll area so this value is the *total* row stride.  With
/// monospace 13.0 the text is ~17 px; 20.0 gives comfortable line spacing.
pub const ROW_HEIGHT: f32 = 20.0;

/// Muted color for lines outside the focused function.
const UNFOCUSED_GRAY: Color32 = Color32::from_rgb(0xCC, 0xCC, 0xCC);

/// Pre-compute `LayoutJob`s from server-provided highlight spans.
///
/// If `focus` is `Some(range)`, only lines within that range get full color;
/// all other lines are rendered in a muted gray. If `None`, every line is
/// highlighted normally (used when a file has no functions).
pub fn prepare(lines: &[Vec<StyledSpan>], focus: Option<Range<usize>>) -> Vec<LayoutJob> {
    let code_font = FontId::monospace(13.0);
    lines
        .iter()
        .enumerate()
        .map(|(i, spans)| {
            let in_focus = focus.as_ref().is_none_or(|r| r.contains(&i));
            if in_focus {
                build_layout_job(spans, &code_font)
            } else {
                build_gray_layout_job(spans, &code_font)
            }
        })
        .collect()
}

/// Render pre-computed layout jobs with virtual scrolling.
///
/// `scroll_y` is applied as the initial vertical offset when the scroll area
/// is first created (after a `scroll_generation` bump). Pass `None` on
/// subsequent frames to let the user scroll freely.
pub fn render(
    ui: &mut Ui,
    jobs: &[LayoutJob],
    path: &str,
    scroll_generation: u64,
    scroll_y: Option<f32>,
    function_label: Option<&str>,
) {
    ui.vertical(|ui| {
        // File path header, optionally with focused function name
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(path)
                    .color(theme::text_muted())
                    .size(12.0)
                    .monospace(),
            );
            if let Some(name) = function_label {
                ui.label(
                    RichText::new(format!(" \u{2192} {name}"))
                        .color(theme::accent())
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
        // This keeps scroll offset calculations (start_line * ROW_HEIGHT) accurate.
        ui.spacing_mut().item_spacing.y = 0.0;

        let mut area = ScrollArea::both()
            .id_salt(scroll_generation)
            .auto_shrink([false, false]);

        if let Some(y) = scroll_y {
            area = area.scroll_offset(egui::vec2(0.0, y));
        }

        area.show_rows(ui, ROW_HEIGHT, jobs.len(), |ui, visible_range| {
            for i in visible_range {
                ui.label(jobs[i].clone());
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
fn build_gray_layout_job(spans: &[StyledSpan], code_font: &FontId) -> LayoutJob {
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
                    color: UNFOCUSED_GRAY,
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
        ui.label(
            RichText::new(msg)
                .color(theme::text_muted())
                .size(18.0),
        );
    });
}
