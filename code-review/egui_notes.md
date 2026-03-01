# egui / eframe Notes

Key reference notes for developing with egui 0.33 / eframe 0.33.

## WASM Entry Point (eframe 0.33)

- `WebRunner::start` takes `web_sys::HtmlCanvasElement` (not a string ID)
- Use `document.get_element_by_id()` + `.dyn_into::<HtmlCanvasElement>()` to get the canvas
- Requires `wasm-bindgen::JsCast` for the `dyn_into` call
- `AppCreator` signature: `Box<dyn FnOnce(&CreationContext) -> Result<Box<dyn App>, Box<dyn Error>>>`

## Styling (egui 0.33)

- `Rounding` is renamed to `CornerRadius` — values are `u8`, not `f32`
- Use `CornerRadius::same(4)` for uniform rounding
- Widget styles live in `Visuals::widgets` with states: `noninteractive`, `inactive`, `hovered`, `active`, `open`
- `WidgetVisuals` fields: `bg_fill`, `weak_bg_fill`, `bg_stroke`, `corner_radius`, `fg_stroke`, `expansion`
- `Margin::same(12)` takes an `i8` value
- Use `ctx.set_visuals_of(Theme::Light, ...)` and `ctx.set_visuals_of(Theme::Dark, ...)` to install both theme palettes once
- `ctx.set_theme(ThemePreference::System)` makes the app follow OS/browser dark/light preference by default
- `ctx.theme()` returns the currently effective theme (after applying system preference and user override)

## Async Data Pattern

- Use `Arc<Mutex<AsyncData<T>>>` to bridge `ehttp` callbacks to immediate-mode rendering
- Call `ctx.request_repaint()` in the callback to wake egui when data arrives
- Clone the `egui::Context` before moving into the callback closure
- Drop `MutexGuard` before rendering UI that might re-lock (e.g., tree rendering after checking load state)
- For expensive secondary analysis (like call graphs), trigger fetches only when selection/focus changes, not every frame

## Layout Tips

- `SidePanel::left("id").default_width(260.0).resizable(true)` for file browsers
- `SidePanel::right("id").default_width(...).resizable(true)` works well for contextual metadata panes
- `TopBottomPanel::top("id")` for headers — renders before central panel
- `CentralPanel::default()` fills remaining space — must be added last
- `ScrollArea::both().auto_shrink([false, false])` for code viewers that fill space
- `CollapsingHeader` for tree nodes, `selectable_label` for leaf items
- `egui::Window::new("...").open(&mut open)` gives a fast-dismiss popup via built-in `X`; pair with explicit `Esc` handling for keyboard-close
- Window placement persistence is keyed by egui id/title; set a stable `.id(egui::Id::new("..."))` if popup position should stay fixed across content changes
- `egui::Label::new(...).sense(egui::Sense::click())` is useful when you want clickable rich labels without button styling
- `centered_and_justified` for centered empty-state messages

## Rich Text with LayoutJob

- `LayoutJob` allows rendering a single label with multiple styled spans (font, color per segment)
- Use `job.append(text, leading_space, TextFormat { font_id, color, .. })` to add spans
- Much more efficient than multiple `RichText` labels for syntax-highlighted code
- For empty lines, append a transparent space to maintain row height
- `TextFormat` fields: `font_id`, `color`, `background`, `italics`, `underline`, `strikethrough`, `valign`

## Scroll Performance (Critical)

- **Never** use `ScrollArea::show()` with large content — it lays out ALL rows every frame
- Use `ScrollArea::show_rows(ui, row_height, total_rows, |ui, range| { ... })` for virtualized scrolling
  - Only visible rows are laid out → constant per-frame cost regardless of content size
  - `row_height` is height sans spacing; egui adds `item_spacing.y` between rows automatically
  - Works with `ScrollArea::both()` for horizontal + virtual-vertical scrolling
- For manual control, `show_viewport(ui, |ui, viewport| { ... })` gives raw viewport rect to compute visible range yourself
- Row height must be consistent across all rows for accurate scroll positioning

## Performance

- Theme application: do once with a bool flag, not every frame
- Don't re-fetch data on every frame — use state flags
- Drop mutex locks ASAP before doing more UI work
- `ehttp` handles WASM fetch API; callbacks run on the main thread
