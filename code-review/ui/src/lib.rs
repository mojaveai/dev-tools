mod app;
mod code_viewer;
mod file_browser;
mod perf;
mod state;
mod theme;

use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

/// Handle exposed to JavaScript for lifecycle management.
#[wasm_bindgen]
pub struct WebHandle {
    runner: Option<eframe::WebRunner>,
}

#[wasm_bindgen]
impl WebHandle {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        // Pipe `log` crate messages to browser console
        eframe::WebLogger::init(log::LevelFilter::Debug).ok();
        Self { runner: None }
    }

    /// Start the eframe app on the given canvas element ID.
    #[wasm_bindgen]
    pub async fn start(&mut self, canvas_id: &str) -> Result<(), JsValue> {
        let runner = eframe::WebRunner::new();

        let document = web_sys::window()
            .expect("No window")
            .document()
            .expect("No document");

        let canvas = document
            .get_element_by_id(canvas_id)
            .expect("Canvas element not found")
            .dyn_into::<web_sys::HtmlCanvasElement>()
            .expect("Element is not a canvas");

        runner
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(|cc| {
                    let mut app = app::CodeReviewApp::new();
                    // Fire both fetches in parallel so the first navigation
                    // can happen as soon as both the file list and git status
                    // are known.
                    app.fetch_file_list(&cc.egui_ctx);
                    app.fetch_diff_file_lists(&cc.egui_ctx);
                    app.fetch_review_order_lists(&cc.egui_ctx);
                    Ok(Box::new(app))
                }),
            )
            .await?;

        self.runner = Some(runner);
        Ok(())
    }

    /// Destroy the runner and free resources.
    #[wasm_bindgen]
    pub fn destroy(&self) {
        if let Some(runner) = &self.runner {
            runner.destroy();
        }
    }
}

impl Default for WebHandle {
    fn default() -> Self {
        Self::new()
    }
}
