use std::sync::{Arc, Mutex};

/// Represents the lifecycle of an async data fetch.
#[derive(Clone, Debug)]
pub enum AsyncData<T> {
    Loading,
    Loaded(T),
    Error(String),
}

impl<T> AsyncData<T> {
    pub fn as_loaded(&self) -> Option<&T> {
        match self {
            Self::Loaded(v) => Some(v),
            _ => None,
        }
    }
}

/// Thread-safe handle for async data that bridges ehttp callbacks to egui's immediate-mode loop.
pub type SharedAsync<T> = Arc<Mutex<AsyncData<T>>>;

pub fn shared_loading<T>() -> SharedAsync<T> {
    Arc::new(Mutex::new(AsyncData::Loading))
}

/// A node in the file tree built from flat paths.
#[derive(Debug, Clone)]
pub enum FileNode {
    Dir {
        name: String,
        children: Vec<FileNode>,
    },
    File {
        name: String,
        path: String,
    },
}

impl FileNode {
    /// Build a tree from a sorted list of relative paths.
    pub fn build_tree(paths: &[String]) -> Vec<FileNode> {
        let mut root: Vec<FileNode> = Vec::new();
        for path in paths {
            insert_path(&mut root, path, &path.split('/').collect::<Vec<_>>());
        }
        sort_tree(&mut root);
        root
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Dir { name, .. } | Self::File { name, .. } => name,
        }
    }
}

fn insert_path(nodes: &mut Vec<FileNode>, full_path: &str, parts: &[&str]) {
    match parts {
        [] => {}
        [file] => {
            nodes.push(FileNode::File {
                name: (*file).to_owned(),
                path: full_path.to_owned(),
            });
        }
        [dir, rest @ ..] => {
            let existing = nodes.iter_mut().find(|n| {
                matches!(n, FileNode::Dir { name, .. } if name == dir)
            });
            match existing {
                Some(FileNode::Dir { children, .. }) => {
                    insert_path(children, full_path, rest);
                }
                _ => {
                    let mut children = Vec::new();
                    insert_path(&mut children, full_path, rest);
                    nodes.push(FileNode::Dir {
                        name: (*dir).to_owned(),
                        children,
                    });
                }
            }
        }
    }
}

/// A single styled text fragment from server-side syntax highlighting.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct StyledSpan {
    pub text: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// All highlighted lines for a file.
pub type HighlightedLines = Vec<Vec<StyledSpan>>;

/// Collect all file paths from the tree in display order (depth-first, dirs first).
pub fn collect_paths(nodes: &[FileNode]) -> Vec<String> {
    let mut out = Vec::new();
    collect_paths_inner(nodes, &mut out);
    out
}

fn collect_paths_inner(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        match node {
            FileNode::Dir { children, .. } => collect_paths_inner(children, out),
            FileNode::File { path, .. } => out.push(path.clone()),
        }
    }
}

/// Sort tree: directories first (alphabetical), then files (alphabetical).
fn sort_tree(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| {
        let a_is_dir = matches!(a, FileNode::Dir { .. });
        let b_is_dir = matches!(b, FileNode::Dir { .. });
        b_is_dir.cmp(&a_is_dir).then_with(|| a.name().cmp(b.name()))
    });
    for node in nodes.iter_mut() {
        if let FileNode::Dir { children, .. } = node {
            sort_tree(children);
        }
    }
}
