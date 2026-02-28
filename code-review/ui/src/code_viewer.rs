use egui::{Align, Layout, RichText, ScrollArea, Ui};

use crate::theme;

/// Render a code file with line numbers in a scrollable area.
pub fn render(ui: &mut Ui, content: &str, path: &str) {
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
                let lines: Vec<&str> = content.lines().collect();
                let gutter_width = format!("{}", lines.len()).len() as f32 * 8.0 + 16.0;

                for (i, line) in lines.iter().enumerate() {
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
                            egui::FontId::monospace(12.0),
                            theme::text_muted(),
                        );

                        ui.add_space(8.0);

                        // Code line
                        ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                            ui.label(
                                RichText::new(*line)
                                    .monospace()
                                    .color(theme::text_primary())
                                    .size(13.0),
                            );
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
