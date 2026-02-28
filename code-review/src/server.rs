use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use crate::files;

// Embed build artifacts at compile time
const INDEX_HTML: &[u8] = include_bytes!("../assets/index.html");
const WASM_JS: &[u8] = include_bytes!(env!("WASM_JS_PATH"));
const WASM_BG: &[u8] = include_bytes!(env!("WASM_BG_PATH"));

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub root: PathBuf,
    pub file_paths: Arc<Vec<String>>,
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

async fn api_files(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(state.file_paths.as_ref().clone())
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(serde::Serialize)]
struct FileResponse {
    path: String,
    content: String,
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

    Ok(axum::Json(FileResponse {
        path: query.path,
        content,
    }))
}
