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

## Async Data Pattern

- Use `Arc<Mutex<AsyncData<T>>>` to bridge `ehttp` callbacks to immediate-mode rendering
- Call `ctx.request_repaint()` in the callback to wake egui when data arrives
- Clone the `egui::Context` before moving into the callback closure
- Drop `MutexGuard` before rendering UI that might re-lock (e.g., tree rendering after checking load state)

## Layout Tips

- `SidePanel::left("id").default_width(260.0).resizable(true)` for file browsers
- `TopBottomPanel::top("id")` for headers — renders before central panel
- `CentralPanel::default()` fills remaining space — must be added last
- `ScrollArea::both().auto_shrink([false, false])` for code viewers that fill space
- `CollapsingHeader` for tree nodes, `selectable_label` for leaf items
- `centered_and_justified` for centered empty-state messages

## Performance

- Theme application: do once with a bool flag, not every frame
- Don't re-fetch data on every frame — use state flags
- Drop mutex locks ASAP before doing more UI work
- `ehttp` handles WASM fetch API; callbacks run on the main thread
