use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use eframe::Frame;
use egui::text::LayoutJob;
use egui::{CentralPanel, Key, RichText, SidePanel, TopBottomPanel};

use crate::perf::FrameStats;
use crate::state::{
    AsyncData, CallTreeNode, DiffData, DiffFilesResponse, DiffMode, DiffResponse, FileNode,
    FilePayload, FileScope, FilesResponse, FunctionInfo, FunctionRef, FunctionRelations,
    HighlightedLines, ReviewOrderResponse, SharedAsync, ThemedHighlights, collect_paths,
    shared_loading,
};
use crate::{code_viewer, file_browser, theme};

/// Response shape for GET /api/file
#[derive(serde::Deserialize)]
struct FileResponse {
    #[allow(dead_code)]
    path: String,
    #[allow(dead_code)]
    content: String,
    highlights: ThemedHighlights,
    functions: Vec<FunctionInfo>,
}

/// Response shape for GET /api/function-code
#[derive(serde::Deserialize)]
struct FunctionCodeResponse {
    path: String,
    name: String,
    start_line: usize,
    end_line: usize,
    highlights: ThemedHighlights,
}

/// Resolved file content — no mutex needed during rendering.
enum FileContent {
    /// No file selected or fetch in progress.
    Empty,
    /// Pre-computed layout jobs, ready to render.
    Ready {
        jobs: Vec<LayoutJob>,
        /// Original spans for light/dark themes, retained for theme/focus refreshes.
        highlights: ThemedHighlights,
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

enum QuickViewState {
    Closed,
    Loading(FunctionRef),
    Ready {
        function: FunctionRef,
        end_line: usize,
        highlights: ThemedHighlights,
        jobs: Vec<LayoutJob>,
    },
    Error {
        function: FunctionRef,
        message: String,
    },
}

#[derive(Debug, Clone, Default)]
struct ReviewOrderCache {
    file_rank: HashMap<String, usize>,
    function_rank: HashMap<String, HashMap<usize, usize>>,
}

impl ReviewOrderCache {
    fn from_response(resp: ReviewOrderResponse) -> Self {
        let mut file_rank = HashMap::new();
        let mut function_rank = HashMap::new();

        resp.files
            .into_iter()
            .enumerate()
            .for_each(|(file_idx, file)| {
                file_rank.insert(file.path.clone(), file_idx);
                let per_file = file
                    .functions
                    .into_iter()
                    .enumerate()
                    .map(|(fn_idx, function)| (function.start_line, fn_idx))
                    .collect::<HashMap<_, _>>();
                function_rank.insert(file.path, per_file);
            });

        Self {
            file_rank,
            function_rank,
        }
    }
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
    /// In-flight fetch for the right-panel quick reference popup.
    pending_quick_view: Option<SharedAsync<FunctionCodeResponse>>,
    /// Popup state for previewing another function's code.
    quick_view: QuickViewState,
    theme_applied: bool,
    last_theme: Option<egui::Theme>,
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
    /// Which file subset to navigate in zen mode.
    file_scope: FileScope,
    /// Subset of `flat_paths` matching the current scope.
    filtered_paths: Vec<String>,
    /// Files changed relative to HEAD.
    head_changed: Vec<String>,
    /// Files changed relative to the base branch.
    branch_changed: Vec<String>,
    /// In-flight diff for the currently selected file.
    pending_diff: Option<SharedAsync<DiffResponse>>,
    /// Resolved diff data for gutter painting.
    current_diff: Option<DiffData>,
    /// In-flight fetch for HEAD-changed file list.
    pending_head_files: Option<SharedAsync<DiffFilesResponse>>,
    /// In-flight fetch for branch-changed file list.
    pending_branch_files: Option<SharedAsync<DiffFilesResponse>>,
    /// In-flight fetch for HEAD review-order ranking.
    pending_head_review_order: Option<SharedAsync<ReviewOrderResponse>>,
    /// In-flight fetch for branch review-order ranking.
    pending_branch_review_order: Option<SharedAsync<ReviewOrderResponse>>,
    /// Heuristic ranking cache for HEAD mode.
    head_review_order: ReviewOrderCache,
    /// Heuristic ranking cache for branch mode.
    branch_review_order: ReviewOrderCache,
    /// Whether the repo is a git repo (None = not yet checked).
    is_git_repo: Option<bool>,
    /// Deferred until both the file list and git status are known,
    /// so the first file shown respects the active filter.
    needs_initial_navigation: bool,
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
            pending_quick_view: None,
            quick_view: QuickViewState::Closed,
            theme_applied: false,
            last_theme: None,
            frame_stats: FrameStats::new(),
            zen_mode: true,
            known_file_count: 0,
            scan_complete: false,
            poll_files_after: None,
            scroll_generation: 0,
            last_applied_scroll: 0,
            scroll_offset_y: 0.0,
            focused_function: 0,
            file_scope: FileScope::ChangedHead,
            filtered_paths: Vec::new(),
            head_changed: Vec::new(),
            branch_changed: Vec::new(),
            pending_diff: None,
            current_diff: None,
            pending_head_files: None,
            pending_branch_files: None,
            pending_head_review_order: None,
            pending_branch_review_order: None,
            head_review_order: ReviewOrderCache::default(),
            branch_review_order: ReviewOrderCache::default(),
            is_git_repo: None,
            needs_initial_navigation: true,
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

    fn fetch_function_code(&mut self, function: FunctionRef, ctx: &egui::Context) {
        let shared: SharedAsync<FunctionCodeResponse> = shared_loading();
        self.pending_quick_view = Some(Arc::clone(&shared));
        self.quick_view = QuickViewState::Loading(function.clone());

        let url = format!(
            "/api/function-code?path={}&start_line={}",
            js_encode_uri_component(&function.path),
            function.start_line
        );
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<FunctionCodeResponse>(&response.bytes)
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
                let mut functions = payload.functions;
                if let Some(path) = self.selected_path.as_deref() {
                    let order = self.review_order_for_scope().clone();
                    Self::sort_functions_for_path(&mut functions, path, &order);
                }
                let focus = focus_range(&functions, 0);
                let jobs = code_viewer::prepare(
                    highlights_for_theme(&payload.highlights, ctx.theme()),
                    focus,
                    theme::unfocused_code_for(ctx.theme()),
                );
                self.content = FileContent::Ready {
                    jobs,
                    highlights: payload.highlights,
                    functions,
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

    /// Move quick-view function source data out of the async handle.
    fn poll_pending_quick_view(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_quick_view.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();

        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(response) => {
                let function = FunctionRef {
                    path: response.path,
                    name: response.name,
                    start_line: response.start_line,
                };
                let jobs = code_viewer::prepare(
                    highlights_for_theme(&response.highlights, ctx.theme()),
                    None,
                    theme::unfocused_code_for(ctx.theme()),
                );
                self.quick_view = QuickViewState::Ready {
                    function,
                    end_line: response.end_line,
                    highlights: response.highlights,
                    jobs,
                };
            }
            AsyncData::Error(err) => {
                let function = match &self.quick_view {
                    QuickViewState::Loading(function)
                    | QuickViewState::Ready { function, .. }
                    | QuickViewState::Error { function, .. } => Some(function.clone()),
                    QuickViewState::Closed => None,
                };
                self.quick_view =
                    function.map_or(QuickViewState::Closed, |function| QuickViewState::Error {
                        function,
                        message: err,
                    });
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_quick_view = None;
    }

    fn reprepare_code_for_theme(&mut self, active_theme: egui::Theme) {
        if let FileContent::Ready {
            jobs,
            highlights,
            functions,
        } = &mut self.content
        {
            let focus = focus_range(functions, self.focused_function);
            *jobs = code_viewer::prepare(
                highlights_for_theme(highlights, active_theme),
                focus,
                theme::unfocused_code_for(active_theme),
            );
        }
    }

    fn reprepare_quick_view_for_theme(&mut self, active_theme: egui::Theme) {
        if let QuickViewState::Ready {
            highlights, jobs, ..
        } = &mut self.quick_view
        {
            *jobs = code_viewer::prepare(
                highlights_for_theme(highlights, active_theme),
                None,
                theme::unfocused_code_for(active_theme),
            );
        }
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
                    let first_load = self.known_file_count == 0 && new_count > 0;
                    self.known_file_count = new_count;
                    self.file_tree = FileNode::build_tree(&resp.files);
                    self.flat_paths = collect_paths(&self.file_tree);
                    self.rebuild_filtered_paths();

                    if first_load {
                        self.fetch_review_order_lists(ctx);
                        // Diff file lists are fetched at startup in parallel;
                        // navigate once both file list and git status are ready.
                        self.try_initial_navigation(ctx);
                    }
                }

                if resp.scanning {
                    self.schedule_file_poll(ctx);
                } else {
                    self.scan_complete = true;
                    if self.pending_head_review_order.is_none()
                        && self.pending_branch_review_order.is_none()
                    {
                        self.fetch_review_order_lists(ctx);
                    }
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

    /// Index of the currently selected file in the active path list.
    fn current_index(&self) -> Option<usize> {
        let sel = self.selected_path.as_deref()?;
        self.active_paths().iter().position(|p| p == sel)
    }

    /// Navigate to the file at `index` in the active path list, fetching its content.
    fn navigate_to(&mut self, index: usize, ctx: &egui::Context) {
        if let Some(path) = self.active_paths().get(index).cloned() {
            self.selected_path = Some(path.clone());
            self.focused_function = 0;
            self.scroll_generation += 1;
            self.scroll_offset_y = 0.0;
            self.fetch_file_content(&path, ctx);
            self.fetch_diff(&path, ctx);
        }
    }

    /// Advance to the next function, or the next file if at the last function.
    fn navigate_next(&mut self, ctx: &egui::Context) {
        if self.try_focus_function(self.focused_function + 1, ctx) {
            return;
        }
        let paths_len = self.active_paths().len();
        let next = self
            .current_index()
            .map(|i| (i + 1).min(paths_len.saturating_sub(1)))
            .unwrap_or(0);
        self.navigate_to(next, ctx);
    }

    /// Go back to the previous function, or the previous file (last function) if at the first.
    fn navigate_prev(&mut self, ctx: &egui::Context) {
        if self.focused_function > 0 && self.try_focus_function(self.focused_function - 1, ctx) {
            return;
        }
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
        if let Some(path) = self.active_paths().get(index).cloned() {
            self.selected_path = Some(path.clone());
            self.focused_function = usize::MAX;
            self.scroll_generation += 1;
            self.scroll_offset_y = 0.0;
            self.fetch_file_content(&path, ctx);
            self.fetch_diff(&path, ctx);
        }
    }

    /// Try to focus function at `index` within the current file's function list.
    /// Returns `true` if successful, `false` if out of bounds.
    fn try_focus_function(&mut self, index: usize, ctx: &egui::Context) -> bool {
        let FileContent::Ready {
            jobs,
            highlights,
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
        *jobs = code_viewer::prepare(
            highlights_for_theme(highlights, ctx.theme()),
            focus,
            theme::unfocused_code_for(ctx.theme()),
        );
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
                .map(|f| {
                    let focus = focus_range(functions, fn_index);
                    let display_row = code_viewer::display_row_for_line(
                        f.start_line,
                        self.current_diff.as_ref(),
                        focus.as_ref(),
                    );
                    display_row as f32 * code_viewer::ROW_HEIGHT
                })
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

    fn open_quick_view(&mut self, function: FunctionRef, ctx: &egui::Context) {
        self.close_quick_view();
        self.fetch_function_code(function, ctx);
    }

    fn close_quick_view(&mut self) {
        self.pending_quick_view = None;
        self.quick_view = QuickViewState::Closed;
    }

    /// The file list used for navigation — scoped in zen mode, full otherwise.
    fn active_paths(&self) -> &[String] {
        if self.zen_mode && self.is_git_repo == Some(true) {
            &self.filtered_paths
        } else {
            &self.flat_paths
        }
    }

    /// The diff mode implied by the current file scope.
    fn diff_mode(&self) -> DiffMode {
        match self.file_scope {
            FileScope::ChangedBranch => DiffMode::Branch,
            FileScope::ChangedHead | FileScope::All => DiffMode::Head,
        }
    }

    fn review_order_for_scope(&self) -> &ReviewOrderCache {
        match self.file_scope {
            FileScope::ChangedBranch => &self.branch_review_order,
            FileScope::ChangedHead | FileScope::All => &self.head_review_order,
        }
    }

    fn sort_paths_by_review_order(paths: &mut [String], order: &ReviewOrderCache) {
        paths.sort_by(|a, b| {
            let a_rank = order
                .file_rank
                .get(a.as_str())
                .copied()
                .unwrap_or(usize::MAX);
            let b_rank = order
                .file_rank
                .get(b.as_str())
                .copied()
                .unwrap_or(usize::MAX);
            a_rank.cmp(&b_rank).then(a.cmp(b))
        });
    }

    fn sort_functions_for_path(
        functions: &mut [FunctionInfo],
        path: &str,
        order: &ReviewOrderCache,
    ) {
        let Some(rank) = order.function_rank.get(path) else {
            return;
        };

        functions.sort_by(|a, b| {
            let a_rank = rank.get(&a.start_line).copied().unwrap_or(usize::MAX);
            let b_rank = rank.get(&b.start_line).copied().unwrap_or(usize::MAX);
            a_rank.cmp(&b_rank).then(a.start_line.cmp(&b.start_line))
        });
    }

    fn apply_review_order_to_current_functions(&mut self, ctx: &egui::Context) {
        let Some(selected_path) = self.selected_path.clone() else {
            return;
        };

        let focused_start = match &self.content {
            FileContent::Ready { functions, .. } => functions
                .get(self.focused_function)
                .map(|function| function.start_line),
            _ => None,
        };

        let order = self.review_order_for_scope().clone();
        if let FileContent::Ready {
            jobs,
            highlights,
            functions,
        } = &mut self.content
        {
            Self::sort_functions_for_path(functions, &selected_path, &order);

            if functions.is_empty() {
                self.focused_function = 0;
            } else {
                self.focused_function = focused_start
                    .and_then(|start| {
                        functions
                            .iter()
                            .position(|function| function.start_line == start)
                    })
                    .unwrap_or(0)
                    .min(functions.len().saturating_sub(1));
            }

            let focus = focus_range(functions, self.focused_function);
            *jobs = code_viewer::prepare(
                highlights_for_theme(highlights, ctx.theme()),
                focus,
                theme::unfocused_code_for(ctx.theme()),
            );
            self.apply_function_scroll(self.focused_function);
            self.refresh_focused_relations(ctx);
        }
    }

    /// Rebuild `filtered_paths` from the current scope and changed-file lists.
    fn rebuild_filtered_paths(&mut self) {
        let order = self.review_order_for_scope().clone();
        let changed = match self.file_scope {
            FileScope::ChangedHead => &self.head_changed,
            FileScope::ChangedBranch => &self.branch_changed,
            FileScope::All => {
                let mut paths = self.flat_paths.clone();
                Self::sort_paths_by_review_order(&mut paths, &order);
                self.filtered_paths = paths;
                return;
            }
        };

        let changed_set: HashSet<&str> = changed.iter().map(String::as_str).collect();
        let mut filtered_paths: Vec<String> = self
            .flat_paths
            .iter()
            .filter(|path| changed_set.contains(path.as_str()))
            .cloned()
            .collect();
        Self::sort_paths_by_review_order(&mut filtered_paths, &order);
        self.filtered_paths = filtered_paths;
    }

    /// Navigate to the first filtered file once both the file list and git
    /// status are known. Called from both `poll_file_list` and the diff-file
    /// pollers so whichever resolves last triggers the navigation.
    fn try_initial_navigation(&mut self, ctx: &egui::Context) {
        if !self.needs_initial_navigation {
            return;
        }
        // Need files loaded AND git status determined.
        if self.known_file_count == 0 || self.is_git_repo.is_none() {
            return;
        }
        self.needs_initial_navigation = false;
        self.navigate_to(0, ctx);
    }

    /// Kick off fetches for the HEAD- and branch-changed file lists.
    pub fn fetch_diff_file_lists(&mut self, ctx: &egui::Context) {
        // HEAD changed files
        {
            let shared: SharedAsync<DiffFilesResponse> = shared_loading();
            self.pending_head_files = Some(Arc::clone(&shared));
            let ctx = ctx.clone();
            ehttp::fetch(
                ehttp::Request::get("/api/diff/files?mode=head"),
                move |result| {
                    let value = match result {
                        Ok(response) => {
                            serde_json::from_slice::<DiffFilesResponse>(&response.bytes)
                                .map(AsyncData::Loaded)
                                .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}")))
                        }
                        Err(err) => AsyncData::Error(err),
                    };
                    *shared.lock().unwrap() = value;
                    ctx.request_repaint();
                },
            );
        }

        // Branch changed files
        {
            let shared: SharedAsync<DiffFilesResponse> = shared_loading();
            self.pending_branch_files = Some(Arc::clone(&shared));
            let ctx = ctx.clone();
            ehttp::fetch(
                ehttp::Request::get("/api/diff/files?mode=branch"),
                move |result| {
                    let value = match result {
                        Ok(response) => {
                            serde_json::from_slice::<DiffFilesResponse>(&response.bytes)
                                .map(AsyncData::Loaded)
                                .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}")))
                        }
                        Err(err) => AsyncData::Error(err),
                    };
                    *shared.lock().unwrap() = value;
                    ctx.request_repaint();
                },
            );
        }
    }

    /// Kick off fetches for the HEAD- and branch-priority orderings.
    pub fn fetch_review_order_lists(&mut self, ctx: &egui::Context) {
        self.fetch_review_order(DiffMode::Head, ctx);
        self.fetch_review_order(DiffMode::Branch, ctx);
    }

    fn fetch_review_order(&mut self, mode: DiffMode, ctx: &egui::Context) {
        let shared: SharedAsync<ReviewOrderResponse> = shared_loading();
        match mode {
            DiffMode::Head => self.pending_head_review_order = Some(Arc::clone(&shared)),
            DiffMode::Branch => self.pending_branch_review_order = Some(Arc::clone(&shared)),
        }

        let mode_param = match mode {
            DiffMode::Head => "head",
            DiffMode::Branch => "branch",
        };
        let url = format!("/api/review-order?mode={mode_param}");
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<ReviewOrderResponse>(&response.bytes)
                    .map(AsyncData::Loaded)
                    .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}"))),
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    /// Fetch diff data for the given file path and current diff mode.
    fn fetch_diff(&mut self, path: &str, ctx: &egui::Context) {
        if self.is_git_repo != Some(true) {
            return;
        }
        let shared: SharedAsync<DiffResponse> = shared_loading();
        self.pending_diff = Some(Arc::clone(&shared));
        self.current_diff = None;

        let mode = match self.diff_mode() {
            DiffMode::Head => "head",
            DiffMode::Branch => "branch",
        };
        let url = format!(
            "/api/diff?path={}&mode={mode}",
            js_encode_uri_component(path)
        );
        let ctx = ctx.clone();

        ehttp::fetch(ehttp::Request::get(&url), move |result| {
            let value = match result {
                Ok(response) => serde_json::from_slice::<DiffResponse>(&response.bytes)
                    .map(AsyncData::Loaded)
                    .unwrap_or_else(|e| AsyncData::Error(format!("Parse error: {e}"))),
                Err(err) => AsyncData::Error(err),
            };
            *shared.lock().unwrap() = value;
            ctx.request_repaint();
        });
    }

    /// Poll the in-flight diff fetch and resolve it into `current_diff`.
    fn poll_pending_diff(&mut self) {
        let Some(pending) = self.pending_diff.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();
        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(resp) => {
                self.current_diff = Some(DiffData {
                    line_statuses: resp.line_statuses,
                    deleted_sections: resp.deleted_sections,
                });
            }
            AsyncData::Error(_) => {
                self.current_diff = None;
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_diff = None;
    }

    /// Poll the HEAD changed-files fetch.
    fn poll_pending_head_files(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_head_files.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();
        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(resp) => {
                self.head_changed = resp.changed_files;
                self.is_git_repo = Some(true);
                self.rebuild_filtered_paths();
            }
            AsyncData::Error(_) => {
                // Not a git repo or git not available — disable diff features
                if self.is_git_repo.is_none() {
                    self.is_git_repo = Some(false);
                    self.file_scope = FileScope::All;
                    self.rebuild_filtered_paths();
                }
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_head_files = None;
        self.try_initial_navigation(ctx);
    }

    /// Poll the branch changed-files fetch.
    fn poll_pending_branch_files(&mut self) {
        let Some(pending) = self.pending_branch_files.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();
        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(resp) => {
                self.branch_changed = resp.changed_files;
                self.rebuild_filtered_paths();
            }
            AsyncData::Error(_) => {
                // Branch detection failed — that's OK, head mode still works
            }
            AsyncData::Loading => unreachable!(),
        }
        self.pending_branch_files = None;
    }

    /// Poll the HEAD review-order fetch.
    fn poll_pending_head_review_order(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_head_review_order.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();
        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(resp) => {
                self.head_review_order = ReviewOrderCache::from_response(resp);
                self.rebuild_filtered_paths();
                if self.file_scope != FileScope::ChangedBranch {
                    self.apply_review_order_to_current_functions(ctx);
                }
            }
            AsyncData::Error(_) => {}
            AsyncData::Loading => unreachable!(),
        }
        self.pending_head_review_order = None;
    }

    /// Poll the branch review-order fetch.
    fn poll_pending_branch_review_order(&mut self, ctx: &egui::Context) {
        let Some(pending) = self.pending_branch_review_order.clone() else {
            return;
        };
        let mut guard = pending.lock().unwrap();
        if matches!(*guard, AsyncData::Loading) {
            return;
        }

        match std::mem::replace(&mut *guard, AsyncData::Loading) {
            AsyncData::Loaded(resp) => {
                self.branch_review_order = ReviewOrderCache::from_response(resp);
                self.rebuild_filtered_paths();
                if self.file_scope == FileScope::ChangedBranch {
                    self.apply_review_order_to_current_functions(ctx);
                }
            }
            AsyncData::Error(_) => {}
            AsyncData::Loading => unreachable!(),
        }
        self.pending_branch_review_order = None;
    }

    fn render_quick_view_window(&mut self, ctx: &egui::Context) {
        if ctx.input(|i| i.key_pressed(Key::Escape)) {
            self.close_quick_view();
            return;
        }

        if matches!(self.quick_view, QuickViewState::Closed) {
            return;
        }

        let (title, subtitle) = match &self.quick_view {
            QuickViewState::Loading(function) => (
                format!("Quick Reference: {}", function.name),
                format!("{}:{}", function.path, function.start_line + 1),
            ),
            QuickViewState::Ready {
                function, end_line, ..
            } => (
                format!("Quick Reference: {}", function.name),
                format!(
                    "{}:{}-{}",
                    function.path,
                    function.start_line + 1,
                    *end_line
                ),
            ),
            QuickViewState::Error { function, .. } => (
                format!("Quick Reference: {}", function.name),
                format!("{}:{}", function.path, function.start_line + 1),
            ),
            QuickViewState::Closed => return,
        };

        let mut is_open = true;
        let mut close_requested = false;

        egui::Window::new(title)
            .id(egui::Id::new("quick-reference-window"))
            .open(&mut is_open)
            .resizable(true)
            .collapsible(false)
            .default_width(760.0)
            .default_height(520.0)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(subtitle.as_str())
                            .size(11.0)
                            .monospace()
                            .color(theme::text_muted(ui)),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .button(RichText::new("Close (Esc)").size(11.0))
                            .on_hover_text("Dismiss this quick reference popup")
                            .clicked()
                        {
                            close_requested = true;
                        }
                    });
                });
                ui.separator();
                ui.add_space(4.0);

                match &self.quick_view {
                    QuickViewState::Loading(_) => {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label(
                                RichText::new("Loading function source...")
                                    .size(12.0)
                                    .color(theme::text_muted(ui)),
                            );
                        });
                    }
                    QuickViewState::Ready { jobs, .. } => {
                        egui::Frame {
                            fill: theme::entry_fill(ui, 0),
                            stroke: egui::Stroke::new(1.0, theme::entry_stroke(ui, false)),
                            corner_radius: egui::CornerRadius::same(6),
                            inner_margin: egui::Margin::same(8),
                            ..Default::default()
                        }
                        .show(ui, |ui| {
                            ui.style_mut().wrap_mode = Some(egui::TextWrapMode::Extend);
                            ui.spacing_mut().item_spacing.y = 0.0;
                            egui::ScrollArea::both()
                                .id_salt("quick-view-code")
                                .auto_shrink([false, false])
                                .show_rows(
                                    ui,
                                    code_viewer::ROW_HEIGHT,
                                    jobs.len(),
                                    |ui, visible_range| {
                                        visible_range.for_each(|i| {
                                            ui.label(jobs[i].clone());
                                        });
                                    },
                                );
                        });
                    }
                    QuickViewState::Error { message, .. } => {
                        ui.colored_label(
                            egui::Color32::RED,
                            format!("Could not load function code: {message}"),
                        );
                    }
                    QuickViewState::Closed => {}
                }
            });

        if !is_open || close_requested {
            self.close_quick_view();
        }
    }

    fn render_relations_panel(&mut self, ui: &mut egui::Ui) {
        ui.add_space(8.0);
        ui.label(
            RichText::new("Call Graph")
                .strong()
                .size(14.0)
                .color(theme::text_primary(ui)),
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
                    .color(theme::text_muted(ui)),
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
                        .color(theme::text_muted(ui)),
                );
            });
            return;
        }

        let panel_ctx = ui.ctx().clone();
        match &self.relations {
            FunctionRelationsState::Ready(relations) => {
                let callee_tree = relations.callee_tree.clone();
                let caller_tree = relations.caller_tree.clone();
                let test_callers = relations.test_callers.clone();
                self.render_tree_section(
                    ui,
                    "Callees",
                    &callee_tree,
                    "No direct callees",
                    "callee",
                    "Expand nodes to walk down the call stack",
                );
                ui.add_space(8.0);
                self.render_tree_section(
                    ui,
                    "Callers",
                    &caller_tree,
                    "No callers",
                    "caller",
                    "Expand nodes to walk up the call stack",
                );
                ui.add_space(8.0);
                self.render_test_section(ui, &test_callers, &panel_ctx);
            }
            FunctionRelationsState::Error(err) => {
                ui.colored_label(egui::Color32::RED, format!("Call graph error: {err}"));
            }
            FunctionRelationsState::Empty => {
                ui.label(
                    RichText::new("No relationship data yet")
                        .size(12.0)
                        .color(theme::text_muted(ui)),
                );
            }
        }
    }

    fn render_function_title(&self, ui: &mut egui::Ui, function: &FunctionRef) {
        egui::Frame {
            fill: theme::focus_fill(ui),
            stroke: egui::Stroke::new(1.0, theme::focus_stroke(ui)),
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
                        .color(theme::text_muted(ui)),
                );
                ui.label(
                    RichText::new(function.name.as_str())
                        .size(13.0)
                        .strong()
                        .color(theme::text_primary(ui)),
                );
            });
            ui.label(
                RichText::new(format!("{}:{}", function.path, function.start_line + 1))
                    .size(10.5)
                    .monospace()
                    .color(theme::text_muted(ui)),
            );
        });
    }

    fn render_function_entry(
        &mut self,
        ui: &mut egui::Ui,
        function: &FunctionRef,
        depth: usize,
        cycle: bool,
        is_test: bool,
        ctx: &egui::Context,
    ) {
        let fill = theme::entry_fill(ui, depth);
        let border = theme::entry_stroke(ui, cycle);
        let mut open_quick_view = false;

        egui::Frame {
            fill,
            stroke: egui::Stroke::new(1.0, border),
            corner_radius: egui::CornerRadius::same(6),
            inner_margin: egui::Margin::symmetric(8, 5),
            ..Default::default()
        }
        .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                let name_response = ui
                    .add(
                        egui::Label::new(
                            RichText::new(function.name.as_str())
                                .size(12.0)
                                .strong()
                                .color(theme::text_primary(ui)),
                        )
                        .sense(egui::Sense::click()),
                    )
                    .on_hover_cursor(egui::CursorIcon::PointingHand);
                open_quick_view |= name_response.clicked();

                if is_test {
                    ui.label(
                        RichText::new("TEST")
                            .size(9.5)
                            .monospace()
                            .background_color(theme::test_badge_bg(ui))
                            .color(theme::test_badge_fg(ui)),
                    );
                }

                if cycle {
                    ui.label(
                        RichText::new("CYCLE")
                            .size(9.5)
                            .monospace()
                            .background_color(theme::cycle_badge_bg(ui))
                            .color(theme::accent(ui)),
                    );
                }
            });

            let path_response = ui
                .add(
                    egui::Label::new(
                        RichText::new(format!("{}:{}", function.path, function.start_line + 1))
                            .size(10.5)
                            .monospace()
                            .color(theme::text_muted(ui)),
                    )
                    .sense(egui::Sense::click()),
                )
                .on_hover_cursor(egui::CursorIcon::PointingHand);
            open_quick_view |= path_response.clicked();
        });

        if open_quick_view {
            self.open_quick_view(function.clone(), ctx);
        }
    }

    fn render_tree_section(
        &mut self,
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
                .color(theme::text_primary(ui)),
        )
        .id_salt(("call-tree-section", id_prefix))
        .default_open(false)
        .show(ui, |ui| {
            if items.is_empty() {
                ui.label(
                    RichText::new(empty_msg)
                        .size(11.0)
                        .color(theme::text_muted(ui)),
                );
                return;
            }

            ui.label(RichText::new(hint).size(10.5).color(theme::text_muted(ui)));
            ui.add_space(4.0);
            let ctx = ui.ctx().clone();
            self.render_tree_nodes(ui, items, id_prefix, 0, ctx);
        });
    }

    fn render_test_section(
        &mut self,
        ui: &mut egui::Ui,
        items: &[FunctionRef],
        ctx: &egui::Context,
    ) {
        egui::CollapsingHeader::new(
            RichText::new(format!("Tests ({})", items.len()))
                .size(12.0)
                .strong()
                .color(theme::text_primary(ui)),
        )
        .id_salt("call-tree-tests")
        .default_open(false)
        .show(ui, |ui| {
            if items.is_empty() {
                ui.label(
                    RichText::new("No tests exercise this function")
                        .size(11.0)
                        .color(theme::text_muted(ui)),
                );
                return;
            }

            ui.label(
                RichText::new("Includes direct and indirect test callers")
                    .size(10.5)
                    .color(theme::text_muted(ui)),
            );
            ui.add_space(4.0);
            items.iter().for_each(|item| {
                self.render_function_entry(ui, item, 0, false, true, ctx);
                ui.add_space(3.0);
            });
        });
    }

    fn render_tree_nodes(
        &mut self,
        ui: &mut egui::Ui,
        items: &[CallTreeNode],
        id_prefix: &str,
        depth: usize,
        ctx: egui::Context,
    ) {
        items.iter().enumerate().for_each(|(index, item)| {
            let id = format!(
                "{id_prefix}:{depth}:{index}:{}:{}",
                item.function.path, item.function.start_line
            );
            self.render_tree_node(ui, item, id.as_str(), depth + 1, &ctx);
            if index + 1 < items.len() {
                ui.add_space(3.0);
            }
        });
    }

    fn render_tree_node(
        &mut self,
        ui: &mut egui::Ui,
        item: &CallTreeNode,
        node_id: &str,
        depth: usize,
        ctx: &egui::Context,
    ) {
        if item.children.is_empty() {
            let indent = (depth.saturating_sub(1) as f32 * 12.0).min(72.0);
            ui.horizontal(|ui| {
                ui.add_space(indent);
                self.render_function_entry(ui, &item.function, depth, item.cycle, false, ctx);
            });

            if item.truncated {
                ui.label(
                    RichText::new("... more nodes omitted")
                        .size(10.0)
                        .monospace()
                        .color(theme::text_muted(ui)),
                );
            }
            return;
        }

        let id = ui.make_persistent_id(("call-tree-node", node_id));
        let _ =
            egui::collapsing_header::CollapsingState::load_with_default_open(ui.ctx(), id, false)
                .show_header(ui, |ui| {
                    self.render_function_entry(ui, &item.function, depth, item.cycle, false, ctx);
                })
                .body(|ui| {
                    self.render_tree_nodes(ui, &item.children, node_id, depth, ctx.clone());
                    if item.truncated {
                        ui.label(
                            RichText::new("... more nodes omitted")
                                .size(10.0)
                                .monospace()
                                .color(theme::text_muted(ui)),
                        );
                    }
                });
    }
}

/// Compute the focus range for a given function index, or `None` if no functions.
fn focus_range(functions: &[FunctionInfo], index: usize) -> Option<std::ops::Range<usize>> {
    functions.get(index).map(|f| f.start_line..f.end_line)
}

fn highlights_for_theme(highlights: &ThemedHighlights, theme: egui::Theme) -> &HighlightedLines {
    match theme {
        egui::Theme::Dark => &highlights.dark,
        egui::Theme::Light => &highlights.light,
    }
}

impl eframe::App for CodeReviewApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut Frame) {
        let t0 = self.frame_stats.begin();

        if !self.theme_applied {
            theme::apply(ctx);
            self.theme_applied = true;
            self.last_theme = Some(ctx.theme());
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
        self.poll_pending_quick_view(ctx);
        self.poll_pending_diff();
        self.poll_pending_head_files(ctx);
        self.poll_pending_branch_files();
        self.poll_pending_head_review_order(ctx);
        self.poll_pending_branch_review_order(ctx);

        // When navigating backwards, clamp focused_function to the last function.
        if self.focused_function == usize::MAX
            && let FileContent::Ready {
                jobs,
                highlights,
                functions,
            } = &mut self.content
        {
            let last = functions.len().saturating_sub(1);
            self.focused_function = last;
            let focus = focus_range(functions, last);
            *jobs = code_viewer::prepare(
                highlights_for_theme(highlights, ctx.theme()),
                focus.clone(),
                theme::unfocused_code_for(ctx.theme()),
            );
            self.scroll_offset_y = functions
                .get(last)
                .map(|f| {
                    let row = code_viewer::display_row_for_line(
                        f.start_line,
                        self.current_diff.as_ref(),
                        focus.as_ref(),
                    );
                    row as f32 * code_viewer::ROW_HEIGHT
                })
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

        let file_count = self.active_paths().len();
        let total_file_count = self.flat_paths.len();
        let current_pos = self.current_index();
        let func_name = self.focused_function_name().map(String::from);
        let func_count = self.function_count();
        let focused_fn = self.focused_function;
        let diff_focus = match &self.content {
            FileContent::Ready { functions, .. } => focus_range(functions, self.focused_function),
            _ => None,
        };
        let is_git = self.is_git_repo == Some(true);
        let head_count = self.head_changed.len();
        let branch_count = self.branch_changed.len();

        // Top bar
        TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("Code Review")
                        .strong()
                        .size(16.0)
                        .color(theme::text_primary(ui)),
                );
                ui.separator();
                let count_label = current_pos.map_or_else(
                    || format!("{file_count} files"),
                    |i| format!("{} / {file_count}", i + 1),
                );
                ui.label(
                    RichText::new(count_label)
                        .color(theme::text_muted(ui))
                        .size(12.0),
                );

                // Show focused function name and counter
                if let Some(ref name) = func_name {
                    ui.separator();
                    ui.label(
                        RichText::new(format!("{name}  ({} / {func_count})", focused_fn + 1))
                            .color(theme::accent(ui))
                            .size(12.0)
                            .strong(),
                    );
                }

                if !self.scan_complete {
                    ui.spinner();
                }

                // Right-align the zen mode toggle and scope selector
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.checkbox(
                        &mut self.zen_mode,
                        RichText::new("Zen Mode")
                            .size(12.0)
                            .color(theme::text_muted(ui)),
                    );

                    // Scope selector (only in zen mode, only in git repos)
                    if self.zen_mode && is_git {
                        ui.separator();
                        let mut scope = self.file_scope;
                        ui.selectable_value(
                            &mut scope,
                            FileScope::All,
                            RichText::new(format!("All [{total_file_count}]")).size(11.0),
                        );
                        ui.selectable_value(
                            &mut scope,
                            FileScope::ChangedBranch,
                            RichText::new(format!("Branch [{branch_count}]")).size(11.0),
                        );
                        ui.selectable_value(
                            &mut scope,
                            FileScope::ChangedHead,
                            RichText::new(format!("HEAD [{head_count}]")).size(11.0),
                        );
                        if scope != self.file_scope {
                            self.file_scope = scope;
                            self.rebuild_filtered_paths();
                            self.apply_review_order_to_current_functions(ctx);
                            // Re-fetch diff for current file with the new mode
                            if let Some(path) = self.selected_path.clone() {
                                self.fetch_diff(&path, ctx);
                            }
                        }
                        ui.separator();
                    }

                    let mut theme_preference = ui.ctx().options(|opt| opt.theme_preference);
                    ui.label(
                        RichText::new("Theme")
                            .size(12.0)
                            .color(theme::text_muted(ui)),
                    );
                    ui.selectable_value(
                        &mut theme_preference,
                        egui::ThemePreference::System,
                        "System",
                    );
                    ui.selectable_value(&mut theme_preference, egui::ThemePreference::Dark, "Dark");
                    ui.selectable_value(
                        &mut theme_preference,
                        egui::ThemePreference::Light,
                        "Light",
                    );
                    if theme_preference != ui.ctx().options(|opt| opt.theme_preference) {
                        ui.ctx().set_theme(theme_preference);
                    }
                });
            });
            ui.add_space(4.0);
        });

        let active_theme = ctx.theme();
        if self.last_theme != Some(active_theme) {
            self.reprepare_code_for_theme(active_theme);
            self.reprepare_quick_view_for_theme(active_theme);
            self.last_theme = Some(active_theme);
        }

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
                            .color(theme::text_primary(ui)),
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
                            self.fetch_diff(&path, ctx);
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
                            .color(theme::text_muted(ui)),
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
                    self.current_diff
                        .as_ref()
                        .map(|data| code_viewer::DiffOverlay {
                            data,
                            focus: diff_focus.clone(),
                        }),
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

        self.render_quick_view_window(ctx);

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
