use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use crate::files;
use crate::highlighting::{Highlighter, StyledSpan};

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
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/code_review_ui.js", get(serve_js))
        .route("/code_review_ui_bg.wasm", get(serve_wasm))
        .route("/api/files", get(api_files))
        .route("/api/file", get(api_file))
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
    highlights: Vec<Vec<StyledSpan>>,
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

    let highlights = tokio::task::spawn_blocking(move || {
        highlighter.highlight(&content_for_hl, &path_for_hl)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Highlight failed: {e}")))?;

    Ok(axum::Json(FileResponse {
        path: query.path,
        content,
        highlights,
    }))
}
