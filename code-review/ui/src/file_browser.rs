use egui::{CollapsingHeader, RichText, Ui};

use crate::state::FileNode;
use crate::theme;

/// Renders the file tree in the given `Ui`, returning `Some(path)` if a file was clicked.
pub fn render(ui: &mut Ui, nodes: &[FileNode], selected: Option<&str>) -> Option<String> {
    let mut clicked = None;
    for node in nodes {
        match node {
            FileNode::Dir { name, children } => {
                let header = CollapsingHeader::new(
                    RichText::new(format!("\u{1F4C1} {name}"))
                        .color(theme::text_primary())
                        .size(13.5),
                )
                .default_open(false);

                header.show(ui, |ui| {
                    if let Some(path) = render(ui, children, selected) {
                        clicked = Some(path);
                    }
                });
            }
            FileNode::File { name, path } => {
                let is_selected = selected == Some(path.as_str());
                let label = RichText::new(format!("\u{1F4C4} {name}"))
                    .color(if is_selected {
                        theme::accent()
                    } else {
                        theme::text_primary()
                    })
                    .size(13.5);

                let response = ui.selectable_label(is_selected, label);
                if response.clicked() {
                    clicked = Some(path.clone());
                }
            }
        }
    }
    clicked
}
