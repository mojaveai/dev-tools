use std::sync::Arc;

use eframe::Frame;
use egui::{CentralPanel, SidePanel, TopBottomPanel, RichText};

use crate::state::{AsyncData, FileNode, SharedAsync, shared_loading};
use crate::{code_viewer, file_browser, theme};

/// Response shape for GET /api/file
#[derive(serde::Deserialize)]
struct FileResponse {
    #[allow(dead_code)]
    path: String,
    content: String,
}

pub struct CodeReviewApp {
    file_list: SharedAsync<Vec<String>>,
    file_tree: Vec<FileNode>,
    selected_path: Option<String>,
    file_content: Option<SharedAsync<String>>,
    theme_applied: bool,
}

impl CodeReviewApp {
    pub fn new() -> Self {
        Self {
            file_list: shared_loading(),
            file_tree: Vec::new(),
            selected_path: None,
            file_content: None,
            theme_applied: false,
        }
    }

    /// Kick off the initial file list fetch.
    pub fn fetch_file_list(&self, ctx: &egui::Context) {
        let data = Arc::clone(&self.file_list);
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get("/api/files"), move |result| {
            let value = match result {
                Ok(response) => {
                    serde_json::from_slice::<Vec<String>>(&response.bytes)
                        .map(AsyncData::Loaded)
                        .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}")))
                }
                Err(err) => AsyncData::Error(err),
            };
            *data.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    fn fetch_file_content(&mut self, path: &str, ctx: &egui::Context) {
        let shared: SharedAsync<String> = shared_loading();
        self.file_content = Some(Arc::clone(&shared));

        let url = format!("/api/file?path={}", js_encode_uri_component(path));
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => {
                    serde_json::from_slice::<FileResponse>(&response.bytes)
                        .map(|r| AsyncData::Loaded(r.content))
                        .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}")))
                }
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    fn update_tree_if_needed(&mut self) {
        let data = self.file_list.lock().unwrap();
        if let AsyncData::Loaded(paths) = &*data
            && self.file_tree.is_empty()
            && !paths.is_empty()
        {
            self.file_tree = FileNode::build_tree(paths);
        }
    }
}

impl eframe::App for CodeReviewApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut Frame) {
        if !self.theme_applied {
            theme::apply(ctx);
            self.theme_applied = true;
        }

        self.update_tree_if_needed();

        // Top bar
        TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("Code Review")
                        .strong()
                        .size(16.0)
                        .color(theme::text_primary()),
                );
                ui.separator();
                let file_count = self.file_list.lock().unwrap()
                    .as_loaded()
                    .map_or(0, Vec::len);
                ui.label(
                    RichText::new(format!("{file_count} files"))
                        .color(theme::text_muted())
                        .size(12.0),
                );
            });
            ui.add_space(4.0);
        });

        // Left panel: file browser
        SidePanel::left("file_browser")
            .default_width(260.0)
            .resizable(true)
            .show(ctx, |ui| {
                ui.add_space(8.0);
                ui.label(
                    RichText::new("Files")
                        .strong()
                        .size(14.0)
                        .color(theme::text_primary()),
                );
                ui.add_space(4.0);
                ui.separator();
                ui.add_space(4.0);

                let data = self.file_list.lock().unwrap();
                match &*data {
                    AsyncData::Loading => {
                        ui.spinner();
                        ui.label("Loading files...");
                    }
                    AsyncData::Error(err) => {
                        ui.colored_label(egui::Color32::RED, format!("Error: {err}"));
                    }
                    AsyncData::Loaded(_) => {
                        drop(data); // release lock before rendering tree
                        egui::ScrollArea::vertical().show(ui, |ui| {
                            if let Some(path) = file_browser::render(
                                ui,
                                &self.file_tree,
                                self.selected_path.as_deref(),
                            )
                                && self.selected_path.as_deref() != Some(path.as_str())
                            {
                                self.selected_path = Some(path.clone());
                                self.fetch_file_content(&path, ctx);
                            }
                        });
                    }
                }
            });

        // Central panel: code viewer
        CentralPanel::default().show(ctx, |ui| {
            match (&self.selected_path, &self.file_content) {
                (Some(path), Some(content_handle)) => {
                    let data = content_handle.lock().unwrap();
                    match &*data {
                        AsyncData::Loading => {
                            ui.centered_and_justified(|ui| {
                                ui.spinner();
                            });
                        }
                        AsyncData::Error(err) => {
                            ui.colored_label(egui::Color32::RED, format!("Error: {err}"));
                        }
                        AsyncData::Loaded(content) => {
                            let content = content.clone();
                            let path = path.clone();
                            drop(data);
                            code_viewer::render(ui, &content, &path);
                        }
                    }
                }
                _ => {
                    code_viewer::render_empty(ui);
                }
            }
        });
    }
}

/// Minimal percent-encoding for URI component (WASM-safe).
fn js_encode_uri_component(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | '/' => {
                c.to_string()
            }
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
