use std::path::Path;

use serde::Serialize;
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::parsing::SyntaxSet;

/// Default syntect theme — a clean light theme that pairs well with our distill.pub UI.
const DEFAULT_THEME: &str = "InspiredGitHub";

/// A single styled text fragment within a highlighted line.
#[derive(Debug, Clone, Serialize)]
pub struct StyledSpan {
    pub text: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Wraps syntect's syntax set and theme for on-demand code highlighting.
pub struct Highlighter {
    syntax_set: SyntaxSet,
    theme_set: ThemeSet,
    theme_name: String,
}

impl Highlighter {
    pub fn new() -> Self {
        Self {
            syntax_set: SyntaxSet::load_defaults_newlines(),
            theme_set: ThemeSet::load_defaults(),
            theme_name: DEFAULT_THEME.to_owned(),
        }
    }

    /// Highlight file content into a vec of lines, each a vec of colored spans.
    /// Falls back to plain-text syntax if the file extension is unrecognised.
    pub fn highlight(&self, content: &str, path: &str) -> Vec<Vec<StyledSpan>> {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let syntax = self
            .syntax_set
            .find_syntax_by_extension(ext)
            .unwrap_or_else(|| self.syntax_set.find_syntax_plain_text());

        let theme = self
            .theme_set
            .themes
            .get(&self.theme_name)
            .or_else(|| self.theme_set.themes.values().next())
            .expect("no themes available");

        let mut highlighter = HighlightLines::new(syntax, theme);

        content
            .lines()
            .map(|line| {
                // Grammars loaded with `load_defaults_newlines` expect each line
                // to end with '\n' so end-of-line anchors fire correctly.
                // Without this, single-line scopes (e.g. Python `#` comments)
                // never close and bleed into subsequent lines.
                let terminated = format!("{line}\n");
                highlighter
                    .highlight_line(&terminated, &self.syntax_set)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(style, text)| StyledSpan {
                        text: text.trim_end_matches('\n').to_owned(),
                        r: style.foreground.r,
                        g: style.foreground.g,
                        b: style.foreground.b,
                    })
                    .collect()
            })
            .collect()
    }
}
