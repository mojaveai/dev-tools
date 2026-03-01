use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Whether to diff against HEAD (unstaged working-tree changes) or a base branch.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    Head,
    Branch,
}

/// Per-line change status relative to the chosen diff base.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LineStatus {
    Unchanged,
    Added,
    Modified,
}

/// A block of contiguous deleted lines that appeared before a given line.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeletedSection {
    /// The new-file line index these deletions appear before.
    pub before_line: usize,
    /// The actual text content of each deleted line.
    pub lines: Vec<String>,
}

/// Parsed diff information for a single file.
#[derive(Serialize, Clone, Debug)]
pub struct FileDiff {
    pub path: String,
    pub line_statuses: Vec<LineStatus>,
    /// Indices of lines that have deleted lines immediately before them.
    pub deleted_before: Vec<usize>,
    /// Actual content of deleted lines, grouped by their position.
    pub deleted_sections: Vec<DeletedSection>,
}

// ── Git CLI helpers ─────────────────────────────────────────────────

async fn git_cmd(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

pub async fn detect_default_branch(root: &Path) -> Option<String> {
    for candidate in &["origin/main", "origin/master", "main", "master"] {
        if git_cmd(root, &["rev-parse", "--verify", candidate])
            .await
            .is_ok()
        {
            return Some((*candidate).to_owned());
        }
    }
    None
}

async fn merge_base(root: &Path, branch: &str) -> Result<String, String> {
    git_cmd(root, &["merge-base", "HEAD", branch])
        .await
        .map(|s| s.trim().to_owned())
}

async fn diff_ref_for_mode(root: &Path, mode: DiffMode) -> Result<String, String> {
    match mode {
        DiffMode::Head => Ok("HEAD".to_owned()),
        DiffMode::Branch => {
            let branch = detect_default_branch(root)
                .await
                .ok_or_else(|| "No default branch found".to_owned())?;
            merge_base(root, &branch).await
        }
    }
}

/// List files changed relative to the given diff base.
pub async fn changed_files(root: &Path, mode: DiffMode) -> Result<Vec<String>, String> {
    let base = diff_ref_for_mode(root, mode).await?;
    let tracked = git_cmd(root, &["diff", "--name-only", &base])
        .await
        .unwrap_or_default();

    let untracked = git_cmd(
        root,
        &["ls-files", "--others", "--exclude-standard"],
    )
    .await
    .unwrap_or_default();

    let mut files: Vec<String> = tracked
        .lines()
        .chain(untracked.lines())
        .filter(|l| !l.is_empty())
        .map(|l| l.replace('\\', "/"))
        .collect();

    files.sort_unstable();
    files.dedup();
    Ok(files)
}

/// Raw unified diff output for a single file.
async fn unified_diff(root: &Path, path: &str, mode: DiffMode) -> Result<String, String> {
    let base = diff_ref_for_mode(root, mode).await?;
    // For untracked files, git diff returns empty — we handle that in the parser
    git_cmd(root, &["diff", &base, "--", path]).await
}

// ── Unified diff parser ─────────────────────────────────────────────

/// Parse a unified diff into per-line statuses for the *new* file.
///
/// `total_lines` is the number of lines in the current working-tree copy
/// so we can fill in `Unchanged` for lines not mentioned in any hunk.
pub fn parse_unified_diff(diff_text: &str, total_lines: usize) -> FileDiff {
    let mut statuses = vec![LineStatus::Unchanged; total_lines];
    let mut deleted_before: Vec<usize> = Vec::new();
    let mut deleted_sections: Vec<DeletedSection> = Vec::new();

    for hunk in HunkIter::new(diff_text) {
        let mut new_line = hunk.new_start; // 0-indexed
        let mut pending_removes: usize = 0;
        let mut pending_removed_lines: Vec<String> = Vec::new();

        for raw_line in hunk.lines {
            if let Some(rest) = raw_line.strip_prefix('-') {
                pending_removes += 1;
                pending_removed_lines.push(rest.to_owned());
            } else if let Some(rest) = raw_line.strip_prefix('+') {
                let _ = rest;
                // Flush all pending deleted lines before the first + after a - block
                if !pending_removed_lines.is_empty() && new_line <= total_lines {
                    deleted_sections.push(DeletedSection {
                        before_line: new_line.min(total_lines),
                        lines: std::mem::take(&mut pending_removed_lines),
                    });
                }
                if new_line < total_lines {
                    if pending_removes > 0 {
                        statuses[new_line] = LineStatus::Modified;
                        pending_removes -= 1;
                    } else {
                        statuses[new_line] = LineStatus::Added;
                    }
                }
                new_line += 1;
            } else {
                // Context line — flush pending deletions
                if !pending_removed_lines.is_empty() && new_line <= total_lines {
                    deleted_sections.push(DeletedSection {
                        before_line: new_line.min(total_lines),
                        lines: std::mem::take(&mut pending_removed_lines),
                    });
                }
                if pending_removes > 0 {
                    // Pure deletions (no matching + lines) — record position
                    if new_line < total_lines {
                        deleted_before.push(new_line);
                    }
                    pending_removes = 0;
                }
                new_line += 1;
            }
        }

        // Trailing deletions at end of hunk
        if !pending_removed_lines.is_empty() {
            deleted_sections.push(DeletedSection {
                before_line: new_line.min(total_lines),
                lines: pending_removed_lines,
            });
        }
        if pending_removes > 0 && new_line < total_lines {
            deleted_before.push(new_line);
        }
    }

    deleted_before.sort_unstable();
    deleted_before.dedup();

    // Merge sections at the same position and sort
    deleted_sections.sort_by_key(|s| s.before_line);
    let mut merged: Vec<DeletedSection> = Vec::new();
    for section in deleted_sections {
        if let Some(last) = merged.last_mut()
            && last.before_line == section.before_line
        {
            last.lines.extend(section.lines);
            continue;
        }
        merged.push(section);
    }

    FileDiff {
        path: String::new(),
        line_statuses: statuses,
        deleted_before,
        deleted_sections: merged,
    }
}

/// Iterator over hunks in unified diff output.
struct HunkIter<'a> {
    lines: std::iter::Peekable<std::str::Lines<'a>>,
}

struct Hunk<'a> {
    new_start: usize,
    lines: Vec<&'a str>,
}

impl<'a> HunkIter<'a> {
    fn new(diff_text: &'a str) -> Self {
        Self {
            lines: diff_text.lines().peekable(),
        }
    }
}

impl<'a> Iterator for HunkIter<'a> {
    type Item = Hunk<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        // Skip to the next @@ header
        loop {
            let line = self.lines.peek()?;
            if line.starts_with("@@") {
                break;
            }
            self.lines.next();
        }

        let header = self.lines.next()?;
        let new_start = parse_hunk_header(header)?;

        let mut hunk_lines = Vec::new();
        while let Some(&line) = self.lines.peek() {
            if line.starts_with("@@") || line.starts_with("diff ") {
                break;
            }
            hunk_lines.push(self.lines.next().unwrap());
        }

        Some(Hunk {
            new_start,
            lines: hunk_lines,
        })
    }
}

/// Parse `@@ -a,b +c,d @@` and return 0-indexed new-file start line.
fn parse_hunk_header(header: &str) -> Option<usize> {
    // Format: @@ -old_start[,old_count] +new_start[,new_count] @@
    let plus_part = header.split('+').nth(1)?;
    let num_part = plus_part.split([',', ' ']).next()?;
    let one_indexed: usize = num_part.parse().ok()?;
    Some(one_indexed.saturating_sub(1))
}

// ── GitDiffStore (async-safe cache) ─────────────────────────────────

struct DiffCache {
    /// `(mode)` → list of changed file paths
    changed: HashMap<DiffMode, Vec<String>>,
    /// `(mode, path)` → per-file diff
    files: HashMap<(DiffMode, String), FileDiff>,
}

impl DiffCache {
    fn new() -> Self {
        Self {
            changed: HashMap::new(),
            files: HashMap::new(),
        }
    }
}

pub struct GitDiffStore {
    cache: RwLock<DiffCache>,
}

impl GitDiffStore {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(DiffCache::new()),
        }
    }

    /// List files changed relative to the given diff base.  Cached after first call.
    pub async fn changed_files(
        &self,
        root: &Path,
        mode: DiffMode,
    ) -> Result<Vec<String>, String> {
        // Check cache first
        {
            let cache = self.cache.read().await;
            if let Some(files) = cache.changed.get(&mode) {
                return Ok(files.clone());
            }
        }

        let files = changed_files(root, mode).await?;

        {
            let mut cache = self.cache.write().await;
            cache.changed.insert(mode, files.clone());
        }

        Ok(files)
    }

    /// Get per-line diff data for a file.  `total_lines` is the line count of the
    /// current working-tree copy so we can build a full-length status vector.
    pub async fn file_diff(
        &self,
        root: &Path,
        path: &str,
        mode: DiffMode,
        total_lines: usize,
    ) -> Result<FileDiff, String> {
        let key = (mode, path.to_owned());

        // Check cache
        {
            let cache = self.cache.read().await;
            if let Some(diff) = cache.files.get(&key) {
                return Ok(diff.clone());
            }
        }

        let raw = unified_diff(root, path, mode).await?;

        let mut diff = if raw.trim().is_empty() {
            // Untracked file or no diff — check if it's untracked
            let untracked = git_cmd(root, &["ls-files", "--others", "--exclude-standard", "--", path])
                .await
                .unwrap_or_default();

            if untracked.lines().any(|l| l.trim() == path) {
                // Entire file is new
                FileDiff {
                    path: path.to_owned(),
                    line_statuses: vec![LineStatus::Added; total_lines],
                    deleted_before: Vec::new(),
                    deleted_sections: Vec::new(),
                }
            } else {
                // No changes
                FileDiff {
                    path: path.to_owned(),
                    line_statuses: vec![LineStatus::Unchanged; total_lines],
                    deleted_before: Vec::new(),
                    deleted_sections: Vec::new(),
                }
            }
        } else {
            let mut diff = parse_unified_diff(&raw, total_lines);
            diff.path = path.to_owned();
            diff
        };

        diff.path = path.to_owned();

        {
            let mut cache = self.cache.write().await;
            cache.files.insert(key, diff.clone());
        }

        Ok(diff)
    }

    /// Clear all cached data (e.g. after user makes new changes).
    pub async fn invalidate(&self) {
        let mut cache = self.cache.write().await;
        cache.changed.clear();
        cache.files.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hunk_header_basic() {
        assert_eq!(parse_hunk_header("@@ -1,5 +1,7 @@"), Some(0));
        assert_eq!(parse_hunk_header("@@ -10,3 +15,4 @@ fn main()"), Some(14));
        assert_eq!(parse_hunk_header("@@ -0,0 +1,3 @@"), Some(0));
    }

    #[test]
    fn parse_simple_addition() {
        let diff = "\
diff --git a/hello.py b/hello.py
index abc..def 100644
--- a/hello.py
+++ b/hello.py
@@ -1,3 +1,5 @@
 line1
+new_line_a
+new_line_b
 line2
 line3
";
        let result = parse_unified_diff(diff, 5);
        assert_eq!(result.line_statuses.len(), 5);
        assert_eq!(result.line_statuses[0], LineStatus::Unchanged); // line1
        assert_eq!(result.line_statuses[1], LineStatus::Added); // new_line_a
        assert_eq!(result.line_statuses[2], LineStatus::Added); // new_line_b
        assert_eq!(result.line_statuses[3], LineStatus::Unchanged); // line2
        assert_eq!(result.line_statuses[4], LineStatus::Unchanged); // line3
        assert!(result.deleted_before.is_empty());
    }

    #[test]
    fn parse_modification() {
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,3 +1,3 @@
 line1
-old_line
+new_line
 line3
";
        let result = parse_unified_diff(diff, 3);
        assert_eq!(result.line_statuses[0], LineStatus::Unchanged);
        assert_eq!(result.line_statuses[1], LineStatus::Modified);
        assert_eq!(result.line_statuses[2], LineStatus::Unchanged);
        assert!(result.deleted_before.is_empty());
    }

    #[test]
    fn parse_deletion() {
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,4 +1,3 @@
 line1
-deleted_line
 line3
 line4
";
        let result = parse_unified_diff(diff, 3);
        assert_eq!(result.line_statuses[0], LineStatus::Unchanged);
        assert_eq!(result.line_statuses[1], LineStatus::Unchanged); // line3
        assert_eq!(result.line_statuses[2], LineStatus::Unchanged); // line4
        assert_eq!(result.deleted_before, vec![1]);
    }

    #[test]
    fn parse_mixed_changes() {
        // 2 removals + 3 additions → first 2 are Modified, last 1 is Added
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,4 +1,5 @@
 line1
-old_a
-old_b
+new_a
+new_b
+new_c
 line4
";
        let result = parse_unified_diff(diff, 5);
        assert_eq!(result.line_statuses[0], LineStatus::Unchanged); // line1
        assert_eq!(result.line_statuses[1], LineStatus::Modified); // new_a (replaces old_a)
        assert_eq!(result.line_statuses[2], LineStatus::Modified); // new_b (replaces old_b)
        assert_eq!(result.line_statuses[3], LineStatus::Added); // new_c (pure addition)
        assert_eq!(result.line_statuses[4], LineStatus::Unchanged); // line4
    }

    #[test]
    fn parse_multiple_hunks() {
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,3 +1,4 @@
 line1
+added_early
 line2
 line3
@@ -8,3 +9,4 @@
 line8
+added_late
 line9
 line10
";
        let result = parse_unified_diff(diff, 12);
        assert_eq!(result.line_statuses[1], LineStatus::Added); // added_early
        assert_eq!(result.line_statuses[9], LineStatus::Added); // added_late
    }

    #[test]
    fn parse_empty_diff() {
        let result = parse_unified_diff("", 5);
        assert_eq!(result.line_statuses, vec![LineStatus::Unchanged; 5]);
        assert!(result.deleted_before.is_empty());
    }

    #[test]
    fn parse_new_file() {
        let diff = "\
diff --git a/new.py b/new.py
new file mode 100644
--- /dev/null
+++ b/new.py
@@ -0,0 +1,3 @@
+line1
+line2
+line3
";
        let result = parse_unified_diff(diff, 3);
        assert_eq!(result.line_statuses[0], LineStatus::Added);
        assert_eq!(result.line_statuses[1], LineStatus::Added);
        assert_eq!(result.line_statuses[2], LineStatus::Added);
        assert!(result.deleted_sections.is_empty());
    }

    #[test]
    fn deleted_sections_captures_modification_content() {
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,3 +1,3 @@
 line1
-old_line
+new_line
 line3
";
        let result = parse_unified_diff(diff, 3);
        assert_eq!(result.deleted_sections.len(), 1);
        assert_eq!(result.deleted_sections[0].before_line, 1);
        assert_eq!(result.deleted_sections[0].lines, vec!["old_line"]);
    }

    #[test]
    fn deleted_sections_captures_pure_deletion() {
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,4 +1,3 @@
 line1
-removed
 line3
 line4
";
        let result = parse_unified_diff(diff, 3);
        assert_eq!(result.deleted_sections.len(), 1);
        assert_eq!(result.deleted_sections[0].before_line, 1);
        assert_eq!(result.deleted_sections[0].lines, vec!["removed"]);
    }

    #[test]
    fn deleted_sections_mixed_changes() {
        // 2 removals + 3 additions: all removed content grouped before first + line
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,4 +1,5 @@
 line1
-old_a
-old_b
+new_a
+new_b
+new_c
 line4
";
        let result = parse_unified_diff(diff, 5);
        assert_eq!(result.deleted_sections.len(), 1);
        assert_eq!(result.deleted_sections[0].before_line, 1);
        assert_eq!(
            result.deleted_sections[0].lines,
            vec!["old_a", "old_b"]
        );
    }

    #[test]
    fn deleted_sections_no_content_for_additions() {
        let diff = "\
diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,3 +1,5 @@
 line1
+new_a
+new_b
 line2
 line3
";
        let result = parse_unified_diff(diff, 5);
        assert!(result.deleted_sections.is_empty());
    }
}
