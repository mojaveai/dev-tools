use egui::{
    Color32, CornerRadius, FontId, Stroke, TextStyle, Theme, ThemePreference, Visuals,
    style::Selection,
};

#[derive(Clone, Copy)]
struct Palette {
    bg_primary: Color32,
    bg_panel: Color32,
    bg_code: Color32,
    text_primary: Color32,
    text_muted: Color32,
    accent: Color32,
    accent_surface: Color32,
    border: Color32,
    focus_fill: Color32,
    focus_stroke: Color32,
    entry_fill: [Color32; 3],
    entry_border: Color32,
    test_badge_bg: Color32,
    test_badge_fg: Color32,
    cycle_badge_bg: Color32,
    unfocused_code: Color32,
}

const LIGHT: Palette = Palette {
    bg_primary: Color32::from_rgb(0xFA, 0xFA, 0xF8),
    bg_panel: Color32::from_rgb(0xF4, 0xF4, 0xF1),
    bg_code: Color32::from_rgb(0xF8, 0xF8, 0xF5),
    text_primary: Color32::from_rgb(0x1A, 0x1A, 0x2E),
    text_muted: Color32::from_rgb(0x6B, 0x6B, 0x7B),
    accent: Color32::from_rgb(0x00, 0x64, 0xB4),
    accent_surface: Color32::from_rgb(0xE3, 0xF0, 0xFA),
    border: Color32::from_rgb(0xE0, 0xE0, 0xDB),
    focus_fill: Color32::from_rgb(0xEF, 0xF3, 0xF7),
    focus_stroke: Color32::from_rgb(0xD7, 0xDF, 0xE7),
    entry_fill: [
        Color32::from_rgb(0xFA, 0xFA, 0xF8),
        Color32::from_rgb(0xF6, 0xF6, 0xF3),
        Color32::from_rgb(0xF2, 0xF2, 0xEF),
    ],
    entry_border: Color32::from_rgb(0xDF, 0xDF, 0xD9),
    test_badge_bg: Color32::from_rgb(0xE6, 0xF3, 0xEC),
    test_badge_fg: Color32::from_rgb(0x2E, 0x6A, 0x45),
    cycle_badge_bg: Color32::from_rgb(0xF6, 0xE8, 0xE3),
    unfocused_code: Color32::from_rgb(0xCC, 0xCC, 0xCC),
};

const DARK: Palette = Palette {
    bg_primary: Color32::from_rgb(0x14, 0x18, 0x1E),
    bg_panel: Color32::from_rgb(0x1A, 0x20, 0x27),
    bg_code: Color32::from_rgb(0x11, 0x15, 0x1A),
    text_primary: Color32::from_rgb(0xE7, 0xEC, 0xF3),
    text_muted: Color32::from_rgb(0x9E, 0xA8, 0xB6),
    accent: Color32::from_rgb(0x6A, 0xB8, 0xFF),
    accent_surface: Color32::from_rgb(0x1E, 0x2E, 0x3E),
    border: Color32::from_rgb(0x2D, 0x36, 0x42),
    focus_fill: Color32::from_rgb(0x1A, 0x28, 0x37),
    focus_stroke: Color32::from_rgb(0x3B, 0x4D, 0x63),
    entry_fill: [
        Color32::from_rgb(0x17, 0x1C, 0x22),
        Color32::from_rgb(0x1B, 0x21, 0x29),
        Color32::from_rgb(0x21, 0x28, 0x32),
    ],
    entry_border: Color32::from_rgb(0x36, 0x41, 0x4E),
    test_badge_bg: Color32::from_rgb(0x1D, 0x3B, 0x2A),
    test_badge_fg: Color32::from_rgb(0x95, 0xE1, 0xB8),
    cycle_badge_bg: Color32::from_rgb(0x3A, 0x25, 0x20),
    unfocused_code: Color32::from_rgb(0x5C, 0x66, 0x74),
};

fn palette(theme: Theme) -> Palette {
    match theme {
        Theme::Dark => DARK,
        Theme::Light => LIGHT,
    }
}

fn palette_for_ui(ui: &egui::Ui) -> Palette {
    palette(ui.ctx().theme())
}

fn visuals(theme: Theme) -> Visuals {
    let palette = palette(theme);
    let mut visuals = match theme {
        Theme::Dark => Visuals::dark(),
        Theme::Light => Visuals::light(),
    };

    visuals.panel_fill = palette.bg_primary;
    visuals.window_fill = palette.bg_primary;
    visuals.extreme_bg_color = palette.bg_code;
    visuals.faint_bg_color = palette.bg_panel;

    visuals.widgets.noninteractive.bg_fill = palette.bg_panel;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, palette.text_primary);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(0.5, palette.border);
    visuals.widgets.noninteractive.corner_radius = CornerRadius::same(4);

    visuals.widgets.inactive.bg_fill = palette.bg_panel;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, palette.text_primary);
    visuals.widgets.inactive.bg_stroke = Stroke::new(0.5, palette.border);

    visuals.widgets.hovered.bg_fill = palette.accent_surface;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, palette.accent);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, palette.accent);

    visuals.widgets.active.bg_fill = palette.accent;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, Color32::WHITE);

    visuals.selection = Selection {
        bg_fill: palette.accent_surface,
        stroke: Stroke::new(1.0, palette.accent),
    };

    visuals
}

fn configure_style(style: &mut egui::Style) {
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
}

/// Apply theme defaults and install custom light/dark palettes.
pub fn apply(ctx: &egui::Context) {
    // Start in "follow system" mode so first render matches OS/browser preference.
    ctx.set_theme(ThemePreference::System);
    ctx.set_visuals_of(Theme::Light, visuals(Theme::Light));
    ctx.set_visuals_of(Theme::Dark, visuals(Theme::Dark));
    ctx.all_styles_mut(configure_style);
}

pub fn text_primary(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).text_primary
}

pub fn text_muted(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).text_muted
}

pub fn accent(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).accent
}

pub fn focus_fill(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).focus_fill
}

pub fn focus_stroke(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).focus_stroke
}

pub fn entry_fill(ui: &egui::Ui, depth: usize) -> Color32 {
    palette_for_ui(ui).entry_fill[depth % 3]
}

pub fn entry_stroke(ui: &egui::Ui, cycle: bool) -> Color32 {
    if cycle {
        accent(ui)
    } else {
        palette_for_ui(ui).entry_border
    }
}

pub fn test_badge_bg(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).test_badge_bg
}

pub fn test_badge_fg(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).test_badge_fg
}

pub fn cycle_badge_bg(ui: &egui::Ui) -> Color32 {
    palette_for_ui(ui).cycle_badge_bg
}

pub fn unfocused_code_for(theme: Theme) -> Color32 {
    palette(theme).unfocused_code
}
