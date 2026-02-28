use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

/// Discover Python files under `root`, respecting .gitignore rules.
/// Returns sorted relative paths.
pub fn discover_python_files(root: &Path) -> Vec<String> {
    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|ft| ft.is_file()))
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext == "py")
        })
        .filter_map(|entry| {
            entry
                .path()
                .strip_prefix(root)
                .ok()
                .map(Path::to_path_buf)
        })
        .map(|p| normalize_path(&p))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
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
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
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
