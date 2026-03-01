use egui::{Color32, CornerRadius, FontId, Stroke, TextStyle, Visuals, style::Selection};

/// Warm background inspired by distill.pub.
const BG_PRIMARY: Color32 = Color32::from_rgb(0xFA, 0xFA, 0xF8);
const BG_PANEL: Color32 = Color32::from_rgb(0xF4, 0xF4, 0xF1);
const BG_CODE: Color32 = Color32::from_rgb(0xF8, 0xF8, 0xF5);
const TEXT_PRIMARY: Color32 = Color32::from_rgb(0x1A, 0x1A, 0x2E);
const TEXT_MUTED: Color32 = Color32::from_rgb(0x6B, 0x6B, 0x7B);
const ACCENT: Color32 = Color32::from_rgb(0x00, 0x64, 0xB4);
const ACCENT_LIGHT: Color32 = Color32::from_rgb(0xE3, 0xF0, 0xFA);
const BORDER: Color32 = Color32::from_rgb(0xE0, 0xE0, 0xDB);
pub const fn text_primary() -> Color32 {
    TEXT_PRIMARY
}
pub const fn text_muted() -> Color32 {
    TEXT_MUTED
}
pub const fn accent() -> Color32 {
    ACCENT
}

/// Apply the distill.pub-inspired theme to an egui context.
pub fn apply(ctx: &egui::Context) {
    let mut visuals = Visuals::light();

    visuals.panel_fill = BG_PRIMARY;
    visuals.window_fill = BG_PRIMARY;
    visuals.extreme_bg_color = BG_CODE;
    visuals.faint_bg_color = BG_PANEL;

    visuals.widgets.noninteractive.bg_fill = BG_PANEL;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_PRIMARY);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(0.5, BORDER);
    visuals.widgets.noninteractive.corner_radius = CornerRadius::same(4);

    visuals.widgets.inactive.bg_fill = BG_PANEL;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT_PRIMARY);
    visuals.widgets.inactive.bg_stroke = Stroke::new(0.5, BORDER);

    visuals.widgets.hovered.bg_fill = ACCENT_LIGHT;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, ACCENT);

    visuals.widgets.active.bg_fill = ACCENT;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, Color32::WHITE);

    visuals.selection = Selection {
        bg_fill: ACCENT_LIGHT,
        stroke: Stroke::new(1.0, ACCENT),
    };

    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style
        .text_styles
        .insert(TextStyle::Body, FontId::proportional(14.0));
    style
        .text_styles
        .insert(TextStyle::Heading, FontId::proportional(18.0));
    style
        .text_styles
        .insert(TextStyle::Monospace, FontId::monospace(13.0));
    style
        .text_styles
        .insert(TextStyle::Small, FontId::proportional(11.0));
    style.spacing.item_spacing = egui::vec2(8.0, 4.0);
    style.spacing.window_margin = egui::Margin::same(12);
    ctx.set_style(style);
}
