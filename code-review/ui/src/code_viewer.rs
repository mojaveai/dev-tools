use egui::{Align, Color32, FontId, Layout, RichText, ScrollArea, TextFormat, Ui};
use egui::text::LayoutJob;

use crate::state::HighlightedLines;
use crate::theme;

/// Render a syntax-highlighted code file with line numbers.
pub fn render(ui: &mut Ui, lines: &HighlightedLines, path: &str) {
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
            .auto_shrink([false, false])
            .show(ui, |ui| {
                let line_count = lines.len();
                let gutter_width = format!("{line_count}").len() as f32 * 8.0 + 16.0;
                let code_font = FontId::monospace(13.0);

                for (i, spans) in lines.iter().enumerate() {
                    let line_num = i + 1;
                    ui.horizontal(|ui| {
                        // Line number gutter
                        let gutter_rect = ui.allocate_space(egui::vec2(gutter_width, 16.0));
                        ui.painter().rect_filled(
                            gutter_rect.1,
                            0.0,
                            theme::gutter_bg(),
                        );
                        ui.painter().text(
                            gutter_rect.1.right_center() - egui::vec2(8.0, 0.0),
                            egui::Align2::RIGHT_CENTER,
                            format!("{line_num}"),
                            FontId::monospace(12.0),
                            theme::text_muted(),
                        );

                        ui.add_space(8.0);

                        // Highlighted code line via LayoutJob
                        ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                            let mut job = LayoutJob::default();
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
                            // Empty line fallback — ensure the row still occupies space
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
                            }
                            ui.label(job);
                        });
                    });
                }
            });
    });
}

/// Render the empty state when no file is selected.
pub fn render_empty(ui: &mut Ui) {
    ui.centered_and_justified(|ui| {
        ui.label(
            RichText::new("Select a file to view")
                .color(theme::text_muted())
                .size(18.0),
        );
    });
}
