use serde::Serialize;
use tree_sitter::{Node, Parser};

/// Metadata about a function definition within a file.
#[derive(Debug, Clone, Serialize)]
pub struct FunctionInfo {
    /// Function name (e.g., `"foo"` or `"bar"`).
    pub name: String,
    /// First line of the function (0-indexed), including decorators.
    pub start_line: usize,
    /// One past the last line of the function body (0-indexed, exclusive).
    pub end_line: usize,
}

/// Extract Python function/method definitions from source code using tree-sitter.
///
/// Produces accurate boundaries even for tricky Python constructs like multiline
/// strings, continuation lines, nested comprehensions, and partial/broken syntax
/// (tree-sitter performs error recovery).
pub fn extract_python_functions(content: &str) -> Vec<FunctionInfo> {
    let mut parser = Parser::new();
    let language = tree_sitter_python::LANGUAGE.into();
    parser
        .set_language(&language)
        .expect("Failed to load Python grammar");

    let Some(tree) = parser.parse(content, None) else {
        return Vec::new();
    };

    let mut functions = Vec::new();
    collect_functions(tree.root_node(), content.as_bytes(), &mut functions);
    functions
}

/// Recursively walk the CST, extracting every function definition.
///
/// Decorated functions use the `decorated_definition` node's range so the
/// start line includes decorator lines. Class methods and nested functions
/// are discovered naturally through recursion.
fn collect_functions(node: Node, source: &[u8], out: &mut Vec<FunctionInfo>) {
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        match child.kind() {
            "decorated_definition" => {
                if let Some(def) = child.child_by_field_name("definition") {
                    if is_function_node(&def)
                        && let Some(name) = extract_name(&def, source)
                    {
                        out.push(FunctionInfo {
                            name,
                            // Use the decorated_definition range to include decorators.
                            start_line: child.start_position().row,
                            end_line: child.end_position().row + 1,
                        });
                    }
                    // Recurse into the definition (function body or class body)
                    // to find nested functions / methods.
                    collect_functions(def, source, out);
                }
            }
            kind if is_function_kind(kind) => {
                if let Some(name) = extract_name(&child, source) {
                    out.push(FunctionInfo {
                        name,
                        start_line: child.start_position().row,
                        end_line: child.end_position().row + 1,
                    });
                }
                // Recurse for nested functions.
                collect_functions(child, source, out);
            }
            _ => {
                // Keep descending into class bodies, if-blocks, etc.
                collect_functions(child, source, out);
            }
        }
    }
}

fn is_function_kind(kind: &str) -> bool {
    kind == "function_definition" || kind == "async_function_definition"
}

fn is_function_node(node: &Node) -> bool {
    is_function_kind(node.kind())
}

fn extract_name(node: &Node, source: &[u8]) -> Option<String> {
    node.child_by_field_name("name")?
        .utf8_text(source)
        .ok()
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_functions() {
        let src = "\
def foo():
    pass

def bar():
    return 42
";
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "foo");
        assert_eq!(fns[0].start_line, 0);
        assert_eq!(fns[0].end_line, 2);
        assert_eq!(fns[1].name, "bar");
        assert_eq!(fns[1].start_line, 3);
        assert_eq!(fns[1].end_line, 5);
    }

    #[test]
    fn decorated_function() {
        let src = "\
@decorator
@another
def foo():
    pass
";
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "foo");
        assert_eq!(fns[0].start_line, 0); // includes decorators
        assert_eq!(fns[0].end_line, 4);
    }

    #[test]
    fn async_def() {
        let src = "\
async def handle():
    await something()
";
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "handle");
        assert_eq!(fns[0].start_line, 0);
        assert_eq!(fns[0].end_line, 2);
    }

    #[test]
    fn class_methods() {
        let src = "\
class Foo:
    def method_a(self):
        pass

    def method_b(self):
        return 1
";
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "method_a");
        assert_eq!(fns[1].name, "method_b");
    }

    #[test]
    fn nested_functions() {
        let src = "\
def outer():
    def inner():
        pass
    return inner
";
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "outer");
        assert_eq!(fns[0].start_line, 0);
        assert_eq!(fns[0].end_line, 4);
        assert_eq!(fns[1].name, "inner");
        assert_eq!(fns[1].start_line, 1);
        assert_eq!(fns[1].end_line, 3);
    }

    #[test]
    fn no_functions() {
        let src = "\
import os
x = 42
";
        let fns = extract_python_functions(src);
        assert!(fns.is_empty());
    }

    #[test]
    fn multiline_string_not_confused() {
        let src = r#"
def real():
    x = """
    def fake():
        not a real function
    """
    return x

def also_real():
    pass
"#;
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "real");
        assert_eq!(fns[1].name, "also_real");
    }

    #[test]
    fn decorated_class_methods() {
        let src = "\
class MyClass:
    @staticmethod
    def static_method():
        pass

    @classmethod
    def class_method(cls):
        pass
";
        let fns = extract_python_functions(src);
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "static_method");
        assert_eq!(fns[0].start_line, 1); // includes @staticmethod
        assert_eq!(fns[1].name, "class_method");
        assert_eq!(fns[1].start_line, 5); // includes @classmethod
    }

    #[test]
    fn syntax_error_partial_recovery() {
        let src = "\
def good():
    pass

def broken(
    # missing closing paren and colon

def also_good():
    return 1
";
        let fns = extract_python_functions(src);
        // tree-sitter recovers — should still find at least `good` and `also_good`
        let names: Vec<&str> = fns.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"good"));
        assert!(names.contains(&"also_good"));
    }
}
