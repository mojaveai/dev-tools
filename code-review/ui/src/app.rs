use std::sync::Arc;

use eframe::Frame;
use egui::{CentralPanel, Key, SidePanel, TopBottomPanel, RichText};
use egui::text::LayoutJob;

use crate::perf::FrameStats;
use crate::state::{AsyncData, FileNode, HighlightedLines, SharedAsync, collect_paths, shared_loading};
use crate::{code_viewer, file_browser, theme};

/// Response shape for GET /api/file
#[derive(serde::Deserialize)]
struct FileResponse {
    #[allow(dead_code)]
    path: String,
    #[allow(dead_code)]
    content: String,
    highlights: HighlightedLines,
}

/// Resolved file content — no mutex needed during rendering.
enum FileContent {
    /// No file selected or fetch in progress.
    Empty,
    /// Pre-computed layout jobs, ready to render.
    Ready(Vec<LayoutJob>),
    /// Fetch or parse failed.
    Error(String),
}

pub struct CodeReviewApp {
    file_list: SharedAsync<Vec<String>>,
    file_tree: Vec<FileNode>,
    /// Flat file paths in tree-display order, for sequential navigation.
    flat_paths: Vec<String>,
    selected_path: Option<String>,
    /// In-flight fetch handle — polled each frame until resolved.
    pending_content: Option<SharedAsync<HighlightedLines>>,
    /// Resolved content — lives here lock-free after the fetch completes.
    content: FileContent,
    theme_applied: bool,
    frame_stats: FrameStats,
    zen_mode: bool,
}

impl CodeReviewApp {
    pub fn new() -> Self {
        Self {
            file_list: shared_loading(),
            file_tree: Vec::new(),
            flat_paths: Vec::new(),
            selected_path: None,
            pending_content: None,
            content: FileContent::Empty,
            theme_applied: false,
            frame_stats: FrameStats::new(),
            zen_mode: true,
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
        let shared: SharedAsync<HighlightedLines> = shared_loading();
        self.pending_content = Some(Arc::clone(&shared));
        self.content = FileContent::Empty;

        let url = format!("/api/file?path={}", js_encode_uri_component(path));
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => {
                    serde_json::from_slice::<FileResponse>(&response.bytes)
                        .map(|r| AsyncData::Loaded(r.highlights))
                        .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}")))
                }
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    /// Move data out of the async handle once it arrives, converting spans
    /// to `LayoutJob`s exactly once. After this, rendering is lock-free.
    fn poll_pending_content(&mut self) {
        let Some(pending) = self.pending_content.clone() else { return };
        let mut guard = pending.lock().unwrap();

        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(lines) => {
                drop(guard);
                self.content = FileContent::Ready(code_viewer::prepare(&lines));
            }
            AsyncData::Error(err) => {
                self.content = FileContent::Error(err);
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_content = None;
    }

    fn update_tree_if_needed(&mut self) {
        let data = self.file_list.lock().unwrap();
        if let AsyncData::Loaded(paths) = &*data
            && self.file_tree.is_empty()
            && !paths.is_empty()
        {
            self.file_tree = FileNode::build_tree(paths);
            self.flat_paths = collect_paths(&self.file_tree);
        }
    }

    /// Index of the currently selected file in the flat path list.
    fn current_index(&self) -> Option<usize> {
        let sel = self.selected_path.as_deref()?;
        self.flat_paths.iter().position(|p| p == sel)
    }

    /// Navigate to the file at `index`, fetching its content.
    fn navigate_to(&mut self, index: usize, ctx: &egui::Context) {
        if let Some(path) = self.flat_paths.get(index).cloned() {
            self.selected_path = Some(path.clone());
            self.fetch_file_content(&path, ctx);
        }
    }

    fn navigate_next(&mut self, ctx: &egui::Context) {
        let next = self
            .current_index()
            .map(|i| (i + 1).min(self.flat_paths.len().saturating_sub(1)))
            .unwrap_or(0);
        self.navigate_to(next, ctx);
    }

    fn navigate_prev(&mut self, ctx: &egui::Context) {
        let prev = self
            .current_index()
            .map(|i| i.saturating_sub(1))
            .unwrap_or(0);
        self.navigate_to(prev, ctx);
    }
}

impl eframe::App for CodeReviewApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut Frame) {
        let t0 = self.frame_stats.begin();

        if !self.theme_applied {
            theme::apply(ctx);
            self.theme_applied = true;
        }

        self.update_tree_if_needed();
        self.poll_pending_content();

        // Arrow key navigation (works in both modes)
        if ctx.input(|i| i.key_pressed(Key::ArrowRight)) {
            self.navigate_next(ctx);
        }
        if ctx.input(|i| i.key_pressed(Key::ArrowLeft)) {
            self.navigate_prev(ctx);
        }

        let file_count = self.flat_paths.len();
        let current_pos = self.current_index();

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
                let count_label = current_pos.map_or_else(
                    || format!("{file_count} files"),
                    |i| format!("{} / {file_count}", i + 1),
                );
                ui.label(
                    RichText::new(count_label)
                        .color(theme::text_muted())
                        .size(12.0),
                );

                // Right-align the zen mode toggle
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.checkbox(
                        &mut self.zen_mode,
                        RichText::new("Zen Mode").size(12.0).color(theme::text_muted()),
                    );
                });
            });
            ui.add_space(4.0);
        });

        // Left panel: file browser (hidden in zen mode)
        if !self.zen_mode {
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
        }

        // Bottom nav bar (zen mode only, when files are loaded)
        if self.zen_mode && file_count > 0 {
            TopBottomPanel::bottom("zen_nav").show(ctx, |ui| {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let at_start = current_pos.is_none_or(|i| i == 0);
                    let at_end = current_pos.is_some_and(|i| i + 1 >= file_count);

                    if ui.add_enabled(!at_start, egui::Button::new(
                        RichText::new("\u{2190} Prev").size(13.0),
                    )).clicked() {
                        self.navigate_prev(ctx);
                    }

                    if ui.add_enabled(!at_end, egui::Button::new(
                        RichText::new("Next \u{2192}").size(13.0),
                    )).clicked() {
                        self.navigate_next(ctx);
                    }

                    ui.label(
                        RichText::new("\u{2190}\u{2192} arrow keys")
                            .size(11.0)
                            .color(theme::text_muted()),
                    );
                });
                ui.add_space(4.0);
            });
        }

        // Central panel: code viewer
        CentralPanel::default().show(ctx, |ui| {
            match (&self.selected_path, &self.content) {
                (Some(path), FileContent::Ready(jobs)) => {
                    code_viewer::render(ui, jobs, path);
                }
                (Some(_), FileContent::Error(err)) => {
                    ui.colored_label(egui::Color32::RED, format!("Error: {err}"));
                }
                (Some(_), FileContent::Empty) => {
                    ui.centered_and_justified(|ui| {
                        ui.spinner();
                    });
                }
                _ => {
                    code_viewer::render_empty(ui, self.zen_mode);
                }
            }
        });

        self.frame_stats.end(t0);
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
