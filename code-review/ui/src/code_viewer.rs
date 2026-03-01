use egui::{Color32, FontId, RichText, ScrollArea, TextFormat, Ui};
use egui::text::LayoutJob;

use crate::state::StyledSpan;
use crate::theme;

/// Row height sans spacing — must match the actual height each line renders at.
/// With monospace 13.0 the text is ~17px; we round to 18.0 for breathing room.
const ROW_HEIGHT: f32 = 18.0;

/// Pre-compute `LayoutJob`s from server-provided highlight spans.
/// Called once when file content arrives — avoids rebuilding jobs every frame.
pub fn prepare(lines: &[Vec<StyledSpan>]) -> Vec<LayoutJob> {
    let code_font = FontId::monospace(13.0);
    lines.iter().map(|spans| build_layout_job(spans, &code_font)).collect()
}

/// Render pre-computed layout jobs with virtual scrolling.
///
/// Uses `ScrollArea::show_rows` so only visible lines are laid out each frame,
/// keeping the per-frame cost constant regardless of file length.
pub fn render(ui: &mut Ui, jobs: &[LayoutJob], path: &str, scroll_generation: u64) {
    ui.vertical(|ui| {
        // File path header
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(path)
                    .color(theme::text_muted())
                    .size(12.0)
                    .monospace(),
            );
        });
        ui.add_space(4.0);
        ui.separator();
        ui.add_space(4.0);

        ScrollArea::both()
            .id_salt(scroll_generation)
            .auto_shrink([false, false])
            .show_rows(ui, ROW_HEIGHT, jobs.len(), |ui, visible_range| {
                for i in visible_range {
                    ui.label(jobs[i].clone());
                }
            });
    });
}

fn build_layout_job(spans: &[StyledSpan], code_font: &FontId) -> LayoutJob {
    let mut job = LayoutJob::default();
    if spans.is_empty() {
        // Empty line fallback — ensure the row still occupies space
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
