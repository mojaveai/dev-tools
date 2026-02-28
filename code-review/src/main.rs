mod files;
mod server;

use std::path::PathBuf;
use std::sync::Arc;

use tracing::{info, warn};

const DEFAULT_PORT: u16 = 3000;
const MAX_PORT_ATTEMPTS: u16 = 100;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("Cannot determine current directory"));

    let root = root
        .canonicalize()
        .expect("Cannot canonicalize root path");

    info!("Indexing Python files in {}", root.display());
    let file_paths = files::discover_python_files(&root);
    info!("Found {} Python files", file_paths.len());

    let state = server::AppState {
        root,
        file_paths: Arc::new(file_paths),
    };

    let app = server::router(state);
    let (listener, port) = bind_available_port(DEFAULT_PORT).await;

    let url = format!("http://localhost:{port}");
    info!("Server listening at {url}");

    if let Err(e) = open::that(&url) {
        warn!("Could not open browser: {e}");
    }

    axum::serve(listener, app)
        .await
        .expect("Server error");
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
