use std::sync::Arc;

use eframe::Frame;
use egui::text::LayoutJob;
use egui::{CentralPanel, Key, RichText, SidePanel, TopBottomPanel};

use crate::perf::FrameStats;
use crate::call_graph::CallGraphState;
use crate::state::{
    AsyncData, CallEdge, FileNode, FilePayload, FilesResponse, FunctionInfo, HighlightedLines,
    SharedAsync, collect_paths, shared_loading,
};
use crate::{call_graph, code_viewer, file_browser, theme};

/// Response shape for GET /api/file
#[derive(serde::Deserialize)]
struct FileResponse {
    #[allow(dead_code)]
    path: String,
    #[allow(dead_code)]
    content: String,
    highlights: HighlightedLines,
    functions: Vec<FunctionInfo>,
    #[serde(default)]
    call_edges: Vec<CallEdge>,
}

/// Resolved file content — no mutex needed during rendering.
enum FileContent {
    /// No file selected or fetch in progress.
    Empty,
    /// Pre-computed layout jobs, ready to render.
    Ready {
        jobs: Vec<LayoutJob>,
        /// Original spans retained for re-preparing when focus changes.
        spans: HighlightedLines,
        /// Function definitions in this file.
        functions: Vec<FunctionInfo>,
    },
    /// Fetch or parse failed.
    Error(String),
}

pub struct CodeReviewApp {
    /// In-flight file list fetch — polled each frame.
    pending_file_list: Option<SharedAsync<FilesResponse>>,
    file_tree: Vec<FileNode>,
    /// Flat file paths in tree-display order, for sequential navigation.
    flat_paths: Vec<String>,
    selected_path: Option<String>,
    /// In-flight fetch handle — polled each frame until resolved.
    pending_content: Option<SharedAsync<FilePayload>>,
    /// Resolved content — lives here lock-free after the fetch completes.
    content: FileContent,
    theme_applied: bool,
    frame_stats: FrameStats,
    zen_mode: bool,
    /// Number of file paths we last built the tree from.
    known_file_count: usize,
    /// Whether the server has finished scanning.
    scan_complete: bool,
    /// egui time at which to fire the next file-list poll.
    poll_files_after: Option<f64>,
    /// Bumped on every file/function change so the scroll area resets.
    scroll_generation: u64,
    /// Last `scroll_generation` for which we applied the scroll offset.
    last_applied_scroll: u64,
    /// Desired vertical scroll offset for the next scroll reset.
    scroll_offset_y: f32,
    /// Index of the currently focused function within the file.
    focused_function: usize,
    /// Call graph visualization state — `None` when no call relationships exist.
    call_graph_state: Option<CallGraphState>,
    /// Whether the call graph panel is visible.
    show_call_graph: bool,
}

impl CodeReviewApp {
    pub fn new() -> Self {
        Self {
            pending_file_list: None,
            file_tree: Vec::new(),
            flat_paths: Vec::new(),
            selected_path: None,
            pending_content: None,
            content: FileContent::Empty,
            theme_applied: false,
            frame_stats: FrameStats::new(),
            zen_mode: true,
            known_file_count: 0,
            scan_complete: false,
            poll_files_after: None,
            scroll_generation: 0,
            last_applied_scroll: 0,
            scroll_offset_y: 0.0,
            focused_function: 0,
            call_graph_state: None,
            show_call_graph: true,
        }
    }

    /// Kick off a file-list fetch (initial or follow-up poll).
    pub fn fetch_file_list(&mut self, ctx: &egui::Context) {
        let shared: SharedAsync<FilesResponse> = shared_loading();
        self.pending_file_list = Some(Arc::clone(&shared));
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get("/api/files"), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<FilesResponse>(&response.bytes)
                    .map(AsyncData::Loaded)
                    .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}"))),
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    fn fetch_file_content(&mut self, path: &str, ctx: &egui::Context) {
        let shared: SharedAsync<FilePayload> = shared_loading();
        self.pending_content = Some(Arc::clone(&shared));
        self.content = FileContent::Empty;

        let url = format!("/api/file?path={}", js_encode_uri_component(path));
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<FileResponse>(&response.bytes)
                    .map(|r| {
                        AsyncData::Loaded(FilePayload {
                            highlights: r.highlights,
                            functions: r.functions,
                            call_edges: r.call_edges,
                        })
                    })
                    .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}"))),
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    /// Move data out of the async handle once it arrives, converting spans
    /// to `LayoutJob`s exactly once. After this, rendering is lock-free.
    fn poll_pending_content(&mut self) {
        let Some(pending) = self.pending_content.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();

        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(payload) => {
                drop(guard);
                self.focused_function = 0;
                let focus = focus_range(&payload.functions, 0);
                let jobs = code_viewer::prepare(&payload.highlights, focus);
                self.call_graph_state =
                    CallGraphState::build(&payload.functions, &payload.call_edges);
                self.content = FileContent::Ready {
                    jobs,
                    spans: payload.highlights,
                    functions: payload.functions,
                };
                self.apply_function_scroll(0);
            }
            AsyncData::Error(err) => {
                self.content = FileContent::Error(err);
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_content = None;
    }

    /// Check if the in-flight file-list fetch has completed. When new files
    /// arrive, rebuild the tree and schedule the next poll if still scanning.
    fn poll_file_list(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_file_list.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();

        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(resp) => {
                drop(guard);
                self.pending_file_list = None;

                let new_count = resp.files.len();
                if new_count != self.known_file_count {
                    let auto_open = self.known_file_count == 0 && new_count > 0;
                    self.known_file_count = new_count;
                    self.file_tree = FileNode::build_tree(&resp.files);
                    self.flat_paths = collect_paths(&self.file_tree);

                    if auto_open {
                        self.navigate_to(0, ctx);
                    }
                }

                if resp.scanning {
                    self.schedule_file_poll(ctx);
                } else {
                    self.scan_complete = true;
                }
            }
            AsyncData::Error(_err) => {
                self.pending_file_list = None;
                if !self.scan_complete {
                    self.schedule_file_poll(ctx);
                }
            }
            AsyncData::Loading => unreachable!(),
        }
    }

    /// Schedule the next file-list poll 500 ms from now.
    fn schedule_file_poll(&mut self, ctx: &egui::Context) {
        let now = ctx.input(|i| i.time);
        self.poll_files_after = Some(now + 0.5);
        ctx.request_repaint_after(std::time::Duration::from_millis(500));
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
            self.focused_function = 0;
            self.scroll_generation += 1;
            self.scroll_offset_y = 0.0;
            self.fetch_file_content(&path, ctx);
        }
    }

    /// Advance to the next function, or the next file if at the last function.
    fn navigate_next(&mut self, ctx: &egui::Context) {
        if self.try_focus_function(self.focused_function + 1) {
            return;
        }
        // Move to next file
        let next = self
            .current_index()
            .map(|i| (i + 1).min(self.flat_paths.len().saturating_sub(1)))
            .unwrap_or(0);
        self.navigate_to(next, ctx);
    }

    /// Go back to the previous function, or the previous file (last function) if at the first.
    fn navigate_prev(&mut self, ctx: &egui::Context) {
        if self.focused_function > 0 && self.try_focus_function(self.focused_function - 1) {
            return;
        }
        // Move to previous file — focused_function will be set to last once content loads
        let prev = self
            .current_index()
            .map(|i| i.saturating_sub(1))
            .unwrap_or(0);
        if self.current_index() == Some(prev) && self.focused_function == 0 {
            return; // already at the very start
        }
        self.navigate_to_last_function(prev, ctx);
    }

    /// Navigate to a file and focus its last function (for backward navigation).
    fn navigate_to_last_function(&mut self, index: usize, ctx: &egui::Context) {
        if let Some(path) = self.flat_paths.get(index).cloned() {
            self.selected_path = Some(path.clone());
            // Set a sentinel value — will be clamped in poll_pending_content
            self.focused_function = usize::MAX;
            self.scroll_generation += 1;
            self.scroll_offset_y = 0.0;
            self.fetch_file_content(&path, ctx);
        }
    }

    /// Try to focus function at `index` within the current file's function list.
    /// Returns `true` if successful, `false` if out of bounds.
    fn try_focus_function(&mut self, index: usize) -> bool {
        let FileContent::Ready {
            jobs,
            spans,
            functions,
        } = &mut self.content
        else {
            return false;
        };

        if functions.is_empty() || index >= functions.len() {
            return false;
        }

        self.focused_function = index;
        let focus = focus_range(functions, index);
        *jobs = code_viewer::prepare(spans, focus);
        if let Some(cg) = &mut self.call_graph_state {
            cg.update_focus_colors(index, functions);
        }
        self.apply_function_scroll(index);
        true
    }

    /// Bump scroll generation and set offset to the start of the given function.
    fn apply_function_scroll(&mut self, fn_index: usize) {
        self.scroll_generation += 1;
        self.scroll_offset_y = match &self.content {
            FileContent::Ready { functions, .. } => functions
                .get(fn_index)
                .map(|f| f.start_line as f32 * code_viewer::ROW_HEIGHT)
                .unwrap_or(0.0),
            _ => 0.0,
        };
    }

    /// The name of the currently focused function, if any.
    fn focused_function_name(&self) -> Option<&str> {
        match &self.content {
            FileContent::Ready { functions, .. } if !functions.is_empty() => {
                functions.get(self.focused_function).map(|f| f.name.as_str())
            }
            _ => None,
        }
    }

    /// Number of functions in the current file.
    fn function_count(&self) -> usize {
        match &self.content {
            FileContent::Ready { functions, .. } => functions.len(),
            _ => 0,
        }
    }
}

/// Compute the focus range for a given function index, or `None` if no functions.
fn focus_range(functions: &[FunctionInfo], index: usize) -> Option<std::ops::Range<usize>> {
    functions.get(index).map(|f| f.start_line..f.end_line)
}

impl eframe::App for CodeReviewApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut Frame) {
        let t0 = self.frame_stats.begin();

        if !self.theme_applied {
            theme::apply(ctx);
            self.theme_applied = true;
        }

        // Fire a follow-up file-list poll if the timer has elapsed.
        if let Some(t) = self.poll_files_after
            && ctx.input(|i| i.time) >= t
        {
            self.poll_files_after = None;
            self.fetch_file_list(ctx);
        }

        self.poll_file_list(ctx);
        self.poll_pending_content();

        // When navigating backwards, clamp focused_function to the last function.
        if self.focused_function == usize::MAX
            && let FileContent::Ready {
                jobs,
                spans,
                functions,
            } = &mut self.content
        {
            let last = functions.len().saturating_sub(1);
            self.focused_function = last;
            let focus = focus_range(functions, last);
            *jobs = code_viewer::prepare(spans, focus);
            if let Some(cg) = &mut self.call_graph_state {
                cg.update_focus_colors(last, functions);
            }
            self.scroll_offset_y = functions
                .get(last)
                .map(|f| f.start_line as f32 * code_viewer::ROW_HEIGHT)
                .unwrap_or(0.0);
            self.scroll_generation += 1;
        }

        // Arrow key navigation
        if ctx.input(|i| i.key_pressed(Key::ArrowRight)) {
            self.navigate_next(ctx);
        }
        if ctx.input(|i| i.key_pressed(Key::ArrowLeft)) {
            self.navigate_prev(ctx);
        }

        let file_count = self.flat_paths.len();
        let current_pos = self.current_index();
        let func_name = self.focused_function_name().map(String::from);
        let func_count = self.function_count();
        let focused_fn = self.focused_function;

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

                // Show focused function name and counter
                if let Some(ref name) = func_name {
                    ui.separator();
                    ui.label(
                        RichText::new(format!("{name}  ({} / {func_count})", focused_fn + 1))
                            .color(theme::accent())
                            .size(12.0)
                            .strong(),
                    );
                }

                if !self.scan_complete {
                    ui.spinner();
                }

                // Right-align toggles
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.checkbox(
                        &mut self.zen_mode,
                        RichText::new("Zen Mode")
                            .size(12.0)
                            .color(theme::text_muted()),
                    );
                    ui.checkbox(
                        &mut self.show_call_graph,
                        RichText::new("Call Graph")
                            .size(12.0)
                            .color(theme::text_muted()),
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

                    egui::ScrollArea::vertical().show(ui, |ui| {
                        if let Some(path) = file_browser::render(
                            ui,
                            &self.file_tree,
                            self.selected_path.as_deref(),
                        )
                            && self.selected_path.as_deref() != Some(path.as_str())
                        {
                            self.selected_path = Some(path.clone());
                            self.focused_function = 0;
                            self.scroll_generation += 1;
                            self.scroll_offset_y = 0.0;
                            self.fetch_file_content(&path, ctx);
                        }
                    });
                });
        }

        // Right panel: call graph (hidden in zen mode or when toggled off)
        let mut graph_clicked_fn: Option<usize> = None;
        if !self.zen_mode && self.show_call_graph {
            SidePanel::right("call_graph")
                .default_width(280.0)
                .resizable(true)
                .show(ctx, |ui| {
                    ui.add_space(8.0);
                    ui.label(
                        RichText::new("Call Graph")
                            .strong()
                            .size(14.0)
                            .color(theme::text_primary()),
                    );

                    // Show neighbor stats for focused function.
                    if let (Some(cg), FileContent::Ready { functions, .. }) =
                        (&self.call_graph_state, &self.content)
                    {
                        let (callers, callees) = cg.neighbor_stats(functions);
                        ui.label(
                            RichText::new(format!(
                                "{callers} caller{}, {callees} callee{}",
                                if callers == 1 { "" } else { "s" },
                                if callees == 1 { "" } else { "s" },
                            ))
                            .size(11.0)
                            .color(theme::text_muted()),
                        );
                    }

                    ui.add_space(4.0);
                    ui.separator();
                    ui.add_space(4.0);

                    if let Some(cg) = &mut self.call_graph_state {
                        graph_clicked_fn = call_graph::render(ui, cg);
                    } else {
                        ui.centered_and_justified(|ui| {
                            ui.label(
                                RichText::new("No call relationships")
                                    .size(12.0)
                                    .color(theme::text_muted()),
                            );
                        });
                    }
                });
        }

        // Handle click on a call graph node — navigate code viewer to that function.
        if let Some(fn_index) = graph_clicked_fn {
            self.try_focus_function(fn_index);
        }

        // Bottom nav bar (zen mode only, when files are loaded)
        if self.zen_mode && file_count > 0 {
            TopBottomPanel::bottom("zen_nav").show(ctx, |ui| {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let at_start =
                        current_pos.is_none_or(|i| i == 0) && self.focused_function == 0;
                    let at_end = current_pos.is_some_and(|i| i + 1 >= file_count)
                        && (func_count == 0 || self.focused_function + 1 >= func_count);

                    if ui
                        .add_enabled(
                            !at_start,
                            egui::Button::new(RichText::new("\u{2B05} Prev").size(13.0)),
                        )
                        .clicked()
                    {
                        self.navigate_prev(ctx);
                    }

                    if ui
                        .add_enabled(
                            !at_end,
                            egui::Button::new(RichText::new("Next \u{27A1}").size(13.0)),
                        )
                        .clicked()
                    {
                        self.navigate_next(ctx);
                    }

                    ui.label(
                        RichText::new("\u{2B05}\u{27A1} arrow keys")
                            .size(11.0)
                            .color(theme::text_muted()),
                    );
                });
                ui.add_space(4.0);
            });
        }

        // Determine scroll offset — only apply on the frame where generation changed.
        let scroll_y = if self.scroll_generation != self.last_applied_scroll {
            self.last_applied_scroll = self.scroll_generation;
            Some(self.scroll_offset_y)
        } else {
            None
        };

        // Central panel: code viewer
        CentralPanel::default().show(ctx, |ui| {
            match (&self.selected_path, &self.content) {
                (Some(path), FileContent::Ready { jobs, .. }) => {
                    code_viewer::render(
                        ui,
                        jobs,
                        path,
                        self.scroll_generation,
                        scroll_y,
                        func_name.as_deref(),
                    );
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
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | '/' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
