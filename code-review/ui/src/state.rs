use std::sync::{Arc, Mutex};

/// Represents the lifecycle of an async data fetch.
#[derive(Clone, Debug)]
pub enum AsyncData<T> {
    Loading,
    Loaded(T),
    Error(String),
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
            let existing = nodes
                .iter_mut()
                .find(|n| matches!(n, FileNode::Dir { name, .. } if name == dir));
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

// ── Git diff types ──────────────────────────────────────────────────

/// Whether to diff against HEAD or a base branch.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    Head,
    Branch,
}

/// Per-line change status from the server-side diff.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineStatus {
    Unchanged,
    Added,
    Modified,
}

/// Which subset of files to navigate in zen mode.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileScope {
    ChangedHead,
    ChangedBranch,
    All,
}

/// A block of deleted lines that appeared before a given line in the new file.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DeletedSection {
    pub before_line: usize,
    pub lines: Vec<String>,
}

/// Response from GET /api/diff
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DiffResponse {
    #[allow(dead_code)]
    pub path: String,
    #[allow(dead_code)]
    pub mode: DiffMode,
    pub line_statuses: Vec<LineStatus>,
    #[allow(dead_code)]
    pub deleted_before: Vec<usize>,
    pub deleted_sections: Vec<DeletedSection>,
}

/// Response from GET /api/diff/files
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DiffFilesResponse {
    #[allow(dead_code)]
    pub mode: DiffMode,
    pub changed_files: Vec<String>,
}

/// Pre-resolved diff data passed into the code viewer for rendering.
#[derive(Debug, Clone)]
pub struct DiffData {
    pub line_statuses: Vec<LineStatus>,
    pub deleted_sections: Vec<DeletedSection>,
}

/// Response shape for GET /api/files — includes scanning progress.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct FilesResponse {
    pub files: Vec<String>,
    pub scanning: bool,
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

/// Syntax-highlighted spans for both light and dark themes.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ThemedHighlights {
    pub light: HighlightedLines,
    pub dark: HighlightedLines,
}

/// Metadata about a function definition within a file.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    /// First line (0-indexed), including decorators.
    pub start_line: usize,
    /// One past the last line (0-indexed, exclusive).
    pub end_line: usize,
}

/// All data returned by the `/api/file` endpoint needed by the UI.
#[derive(Debug, Clone)]
pub struct FilePayload {
    pub highlights: ThemedHighlights,
    pub functions: Vec<FunctionInfo>,
}

/// Function location used by caller/callee relationships.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FunctionRef {
    pub path: String,
    pub name: String,
    pub start_line: usize,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct CallTreeNode {
    pub function: FunctionRef,
    #[serde(default)]
    pub children: Vec<CallTreeNode>,
    #[serde(default)]
    pub cycle: bool,
    #[serde(default)]
    pub truncated: bool,
}

/// Caller/callee trees plus transitive test-callers for a function.
#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct FunctionRelations {
    pub focus: Option<FunctionRef>,
    #[serde(default)]
    pub test_callers: Vec<FunctionRef>,
    #[serde(default)]
    pub caller_tree: Vec<CallTreeNode>,
    #[serde(default)]
    pub callee_tree: Vec<CallTreeNode>,
}

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
