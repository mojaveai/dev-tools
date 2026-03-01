use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use ignore::WalkBuilder;

/// Incrementally discover Python files under `root`, pushing each path into
/// `sink` as it is found. Sets `done` to `true` when the walk finishes.
/// Designed to run on a blocking thread via `tokio::task::spawn_blocking`.
pub fn discover_python_files_incremental(
    root: PathBuf,
    sink: Arc<RwLock<Vec<String>>>,
    done: Arc<AtomicBool>,
) {
    let walker = WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .sort_by_file_path(Path::cmp)
        .build();

    for entry in walker.filter_map(Result::ok) {
        let dominated_by_py = entry.file_type().is_some_and(|ft| ft.is_file())
            && entry.path().extension().is_some_and(|ext| ext == "py");

        if !dominated_by_py {
            continue;
        }

        if let Ok(rel) = entry.path().strip_prefix(&root) {
            let path = normalize_path(rel);
            sink.write().unwrap().push(path);
        }
    }

    done.store(true, Ordering::Release);
}

/// Validate a user-supplied relative path against traversal attacks.
/// Returns the resolved canonical path if safe, or None.
pub fn safe_resolve(root: &Path, relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);

    // Reject absolute paths
    if path.is_absolute() {
        return None;
    }

    // Reject any `..` components
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }

    let resolved = root.join(path);
    let canonical = resolved.canonicalize().ok()?;
    let root_canonical = root.canonicalize().ok()?;

    // Double-check the resolved path is within root
    canonical.starts_with(&root_canonical).then_some(canonical)
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_traversal() {
        let root = Path::new("/tmp");
        assert!(safe_resolve(root, "../etc/passwd").is_none());
        assert!(safe_resolve(root, "foo/../../etc/passwd").is_none());
    }

    #[test]
    fn rejects_absolute_paths() {
        let root = Path::new("/tmp");
        assert!(safe_resolve(root, "/etc/passwd").is_none());
    }
}
