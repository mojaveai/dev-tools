use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use tower_http::compression::CompressionLayer;

use crate::callgraph::{CallGraphStore, FunctionRelations};
use crate::files;
use crate::functions::{self, FunctionInfo};
use crate::git::{self, DeletedSection, DiffMode, GitDiffStore};
use crate::highlighting::{Highlighter, ThemedHighlights};

// Embed build artifacts at compile time
const INDEX_HTML: &[u8] = include_bytes!("../assets/index.html");
const WASM_JS: &[u8] = include_bytes!(env!("WASM_JS_PATH"));
const WASM_BG: &[u8] = include_bytes!(env!("WASM_BG_PATH"));

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub root: PathBuf,
    pub file_paths: Arc<RwLock<Vec<String>>>,
    pub scan_complete: Arc<AtomicBool>,
    pub highlighter: Arc<Highlighter>,
    pub call_graph: Arc<CallGraphStore>,
    pub git_diff: Arc<GitDiffStore>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/code_review_ui.js", get(serve_js))
        .route("/code_review_ui_bg.wasm", get(serve_wasm))
        .route("/api/files", get(api_files))
        .route("/api/file", get(api_file))
        .route("/api/function-code", get(api_function_code))
        .route("/api/function-relations", get(api_function_relations))
        .route("/api/review-order", get(api_review_order))
        .route("/api/diff/files", get(api_diff_files))
        .route("/api/diff", get(api_diff))
        .route("/api/diff/refresh", get(api_diff_refresh))
        .layer(CompressionLayer::new())
        .with_state(state)
}

async fn serve_index() -> Response {
    (
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))],
        INDEX_HTML,
    )
        .into_response()
}

async fn serve_js() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/javascript"),
        )],
        WASM_JS,
    )
        .into_response()
}

async fn serve_wasm() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/wasm"),
        )],
        WASM_BG,
    )
        .into_response()
}

#[derive(serde::Serialize)]
struct FilesResponse {
    files: Vec<String>,
    scanning: bool,
}

async fn api_files(State(state): State<AppState>) -> impl IntoResponse {
    let files = state.file_paths.read().unwrap().clone();
    let scanning = !state.scan_complete.load(Ordering::Acquire);
    axum::Json(FilesResponse { files, scanning })
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(serde::Serialize)]
struct FileResponse {
    path: String,
    content: String,
    highlights: ThemedHighlights,
    functions: Vec<FunctionInfo>,
}

async fn api_file(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let resolved = files::safe_resolve(&state.root, &query.path)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Invalid path".to_owned()))?;

    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Cannot read file: {e}")))?;

    let highlighter = Arc::clone(&state.highlighter);
    let path_for_hl = query.path.clone();
    let content_for_hl = content.clone();

    let content_for_fn = content.clone();
    let highlights =
        tokio::task::spawn_blocking(move || highlighter.highlight(&content_for_hl, &path_for_hl))
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Highlight failed: {e}"),
                )
            })?;

    let functions =
        tokio::task::spawn_blocking(move || functions::extract_python_functions(&content_for_fn))
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Function parse failed: {e}"),
                )
            })?;

    Ok(axum::Json(FileResponse {
        path: query.path,
        content,
        highlights,
        functions,
    }))
}

#[derive(Deserialize)]
struct FunctionRelationsQuery {
    path: String,
    start_line: usize,
}

#[derive(Deserialize)]
struct FunctionCodeQuery {
    path: String,
    start_line: usize,
}

#[derive(serde::Serialize)]
struct FunctionCodeResponse {
    path: String,
    name: String,
    start_line: usize,
    end_line: usize,
    highlights: ThemedHighlights,
}

async fn api_function_code(
    State(state): State<AppState>,
    Query(query): Query<FunctionCodeQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let resolved = files::safe_resolve(&state.root, &query.path)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Invalid path".to_owned()))?;

    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Cannot read file: {e}")))?;

    let content_for_fn = content.clone();
    let functions =
        tokio::task::spawn_blocking(move || functions::extract_python_functions(&content_for_fn))
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Function parse failed: {e}"),
                )
            })?;

    let Some(function) = functions
        .into_iter()
        .find(|f| f.start_line == query.start_line)
    else {
        return Err((StatusCode::NOT_FOUND, "Function not found".to_owned()));
    };

    let code = slice_lines(&content, function.start_line, function.end_line).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "Function range is invalid".to_owned(),
        )
    })?;

    let highlighter = Arc::clone(&state.highlighter);
    let path_for_hl = query.path.clone();
    let code_for_hl = code.clone();
    let highlights =
        tokio::task::spawn_blocking(move || highlighter.highlight(&code_for_hl, &path_for_hl))
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Highlight failed: {e}"),
                )
            })?;

    Ok(axum::Json(FunctionCodeResponse {
        path: query.path,
        name: function.name,
        start_line: function.start_line,
        end_line: function.end_line,
        highlights,
    }))
}

async fn api_function_relations(
    State(state): State<AppState>,
    Query(query): Query<FunctionRelationsQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    files::safe_resolve(&state.root, &query.path)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Invalid path".to_owned()))?;

    let files = state.file_paths.read().unwrap().clone();

    let relations: FunctionRelations = state
        .call_graph
        .relationships_for(&state.root, &files, &query.path, query.start_line)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Call graph analysis failed: {e}"),
            )
        })?;

    Ok(axum::Json(relations))
}

#[derive(Deserialize)]
struct ReviewOrderQuery {
    mode: Option<DiffMode>,
}

#[derive(serde::Serialize)]
struct ReviewOrderResponse {
    mode: DiffMode,
    files: Vec<ReviewOrderFile>,
}

#[derive(serde::Serialize)]
struct ReviewOrderFile {
    path: String,
    score: f32,
    changed_lines: usize,
    functions: Vec<ReviewOrderFunction>,
}

#[derive(serde::Serialize)]
struct ReviewOrderFunction {
    name: String,
    start_line: usize,
    end_line: usize,
    score: f32,
    changed_lines: usize,
}

async fn api_review_order(
    State(state): State<AppState>,
    Query(query): Query<ReviewOrderQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let mode = query.mode.unwrap_or(DiffMode::Head);
    let files = state.file_paths.read().unwrap().clone();
    let file_set: HashSet<&str> = files.iter().map(String::as_str).collect();

    let graph_metrics = state
        .call_graph
        .graph_metrics_for_review(&state.root, &files)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Call graph analysis failed: {e}"),
            )
        })?;

    let changed_files = state
        .git_diff
        .changed_files(&state.root, mode)
        .await
        .unwrap_or_default();

    let mut changed_statuses: HashMap<String, Vec<git::LineStatus>> = HashMap::new();

    for path in changed_files {
        if !file_set.contains(path.as_str()) {
            continue;
        }

        let Some(resolved) = files::safe_resolve(&state.root, &path) else {
            continue;
        };

        let total_lines = tokio::fs::read_to_string(&resolved)
            .await
            .map(|content| content.lines().count())
            .unwrap_or(0);

        if let Ok(diff) = state
            .git_diff
            .file_diff(&state.root, &path, mode, total_lines)
            .await
        {
            changed_statuses.insert(path, diff.line_statuses);
        }
    }

    let mut function_map: HashMap<String, Vec<ReviewOrderFunction>> = HashMap::new();

    graph_metrics.into_iter().for_each(|metric| {
        let function_lines = metric.end_line.saturating_sub(metric.start_line).max(1);
        let changed_lines = changed_statuses
            .get(metric.path.as_str())
            .map(|statuses| count_changed_in_range(statuses, metric.start_line, metric.end_line))
            .unwrap_or(0);

        let size_score = log_normalize(function_lines as f32, 120.0);
        let change_density = changed_lines as f32 / function_lines as f32;
        let change_score =
            0.72 * change_density.min(1.0) + 0.28 * log_normalize(changed_lines as f32, 40.0);
        let fanout_score = log_normalize(metric.callee_count as f32, 16.0);
        let fanin_score = log_normalize(metric.caller_count as f32, 16.0);
        let connectivity = 0.65 * fanin_score + 0.35 * fanout_score;

        let mut score = 0.57 * metric.graph_score
            + 0.21 * change_score
            + 0.12 * connectivity
            + 0.10 * size_score;
        if metric.is_test {
            score *= 0.35;
        }

        function_map
            .entry(metric.path)
            .or_default()
            .push(ReviewOrderFunction {
                name: metric.name,
                start_line: metric.start_line,
                end_line: metric.end_line,
                score,
                changed_lines,
            });
    });

    let mut ranked_files: Vec<ReviewOrderFile> = files
        .iter()
        .map(|path| {
            let mut functions = function_map.remove(path).unwrap_or_default();
            functions.sort_by(|a, b| {
                b.score
                    .total_cmp(&a.score)
                    .then(a.start_line.cmp(&b.start_line))
                    .then(a.name.cmp(&b.name))
            });

            let file_changed_lines = changed_statuses
                .get(path.as_str())
                .map(|statuses| count_changed(statuses))
                .unwrap_or(0);

            let top_count = functions.len().min(3);
            let top_avg = if top_count == 0 {
                0.0
            } else {
                functions
                    .iter()
                    .take(top_count)
                    .map(|function| function.score)
                    .sum::<f32>()
                    / top_count as f32
            };
            let changed_fn_ratio = if functions.is_empty() {
                0.0
            } else {
                functions
                    .iter()
                    .filter(|function| function.changed_lines > 0)
                    .count() as f32
                    / functions.len() as f32
            };
            let file_change_score = log_normalize(file_changed_lines as f32, 220.0);
            let score = if functions.is_empty() {
                file_change_score * 0.75
            } else {
                (0.66 * top_avg) + (0.20 * file_change_score) + (0.14 * changed_fn_ratio)
            };

            ReviewOrderFile {
                path: path.clone(),
                score,
                changed_lines: file_changed_lines,
                functions,
            }
        })
        .collect();

    ranked_files.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.path.cmp(&b.path)));

    Ok(axum::Json(ReviewOrderResponse {
        mode,
        files: ranked_files,
    }))
}

// ── Diff endpoints ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct DiffFilesQuery {
    mode: DiffMode,
}

#[derive(serde::Serialize)]
struct DiffFilesResponse {
    mode: DiffMode,
    changed_files: Vec<String>,
}

async fn api_diff_files(
    State(state): State<AppState>,
    Query(query): Query<DiffFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let files = state
        .git_diff
        .changed_files(&state.root, query.mode)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(axum::Json(DiffFilesResponse {
        mode: query.mode,
        changed_files: files,
    }))
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
    mode: DiffMode,
}

#[derive(serde::Serialize)]
struct DiffResponse {
    path: String,
    mode: DiffMode,
    line_statuses: Vec<git::LineStatus>,
    deleted_before: Vec<usize>,
    deleted_sections: Vec<DeletedSection>,
}

async fn api_diff(
    State(state): State<AppState>,
    Query(query): Query<DiffQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let resolved = files::safe_resolve(&state.root, &query.path)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Invalid path".to_owned()))?;

    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Cannot read file: {e}")))?;

    let total_lines = content.lines().count();

    let diff = state
        .git_diff
        .file_diff(&state.root, &query.path, query.mode, total_lines)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(axum::Json(DiffResponse {
        path: query.path,
        mode: query.mode,
        line_statuses: diff.line_statuses,
        deleted_before: diff.deleted_before,
        deleted_sections: diff.deleted_sections,
    }))
}

async fn api_diff_refresh(State(state): State<AppState>) -> impl IntoResponse {
    state.git_diff.invalidate().await;
    StatusCode::OK
}

fn count_changed(line_statuses: &[git::LineStatus]) -> usize {
    line_statuses
        .iter()
        .filter(|&&status| matches!(status, git::LineStatus::Added | git::LineStatus::Modified))
        .count()
}

fn count_changed_in_range(
    line_statuses: &[git::LineStatus],
    start_line: usize,
    end_line: usize,
) -> usize {
    let clamped_end = end_line.min(line_statuses.len());
    if start_line >= clamped_end {
        return 0;
    }

    line_statuses[start_line..clamped_end]
        .iter()
        .filter(|&&status| matches!(status, git::LineStatus::Added | git::LineStatus::Modified))
        .count()
}

fn log_normalize(value: f32, pivot: f32) -> f32 {
    if value <= 0.0 {
        return 0.0;
    }

    ((value + 1.0).ln() / (pivot + 1.0).ln()).min(1.0)
}

fn slice_lines(content: &str, start_line: usize, end_line: usize) -> Option<String> {
    if start_line >= end_line {
        return None;
    }

    let lines: Vec<&str> = content.lines().collect();
    if start_line >= lines.len() {
        return None;
    }

    let clamped_end = end_line.min(lines.len());
    Some(lines[start_line..clamped_end].join("\n"))
}
