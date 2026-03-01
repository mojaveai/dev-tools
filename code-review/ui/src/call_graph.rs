use std::collections::HashMap;

use egui::Color32;
use egui_graphs::{
    DefaultEdgeShape, DefaultNodeShape, Graph, GraphView, LayoutHierarchical,
    LayoutStateHierarchical, SettingsInteraction, SettingsNavigation, SettingsStyle,
};
use petgraph::stable_graph::StableGraph;
use petgraph::Directed;

use crate::state::{CallEdge, FunctionInfo};

/// Node payload for the call graph.
#[derive(Clone, Debug)]
pub struct CgNode {
    #[allow(dead_code)]
    pub name: String,
    pub fn_index: usize,
}

/// Edge payload (unit — edges carry no extra data).
#[derive(Clone, Debug, Default)]
pub struct CgEdge;

type CgGraph = Graph<CgNode, CgEdge, Directed, u32, DefaultNodeShape, DefaultEdgeShape>;
type NodeIndex = petgraph::graph::NodeIndex<u32>;

/// Colors for focus-based highlighting.
const COLOR_FOCUSED: Color32 = Color32::from_rgb(0x00, 0x64, 0xB4); // accent blue
const COLOR_NEIGHBOR: Color32 = Color32::from_rgb(0xE3, 0xF0, 0xFA); // accent light
const COLOR_MUTED: Color32 = Color32::from_rgb(0xCC, 0xCC, 0xCC);

/// Persistent state for the call graph panel.
pub struct CallGraphState {
    pub graph: CgGraph,
    /// Map from function name → petgraph NodeIndex.
    node_indices: HashMap<String, NodeIndex>,
    /// The underlying petgraph for neighbor lookups.
    raw_graph: StableGraph<CgNode, CgEdge, Directed>,
    /// Currently focused function index (into the functions list).
    pub focused_fn: usize,
}

impl CallGraphState {
    /// Build a call graph from function definitions and call edges.
    ///
    /// Returns `None` if there are no call relationships to display.
    pub fn build(
        functions: &[FunctionInfo],
        call_edges: &[CallEdge],
    ) -> Option<Self> {
        if call_edges.is_empty() || functions.is_empty() {
            return None;
        }

        let fn_to_index: HashMap<&str, usize> = functions
            .iter()
            .enumerate()
            .map(|(i, f)| (f.name.as_str(), i))
            .collect();

        // Only include functions that participate in at least one call edge.
        let mut participating: std::collections::HashSet<&str> =
            std::collections::HashSet::new();
        for edge in call_edges {
            if fn_to_index.contains_key(edge.caller.as_str())
                && fn_to_index.contains_key(edge.callee.as_str())
            {
                participating.insert(&edge.caller);
                participating.insert(&edge.callee);
            }
        }

        if participating.is_empty() {
            return None;
        }

        let mut raw_graph: StableGraph<CgNode, CgEdge, Directed> = StableGraph::new();
        let mut node_indices: HashMap<String, NodeIndex> = HashMap::new();

        // Add nodes for participating functions.
        for name in &participating {
            let fn_index = fn_to_index[name];
            let idx = raw_graph.add_node(CgNode {
                name: name.to_string(),
                fn_index,
            });
            node_indices.insert(name.to_string(), idx);
        }

        // Add edges.
        for edge in call_edges {
            if let (Some(&from), Some(&to)) =
                (node_indices.get(&edge.caller), node_indices.get(&edge.callee))
            {
                raw_graph.add_edge(from, to, CgEdge);
            }
        }

        // Convert to egui_graphs Graph.
        let mut graph: CgGraph = egui_graphs::to_graph(&raw_graph);

        // Set labels on all nodes.
        for (name, &idx) in &node_indices {
            if let Some(node) = graph.node_mut(idx) {
                node.set_label(name.clone());
            }
        }

        let mut state = Self {
            graph,
            node_indices,
            raw_graph,
            focused_fn: 0,
        };
        state.update_focus_colors(0, functions);
        Some(state)
    }

    /// Update node colors based on the focused function.
    pub fn update_focus_colors(&mut self, focused_fn: usize, functions: &[FunctionInfo]) {
        self.focused_fn = focused_fn;

        let focused_name = functions
            .get(focused_fn)
            .map(|f| f.name.as_str())
            .unwrap_or("");

        let focused_node = self.node_indices.get(focused_name).copied();

        // Gather neighbor node indices.
        let neighbors: std::collections::HashSet<NodeIndex> = focused_node
            .map(|idx| {
                self.raw_graph
                    .neighbors_undirected(idx)
                    .collect()
            })
            .unwrap_or_default();

        for (name_ref, &idx) in &self.node_indices {
            let color = if self.node_indices.get(name_ref) == focused_node.as_ref() {
                COLOR_FOCUSED
            } else if neighbors.contains(&idx) {
                COLOR_NEIGHBOR
            } else {
                COLOR_MUTED
            };

            if let Some(node) = self.graph.node_mut(idx) {
                node.set_color(color);
            }
        }
    }

    /// Look up which function index a node corresponds to.
    pub fn fn_index_for_node(&self, idx: NodeIndex) -> Option<usize> {
        self.graph.node(idx).map(|n| n.payload().fn_index)
    }

    /// Number of callers and callees for the focused function.
    pub fn neighbor_stats(&self, functions: &[FunctionInfo]) -> (usize, usize) {
        let focused_name = functions
            .get(self.focused_fn)
            .map(|f| f.name.as_str())
            .unwrap_or("");

        let Some(&idx) = self.node_indices.get(focused_name) else {
            return (0, 0);
        };

        let callers = self
            .raw_graph
            .neighbors_directed(idx, petgraph::Direction::Incoming)
            .count();
        let callees = self
            .raw_graph
            .neighbors_directed(idx, petgraph::Direction::Outgoing)
            .count();
        (callers, callees)
    }
}

/// Render the call graph widget. Returns `Some(fn_index)` if a node was clicked.
pub fn render(ui: &mut egui::Ui, state: &mut CallGraphState) -> Option<usize> {
    let interaction = SettingsInteraction::new()
        .with_node_clicking_enabled(true)
        .with_node_selection_enabled(true)
        .with_dragging_enabled(true);

    let nav = SettingsNavigation::new()
        .with_fit_to_screen_enabled(false)
        .with_zoom_and_pan_enabled(true);

    let style = SettingsStyle::new().with_labels_always(true);

    let mut view = GraphView::<
        CgNode,
        CgEdge,
        Directed,
        u32,
        DefaultNodeShape,
        DefaultEdgeShape,
        LayoutStateHierarchical,
        LayoutHierarchical,
    >::new(&mut state.graph)
    .with_interactions(&interaction)
    .with_navigations(&nav)
    .with_styles(&style);

    ui.add(&mut view);

    // Check for node selection changes — detect clicks.
    let selected = state.graph.selected_nodes().to_vec();
    if let Some(&clicked_idx) = selected.first() {
        // Clear selection so next click is detected.
        state.graph.set_selected_nodes(vec![]);
        return state.fn_index_for_node(clicked_idx);
    }

    None
}
