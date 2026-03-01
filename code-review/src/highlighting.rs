use std::path::Path;

use serde::Serialize;
use syntect::easy::HighlightLines;
use syntect::highlighting::Theme;
use syntect::highlighting::ThemeSet;
use syntect::parsing::SyntaxSet;

/// Default syntect themes for light and dark UI modes.
const DEFAULT_LIGHT_THEME: &str = "InspiredGitHub";
const DEFAULT_DARK_THEME: &str = "base16-ocean.dark";

/// A single styled text fragment within a highlighted line.
#[derive(Debug, Clone, Serialize)]
pub struct StyledSpan {
    pub text: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Highlighted lines generated for both light and dark UI themes.
#[derive(Debug, Clone, Serialize)]
pub struct ThemedHighlights {
    pub light: Vec<Vec<StyledSpan>>,
    pub dark: Vec<Vec<StyledSpan>>,
}

/// Highlighter theme configuration.
#[derive(Debug, Clone)]
pub struct HighlighterConfig {
    pub light_theme_name: String,
    pub dark_theme_name: String,
}

impl Default for HighlighterConfig {
    fn default() -> Self {
        Self {
            light_theme_name: DEFAULT_LIGHT_THEME.to_owned(),
            dark_theme_name: DEFAULT_DARK_THEME.to_owned(),
        }
    }
}

/// Wraps syntect's syntax set and theme for on-demand code highlighting.
pub struct Highlighter {
    syntax_set: SyntaxSet,
    theme_set: ThemeSet,
    config: HighlighterConfig,
}

impl Highlighter {
    pub fn new() -> Self {
        Self::with_config(HighlighterConfig::default())
    }

    pub fn with_config(config: HighlighterConfig) -> Self {
        Self {
            syntax_set: SyntaxSet::load_defaults_newlines(),
            theme_set: ThemeSet::load_defaults(),
            config,
        }
    }

    /// Highlight file content for both light and dark themes.
    pub fn highlight(&self, content: &str, path: &str) -> ThemedHighlights {
        ThemedHighlights {
            light: self.highlight_with_theme(content, path, &self.config.light_theme_name),
            dark: self.highlight_with_theme(content, path, &self.config.dark_theme_name),
        }
    }

    /// Highlight file content into a vec of lines, each a vec of colored spans.
    /// Falls back to plain-text syntax if the file extension is unrecognised.
    fn highlight_with_theme(
        &self,
        content: &str,
        path: &str,
        theme_name: &str,
    ) -> Vec<Vec<StyledSpan>> {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let syntax = self
            .syntax_set
            .find_syntax_by_extension(ext)
            .unwrap_or_else(|| self.syntax_set.find_syntax_plain_text());

        let theme = self.resolve_theme(theme_name);

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

    fn resolve_theme(&self, theme_name: &str) -> &Theme {
        self.theme_set
            .themes
            .get(theme_name)
            .or_else(|| self.theme_set.themes.values().next())
            .expect("no themes available")
    }
}
