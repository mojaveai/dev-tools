use std::sync::Arc;

use eframe::Frame;
use egui::text::LayoutJob;
use egui::{CentralPanel, Key, RichText, SidePanel, TopBottomPanel};

use crate::perf::FrameStats;
use crate::state::{
    AsyncData, CallTreeNode, FileNode, FilePayload, FilesResponse, FunctionInfo, FunctionRef,
    FunctionRelations, HighlightedLines, SharedAsync, collect_paths, shared_loading,
};
use crate::{code_viewer, file_browser, theme};

/// Response shape for GET /api/file
#[derive(serde::Deserialize)]
struct FileResponse {
    #[allow(dead_code)]
    path: String,
    #[allow(dead_code)]
    content: String,
    highlights: HighlightedLines,
    functions: Vec<FunctionInfo>,
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

enum FunctionRelationsState {
    Empty,
    Ready(FunctionRelations),
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
    /// In-flight fetch for focused-function caller/callee data.
    pending_relations: Option<SharedAsync<FunctionRelations>>,
    /// Resolved caller/callee info for the focused function.
    relations: FunctionRelationsState,
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
            pending_relations: None,
            relations: FunctionRelationsState::Empty,
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
        self.pending_relations = None;
        self.relations = FunctionRelationsState::Empty;

        let url = format!("/api/file?path={}", js_encode_uri_component(path));
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<FileResponse>(&response.bytes)
                    .map(|r| {
                        AsyncData::Loaded(FilePayload {
                            highlights: r.highlights,
                            functions: r.functions,
                        })
                    })
                    .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}"))),
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    fn fetch_function_relations(&mut self, path: &str, start_line: usize, ctx: &egui::Context) {
        let shared: SharedAsync<FunctionRelations> = shared_loading();
        self.pending_relations = Some(Arc::clone(&shared));
        self.relations = FunctionRelationsState::Empty;

        let url = format!(
            "/api/function-relations?path={}&start_line={start_line}",
            js_encode_uri_component(path)
        );
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<FunctionRelations>(&response.bytes)
                    .map(AsyncData::Loaded)
                    .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}"))),
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    /// Move data out of the async handle once it arrives, converting spans
    /// to `LayoutJob`s exactly once. After this, rendering is lock-free.
    fn poll_pending_content(&mut self, ctx: &egui::Context) {
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
                self.content = FileContent::Ready {
                    jobs,
                    spans: payload.highlights,
                    functions: payload.functions,
                };
                self.apply_function_scroll(0);
                self.refresh_focused_relations(ctx);
            }
            AsyncData::Error(err) => {
                self.content = FileContent::Error(err);
                self.pending_relations = None;
                self.relations = FunctionRelationsState::Empty;
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_content = None;
    }

    /// Move focused-function relationship data out of the async handle.
    fn poll_pending_relations(&mut self) {
        let Some(pending) = self.pending_relations.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();

        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(relations) => {
                self.relations = FunctionRelationsState::Ready(relations);
            }
            AsyncData::Error(err) => {
                self.relations = FunctionRelationsState::Error(err);
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_relations = None;
    }

    /// Start caller/callee fetch for the currently focused function.
    fn refresh_focused_relations(&mut self, ctx: &egui::Context) {
        let (Some(path), Some(func)) =
            (self.selected_path.as_deref(), self.focused_function_info())
        else {
            self.pending_relations = None;
            self.relations = FunctionRelationsState::Empty;
            return;
        };

        let path = path.to_owned();
        let start_line = func.start_line;
        self.fetch_function_relations(&path, start_line, ctx);
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
        if self.try_focus_function(self.focused_function + 1, ctx) {
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
        if self.focused_function > 0 && self.try_focus_function(self.focused_function - 1, ctx) {
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
    fn try_focus_function(&mut self, index: usize, ctx: &egui::Context) -> bool {
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
        self.apply_function_scroll(index);
        self.refresh_focused_relations(ctx);
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
            FileContent::Ready { functions, .. } if !functions.is_empty() => functions
                .get(self.focused_function)
                .map(|f| f.name.as_str()),
            _ => None,
        }
    }

    /// Metadata for the currently focused function, if any.
    fn focused_function_info(&self) -> Option<&FunctionInfo> {
        match &self.content {
            FileContent::Ready { functions, .. } if !functions.is_empty() => {
                functions.get(self.focused_function)
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

    fn focused_function_ref(&self) -> Option<FunctionRef> {
        match (&self.selected_path, self.focused_function_info()) {
            (Some(path), Some(function)) => Some(FunctionRef {
                path: path.clone(),
                name: function.name.clone(),
                start_line: function.start_line,
            }),
            _ => None,
        }
    }

    fn render_relations_panel(&self, ui: &mut egui::Ui) {
        ui.add_space(8.0);
        ui.label(
            RichText::new("Call Graph")
                .strong()
                .size(14.0)
                .color(theme::text_primary()),
        );
        ui.add_space(4.0);
        ui.separator();
        ui.add_space(8.0);

        let focused = match &self.relations {
            FunctionRelationsState::Ready(relations) => relations
                .focus
                .clone()
                .or_else(|| self.focused_function_ref()),
            _ => self.focused_function_ref(),
        };

        let Some(focused) = focused else {
            ui.label(
                RichText::new("No focused function")
                    .size(12.0)
                    .color(theme::text_muted()),
            );
            return;
        };

        self.render_function_title(ui, &focused);
        ui.add_space(8.0);

        if self.pending_relations.is_some() {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(
                    RichText::new("Resolving callers/callees...")
                        .size(12.0)
                        .color(theme::text_muted()),
                );
            });
            return;
        }

        match &self.relations {
            FunctionRelationsState::Ready(relations) => {
                self.render_tree_section(
                    ui,
                    "Callees",
                    &relations.callee_tree,
                    "No direct callees",
                    "callee",
                    "Expand nodes to walk down the call stack",
                );
                ui.add_space(8.0);
                self.render_tree_section(
                    ui,
                    "Callers",
                    &relations.caller_tree,
                    "No callers",
                    "caller",
                    "Expand nodes to walk up the call stack",
                );
                ui.add_space(8.0);
                self.render_test_section(ui, &relations.test_callers);
            }
            FunctionRelationsState::Error(err) => {
                ui.colored_label(egui::Color32::RED, format!("Call graph error: {err}"));
            }
            FunctionRelationsState::Empty => {
                ui.label(
                    RichText::new("No relationship data yet")
                        .size(12.0)
                        .color(theme::text_muted()),
                );
            }
        }
    }

    fn render_function_title(&self, ui: &mut egui::Ui, function: &FunctionRef) {
        egui::Frame {
            fill: egui::Color32::from_rgb(0xEF, 0xF3, 0xF7),
            stroke: egui::Stroke::new(1.0, egui::Color32::from_rgb(0xD7, 0xDF, 0xE7)),
            corner_radius: egui::CornerRadius::same(6),
            inner_margin: egui::Margin::symmetric(8, 6),
            ..Default::default()
        }
        .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(
                    RichText::new("FOCUS")
                        .size(9.5)
                        .monospace()
                        .color(theme::text_muted()),
                );
                ui.label(
                    RichText::new(function.name.as_str())
                        .size(13.0)
                        .strong()
                        .color(theme::text_primary()),
                );
            });
            ui.label(
                RichText::new(format!("{}:{}", function.path, function.start_line + 1))
                    .size(10.5)
                    .monospace()
                    .color(theme::text_muted()),
            );
        });
    }

    fn render_function_entry(
        &self,
        ui: &mut egui::Ui,
        function: &FunctionRef,
        depth: usize,
        cycle: bool,
        is_test: bool,
    ) {
        let fill = match depth % 3 {
            0 => egui::Color32::from_rgb(0xFA, 0xFA, 0xF8),
            1 => egui::Color32::from_rgb(0xF6, 0xF6, 0xF3),
            _ => egui::Color32::from_rgb(0xF2, 0xF2, 0xEF),
        };
        let border = if cycle {
            theme::accent()
        } else {
            egui::Color32::from_rgb(0xDF, 0xDF, 0xD9)
        };

        egui::Frame {
            fill,
            stroke: egui::Stroke::new(1.0, border),
            corner_radius: egui::CornerRadius::same(6),
            inner_margin: egui::Margin::symmetric(8, 5),
            ..Default::default()
        }
        .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(
                    RichText::new(function.name.as_str())
                        .size(12.0)
                        .strong()
                        .color(theme::text_primary()),
                );

                if is_test {
                    ui.label(
                        RichText::new("TEST")
                            .size(9.5)
                            .monospace()
                            .background_color(egui::Color32::from_rgb(0xE6, 0xF3, 0xEC))
                            .color(egui::Color32::from_rgb(0x2E, 0x6A, 0x45)),
                    );
                }

                if cycle {
                    ui.label(
                        RichText::new("CYCLE")
                            .size(9.5)
                            .monospace()
                            .background_color(egui::Color32::from_rgb(0xF6, 0xE8, 0xE3))
                            .color(theme::accent()),
                    );
                }
            });

            ui.label(
                RichText::new(format!("{}:{}", function.path, function.start_line + 1))
                    .size(10.5)
                    .monospace()
                    .color(theme::text_muted()),
            );
        });
    }

    fn render_tree_section(
        &self,
        ui: &mut egui::Ui,
        title: &str,
        items: &[CallTreeNode],
        empty_msg: &str,
        id_prefix: &str,
        hint: &str,
    ) {
        egui::CollapsingHeader::new(
            RichText::new(format!("{title} ({})", items.len()))
                .size(12.0)
                .strong()
                .color(theme::text_primary()),
        )
        .id_salt(("call-tree-section", id_prefix))
        .default_open(false)
        .show(ui, |ui| {
            if items.is_empty() {
                ui.label(
                    RichText::new(empty_msg)
                        .size(11.0)
                        .color(theme::text_muted()),
                );
                return;
            }

            ui.label(RichText::new(hint).size(10.5).color(theme::text_muted()));
            ui.add_space(4.0);
            self.render_tree_nodes(ui, items, id_prefix, 0);
        });
    }

    fn render_test_section(&self, ui: &mut egui::Ui, items: &[FunctionRef]) {
        egui::CollapsingHeader::new(
            RichText::new(format!("Tests ({})", items.len()))
                .size(12.0)
                .strong()
                .color(theme::text_primary()),
        )
        .id_salt("call-tree-tests")
        .default_open(false)
        .show(ui, |ui| {
            if items.is_empty() {
                ui.label(
                    RichText::new("No tests exercise this function")
                        .size(11.0)
                        .color(theme::text_muted()),
                );
                return;
            }

            ui.label(
                RichText::new("Includes direct and indirect test callers")
                    .size(10.5)
                    .color(theme::text_muted()),
            );
            ui.add_space(4.0);
            items.iter().for_each(|item| {
                self.render_function_entry(ui, item, 0, false, true);
                ui.add_space(3.0);
            });
        });
    }

    fn render_tree_nodes(
        &self,
        ui: &mut egui::Ui,
        items: &[CallTreeNode],
        id_prefix: &str,
        depth: usize,
    ) {
        items.iter().enumerate().for_each(|(index, item)| {
            let id = format!(
                "{id_prefix}:{depth}:{index}:{}:{}",
                item.function.path, item.function.start_line
            );
            self.render_tree_node(ui, item, id.as_str(), depth + 1);
            if index + 1 < items.len() {
                ui.add_space(3.0);
            }
        });
    }

    fn render_tree_node(
        &self,
        ui: &mut egui::Ui,
        item: &CallTreeNode,
        node_id: &str,
        depth: usize,
    ) {
        if item.children.is_empty() {
            let indent = (depth.saturating_sub(1) as f32 * 12.0).min(72.0);
            ui.horizontal(|ui| {
                ui.add_space(indent);
                self.render_function_entry(ui, &item.function, depth, item.cycle, false);
            });

            if item.truncated {
                ui.label(
                    RichText::new("... more nodes omitted")
                        .size(10.0)
                        .monospace()
                        .color(theme::text_muted()),
                );
            }
            return;
        }

        let id = ui.make_persistent_id(("call-tree-node", node_id));
        let _ =
            egui::collapsing_header::CollapsingState::load_with_default_open(ui.ctx(), id, false)
                .show_header(ui, |ui| {
                    self.render_function_entry(ui, &item.function, depth, item.cycle, false);
                })
                .body(|ui| {
                    self.render_tree_nodes(ui, &item.children, node_id, depth);
                    if item.truncated {
                        ui.label(
                            RichText::new("... more nodes omitted")
                                .size(10.0)
                                .monospace()
                                .color(theme::text_muted()),
                        );
                    }
                });
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
        self.poll_pending_content(ctx);
        self.poll_pending_relations();

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
            self.scroll_offset_y = functions
                .get(last)
                .map(|f| f.start_line as f32 * code_viewer::ROW_HEIGHT)
                .unwrap_or(0.0);
            self.scroll_generation += 1;
            self.refresh_focused_relations(ctx);
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

                // Right-align the zen mode toggle
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.checkbox(
                        &mut self.zen_mode,
                        RichText::new("Zen Mode")
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
                        if let Some(path) =
                            file_browser::render(ui, &self.file_tree, self.selected_path.as_deref())
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

        SidePanel::right("function_relations")
            .default_width(320.0)
            .resizable(true)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("function_relations_scroll")
                    .show(ui, |ui| self.render_relations_panel(ui));
            });

        // Bottom nav bar (zen mode only, when files are loaded)
        if self.zen_mode && file_count > 0 {
            TopBottomPanel::bottom("zen_nav").show(ctx, |ui| {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let at_start = current_pos.is_none_or(|i| i == 0) && self.focused_function == 0;
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
        CentralPanel::default().show(ctx, |ui| match (&self.selected_path, &self.content) {
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
