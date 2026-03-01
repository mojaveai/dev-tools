use std::collections::HashSet;

use serde::Serialize;
use tree_sitter::{Node, Parser};

use crate::functions::FunctionInfo;

/// A directed edge representing one function calling another within the same file.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct CallEdge {
    pub caller: String,
    pub callee: String,
}

/// Extract call edges between functions defined in the same file.
///
/// Uses tree-sitter to walk each function body and find `call` nodes, then matches
/// callee names against the file's known function definitions. Only same-file,
/// non-recursive edges are included, deduplicated per (caller, callee) pair.
pub fn extract_call_edges(content: &str, functions: &[FunctionInfo]) -> Vec<CallEdge> {
    if functions.is_empty() {
        return Vec::new();
    }

    let mut parser = Parser::new();
    let language = tree_sitter_python::LANGUAGE.into();
    parser
        .set_language(&language)
        .expect("Failed to load Python grammar");

    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };

    let source = content.as_bytes();
    let fn_names: HashSet<&str> = functions.iter().map(|f| f.name.as_str()).collect();

    // Map each function to the calls it makes.
    let mut edges = HashSet::new();
    for func in functions {
        let Some(fn_node) = find_function_node(tree.root_node(), source, &func.name, func.start_line) else {
            continue;
        };

        let Some(body) = fn_node.child_by_field_name("body") else {
            continue;
        };

        let mut callees = Vec::new();
        collect_calls(body, source, &mut callees);

        for callee in callees {
            // Only include edges to functions defined in this file, skip self-recursion.
            if callee != func.name && fn_names.contains(callee.as_str()) {
                edges.insert(CallEdge {
                    caller: func.name.clone(),
                    callee,
                });
            }
        }
    }

    edges.into_iter().collect()
}

/// Find the tree-sitter function_definition node matching a given name and start line.
fn find_function_node<'a>(
    root: Node<'a>,
    source: &[u8],
    name: &str,
    start_line: usize,
) -> Option<Node<'a>> {
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        if is_function_kind(node.kind()) {
            let matches_line = node.start_position().row == start_line
                // Decorated functions: the decorator starts at start_line, the def is later.
                || node.parent().is_some_and(|p| {
                    p.kind() == "decorated_definition" && p.start_position().row == start_line
                });

            if matches_line
                && let Some(name_node) = node.child_by_field_name("name")
                && name_node.utf8_text(source).ok() == Some(name)
            {
                return Some(node);
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            stack.push(child);
        }
    }

    None
}

/// Recursively collect callee names from `call` nodes within a subtree.
///
/// Skips nested function definitions (they are their own scope).
fn collect_calls(node: Node, source: &[u8], out: &mut Vec<String>) {
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        // Don't descend into nested function definitions.
        if is_function_kind(child.kind()) || child.kind() == "decorated_definition" {
            continue;
        }

        if child.kind() == "call"
            && let Some(callee) = extract_callee_name(&child, source)
        {
            out.push(callee);
        }

        // Recurse into child nodes to find nested calls (e.g., in arguments, comprehensions).
        collect_calls(child, source, out);
    }
}

/// Extract the callee name from a `call` node.
///
/// - `identifier` → use text directly (e.g., `foo()`)
/// - `attribute` where object is `self` → use the attribute name (e.g., `self.bar()` → `bar`)
/// - Other forms (chained calls, subscript, etc.) → `None`
fn extract_callee_name(call_node: &Node, source: &[u8]) -> Option<String> {
    let func = call_node.child_by_field_name("function")?;

    match func.kind() {
        "identifier" => func.utf8_text(source).ok().map(str::to_owned),
        "attribute" => {
            let object = func.child_by_field_name("object")?;
            let attr = func.child_by_field_name("attribute")?;

            // Only resolve `self.method()` calls.
            if object.kind() == "identifier" && object.utf8_text(source).ok() == Some("self") {
                attr.utf8_text(source).ok().map(str::to_owned)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn is_function_kind(kind: &str) -> bool {
    kind == "function_definition" || kind == "async_function_definition"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functions::extract_python_functions;

    fn edges_for(src: &str) -> Vec<CallEdge> {
        let functions = extract_python_functions(src);
        let mut edges = extract_call_edges(src, &functions);
        edges.sort_by(|a, b| (&a.caller, &a.callee).cmp(&(&b.caller, &b.callee)));
        edges
    }

    #[test]
    fn simple_direct_calls() {
        let src = "\
def foo():
    bar()

def bar():
    pass
";
        let edges = edges_for(src);
        assert_eq!(edges, vec![CallEdge { caller: "foo".into(), callee: "bar".into() }]);
    }

    #[test]
    fn self_method_calls() {
        let src = "\
class MyClass:
    def method_a(self):
        self.method_b()

    def method_b(self):
        pass
";
        let edges = edges_for(src);
        assert_eq!(
            edges,
            vec![CallEdge { caller: "method_a".into(), callee: "method_b".into() }]
        );
    }

    #[test]
    fn external_calls_filtered_out() {
        let src = "\
def foo():
    print('hello')
    os.path.join('a', 'b')
    bar()

def bar():
    pass
";
        let edges = edges_for(src);
        assert_eq!(edges, vec![CallEdge { caller: "foo".into(), callee: "bar".into() }]);
    }

    #[test]
    fn nested_calls_in_expressions() {
        let src = "\
def foo():
    x = [bar() for _ in range(10)]
    y = baz(bar())

def bar():
    return 1

def baz(x):
    return x + 1
";
        let edges = edges_for(src);
        assert_eq!(edges.len(), 2);
        assert!(edges.contains(&CallEdge { caller: "foo".into(), callee: "bar".into() }));
        assert!(edges.contains(&CallEdge { caller: "foo".into(), callee: "baz".into() }));
    }

    #[test]
    fn self_recursion_excluded() {
        let src = "\
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)
";
        let edges = edges_for(src);
        assert!(edges.is_empty());
    }

    #[test]
    fn edge_deduplication() {
        let src = "\
def foo():
    bar()
    bar()
    bar()

def bar():
    pass
";
        let edges = edges_for(src);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0], CallEdge { caller: "foo".into(), callee: "bar".into() });
    }

    #[test]
    fn empty_file() {
        let edges = edges_for("");
        assert!(edges.is_empty());
    }

    #[test]
    fn no_functions() {
        let edges = edges_for("x = 42\nprint(x)\n");
        assert!(edges.is_empty());
    }

    #[test]
    fn nested_function_calls_scoped() {
        let src = "\
def outer():
    def inner():
        pass
    inner()

def standalone():
    pass
";
        let edges = edges_for(src);
        // outer calls inner (inner is a known function in the file)
        assert!(edges.contains(&CallEdge { caller: "outer".into(), callee: "inner".into() }));
        // inner does NOT call standalone
        assert!(!edges.iter().any(|e| e.caller == "inner"));
    }

    #[test]
    fn bidirectional_calls() {
        let src = "\
def ping():
    pong()

def pong():
    ping()
";
        let edges = edges_for(src);
        assert_eq!(edges.len(), 2);
        assert!(edges.contains(&CallEdge { caller: "ping".into(), callee: "pong".into() }));
        assert!(edges.contains(&CallEdge { caller: "pong".into(), callee: "ping".into() }));
    }

    #[test]
    fn decorated_function_calls() {
        let src = "\
@decorator
def foo():
    bar()

def bar():
    pass
";
        let edges = edges_for(src);
        assert_eq!(edges, vec![CallEdge { caller: "foo".into(), callee: "bar".into() }]);
    }
}
