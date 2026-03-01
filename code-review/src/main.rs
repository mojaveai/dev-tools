mod callgraph;
mod files;
mod functions;
mod git;
mod highlighting;
mod server;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use tracing::{info, warn};

const DEFAULT_PORT: u16 = 6357;
const MAX_PORT_ATTEMPTS: u16 = 100;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("Cannot determine current directory"));

    let root = root.canonicalize().expect("Cannot canonicalize root path");

    let highlighter = highlighting::Highlighter::new();

    let file_paths: Arc<RwLock<Vec<String>>> = Arc::new(RwLock::new(Vec::new()));
    let scan_complete = Arc::new(AtomicBool::new(false));

    let state = server::AppState {
        root: root.clone(),
        file_paths: Arc::clone(&file_paths),
        scan_complete: Arc::clone(&scan_complete),
        highlighter: Arc::new(highlighter),
        call_graph: Arc::new(callgraph::CallGraphStore::new()),
        git_diff: Arc::new(git::GitDiffStore::new()),
    };

    // Discover files in the background — server starts serving immediately.
    info!("Scanning Python files in {}", root.display());
    tokio::task::spawn_blocking(move || {
        files::discover_python_files_incremental(root, file_paths, scan_complete);
    });

    let app = server::router(state);
    let (listener, port) = bind_available_port(DEFAULT_PORT).await;

    let url = format!("http://localhost:{port}");
    info!("Server listening at {url}");

    if let Err(e) = open::that(&url) {
        warn!("Could not open browser: {e}");
    }

    axum::serve(listener, app).await.expect("Server error");
}

async fn bind_available_port(start: u16) -> (tokio::net::TcpListener, u16) {
    for port in start..start.saturating_add(MAX_PORT_ATTEMPTS) {
        if let Ok(listener) = tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            return (listener, port);
        }
    }
    panic!(
        "Could not find an open port in range {start}–{}",
        start.saturating_add(MAX_PORT_ATTEMPTS - 1)
    );
}
