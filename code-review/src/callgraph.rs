use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Arc;

use rayon::prelude::*;
use serde::Serialize;
use tokio::sync::RwLock;
use tokio::task::JoinSet;
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FunctionRef {
    pub path: String,
    pub name: String,
    pub start_line: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct FunctionRelations {
    pub callers: Vec<FunctionRef>,
    pub callees: Vec<FunctionRef>,
}

#[derive(Default)]
pub struct CallGraphStore {
    cache: RwLock<CallGraphCache>,
}

#[derive(Default)]
struct CallGraphCache {
    fingerprint: u64,
    index: Option<Arc<CallGraphIndex>>,
}

impl CallGraphStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn relationships_for(
        &self,
        root: &Path,
        files: &[String],
        path: &str,
        start_line: usize,
    ) -> Result<FunctionRelations, String> {
        let index = self.get_or_build_index(root, files).await?;
        Ok(index.relationships_for(path, start_line))
    }

    async fn get_or_build_index(
        &self,
        root: &Path,
        files: &[String],
    ) -> Result<Arc<CallGraphIndex>, String> {
        let fingerprint = files_fingerprint(files);

        {
            let guard = self.cache.read().await;
            if guard.fingerprint == fingerprint
                && let Some(index) = &guard.index
            {
                return Ok(Arc::clone(index));
            }
        }

        let built = build_call_graph_index(root, files).await;

        let mut guard = self.cache.write().await;

        if guard.fingerprint == fingerprint
            && let Some(index) = &guard.index
        {
            return Ok(Arc::clone(index));
        }

        match built {
            Ok(index) => {
                let index = Arc::new(index);
                guard.fingerprint = fingerprint;
                guard.index = Some(Arc::clone(&index));
                Ok(index)
            }
            Err(err) => {
                if let Some(index) = &guard.index {
                    return Ok(Arc::clone(index));
                }
                Err(err)
            }
        }
    }
}

async fn build_call_graph_index(root: &Path, files: &[String]) -> Result<CallGraphIndex, String> {
    let sources = load_sources(root, files).await;
    Ok(build_index_from_loaded_sources(&sources))
}

async fn load_sources(root: &Path, files: &[String]) -> Vec<SourceFile> {
    let mut set = JoinSet::new();

    files.iter().for_each(|path| {
        let path = path.clone();
        let root = root.to_path_buf();
        set.spawn(async move {
            let absolute = root.join(&path);
            let content = tokio::fs::read_to_string(&absolute).await.ok()?;
            Some(SourceFile::from_content(path, content))
        });
    });

    let mut sources = Vec::with_capacity(files.len());

    while let Some(result) = set.join_next().await {
        if let Ok(Some(source)) = result {
            sources.push(source);
        }
    }

    sources.sort_by(|a, b| a.path.cmp(&b.path));
    sources
}

fn files_fingerprint(files: &[String]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    files.len().hash(&mut hasher);
    files.iter().for_each(|path| path.hash(&mut hasher));
    hasher.finish()
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct FunctionKey {
    path: String,
    start_line: usize,
}

#[derive(Debug, Clone)]
struct FunctionRecord {
    path: String,
    name: String,
    start_line: usize,
}

struct CallGraphIndex {
    functions: Vec<FunctionRecord>,
    key_to_id: HashMap<FunctionKey, usize>,
    callers: Vec<BTreeSet<usize>>,
    callees: Vec<BTreeSet<usize>>,
}

impl CallGraphIndex {
    fn relationships_for(&self, path: &str, start_line: usize) -> FunctionRelations {
        let key = FunctionKey {
            path: path.to_owned(),
            start_line,
        };

        let Some(&id) = self.key_to_id.get(&key) else {
            return FunctionRelations::default();
        };

        let callers = self.callers[id]
            .iter()
            .map(|&caller| self.to_public_ref(caller))
            .collect();

        let callees = self.callees[id]
            .iter()
            .map(|&callee| self.to_public_ref(callee))
            .collect();

        FunctionRelations { callers, callees }
    }

    fn to_public_ref(&self, id: usize) -> FunctionRef {
        let function = &self.functions[id];
        FunctionRef {
            path: function.path.clone(),
            name: function.name.clone(),
            start_line: function.start_line,
        }
    }
}

#[derive(Debug, Clone)]
struct SourceFile {
    path: String,
    module: String,
    is_package: bool,
    content: String,
}

impl SourceFile {
    fn from_content(path: String, content: String) -> Self {
        let (module, is_package) = module_name_from_path(&path);
        Self {
            path,
            module,
            is_package,
            content,
        }
    }
}

#[derive(Debug, Clone)]
struct FunctionDecl {
    key: FunctionKey,
    module: String,
    name: String,
    class_path: Vec<String>,
    parent_functions: Vec<String>,
}

#[derive(Debug, Clone)]
struct ClassDecl {
    module: String,
    class_path: Vec<String>,
}

#[derive(Debug, Clone)]
struct ModuleDecls {
    functions: Vec<FunctionDecl>,
    classes: Vec<ClassDecl>,
}

fn build_index_from_loaded_sources(sources: &[SourceFile]) -> CallGraphIndex {
    let module_decls: Vec<ModuleDecls> = sources.par_iter().map(collect_module_decls).collect();

    let mut functions: Vec<FunctionDecl> = module_decls
        .iter()
        .flat_map(|module| module.functions.iter().cloned())
        .collect();

    functions.sort_by(|a, b| {
        a.key
            .path
            .cmp(&b.key.path)
            .then(a.key.start_line.cmp(&b.key.start_line))
            .then(a.name.cmp(&b.name))
    });

    let key_to_id: HashMap<FunctionKey, usize> = functions
        .iter()
        .enumerate()
        .map(|(id, function)| (function.key.clone(), id))
        .collect();

    let function_records: Vec<FunctionRecord> = functions
        .iter()
        .map(|function| FunctionRecord {
            path: function.key.path.clone(),
            name: function.name.clone(),
            start_line: function.key.start_line,
        })
        .collect();

    let symbols = GlobalSymbols::build(sources, &module_decls, &functions, &key_to_id);

    let edges: Vec<(usize, usize)> = sources
        .par_iter()
        .flat_map_iter(|source| analyze_module_calls(source, &key_to_id, &symbols))
        .collect();

    let mut callers = vec![BTreeSet::new(); functions.len()];
    let mut callees = vec![BTreeSet::new(); functions.len()];

    edges.into_iter().for_each(|(caller, callee)| {
        if caller < callees.len() && callee < callers.len() {
            callees[caller].insert(callee);
            callers[callee].insert(caller);
        }
    });

    CallGraphIndex {
        functions: function_records,
        key_to_id,
        callers,
        callees,
    }
}

fn collect_module_decls(source: &SourceFile) -> ModuleDecls {
    let mut parser = Parser::new();
    let language = tree_sitter_python::LANGUAGE.into();

    if parser.set_language(&language).is_err() {
        return ModuleDecls {
            functions: Vec::new(),
            classes: Vec::new(),
        };
    }

    let Some(tree) = parser.parse(&source.content, None) else {
        return ModuleDecls {
            functions: Vec::new(),
            classes: Vec::new(),
        };
    };

    let mut functions = Vec::new();
    let mut classes = Vec::new();

    collect_definitions(
        tree.root_node(),
        source.content.as_bytes(),
        &source.path,
        &source.module,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut functions,
        &mut classes,
    );

    ModuleDecls { functions, classes }
}

#[allow(clippy::too_many_arguments)]
fn collect_definitions(
    node: Node,
    source: &[u8],
    path: &str,
    module: &str,
    class_stack: &mut Vec<String>,
    function_stack: &mut Vec<String>,
    functions: &mut Vec<FunctionDecl>,
    classes: &mut Vec<ClassDecl>,
) {
    let mut cursor = node.walk();

    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "decorated_definition" => {
                if let Some(definition) = child.child_by_field_name("definition") {
                    let decorated_start = child.start_position().row;
                    match definition.kind() {
                        "function_definition" | "async_function_definition" => {
                            collect_function_definition(
                                definition,
                                source,
                                path,
                                module,
                                class_stack,
                                function_stack,
                                functions,
                                classes,
                                Some(decorated_start),
                            );
                        }
                        "class_definition" => {
                            collect_class_definition(
                                definition,
                                source,
                                path,
                                module,
                                class_stack,
                                function_stack,
                                functions,
                                classes,
                            );
                        }
                        _ => {
                            collect_definitions(
                                definition,
                                source,
                                path,
                                module,
                                class_stack,
                                function_stack,
                                functions,
                                classes,
                            );
                        }
                    }
                }
            }
            "function_definition" | "async_function_definition" => {
                collect_function_definition(
                    child,
                    source,
                    path,
                    module,
                    class_stack,
                    function_stack,
                    functions,
                    classes,
                    None,
                );
            }
            "class_definition" => {
                collect_class_definition(
                    child,
                    source,
                    path,
                    module,
                    class_stack,
                    function_stack,
                    functions,
                    classes,
                );
            }
            _ => {
                collect_definitions(
                    child,
                    source,
                    path,
                    module,
                    class_stack,
                    function_stack,
                    functions,
                    classes,
                );
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_function_definition(
    node: Node,
    source: &[u8],
    path: &str,
    module: &str,
    class_stack: &mut Vec<String>,
    function_stack: &mut Vec<String>,
    functions: &mut Vec<FunctionDecl>,
    classes: &mut Vec<ClassDecl>,
    decorated_start: Option<usize>,
) {
    let Some(name) = extract_name(node, source) else {
        return;
    };

    let start_line = decorated_start.unwrap_or_else(|| node.start_position().row);

    functions.push(FunctionDecl {
        key: FunctionKey {
            path: path.to_owned(),
            start_line,
        },
        module: module.to_owned(),
        name: name.clone(),
        class_path: class_stack.clone(),
        parent_functions: function_stack.clone(),
    });

    if let Some(body) = node.child_by_field_name("body") {
        function_stack.push(name);
        collect_definitions(
            body,
            source,
            path,
            module,
            class_stack,
            function_stack,
            functions,
            classes,
        );
        function_stack.pop();
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_class_definition(
    node: Node,
    source: &[u8],
    path: &str,
    module: &str,
    class_stack: &mut Vec<String>,
    function_stack: &mut Vec<String>,
    functions: &mut Vec<FunctionDecl>,
    classes: &mut Vec<ClassDecl>,
) {
    let Some(name) = extract_name(node, source) else {
        return;
    };

    class_stack.push(name.clone());

    classes.push(ClassDecl {
        module: module.to_owned(),
        class_path: class_stack.clone(),
    });

    if let Some(body) = node.child_by_field_name("body") {
        collect_definitions(
            body,
            source,
            path,
            module,
            class_stack,
            function_stack,
            functions,
            classes,
        );
    }

    class_stack.pop();
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ClassType {
    module: String,
    class_path: String,
}

struct GlobalSymbols {
    modules: HashSet<String>,
    top_level_functions: HashMap<(String, String), Vec<usize>>,
    class_methods: HashMap<(String, String, String), Vec<usize>>,
    classes: HashMap<(String, String), ClassType>,
}

impl GlobalSymbols {
    fn build(
        sources: &[SourceFile],
        module_decls: &[ModuleDecls],
        functions: &[FunctionDecl],
        key_to_id: &HashMap<FunctionKey, usize>,
    ) -> Self {
        let modules: HashSet<String> = sources.iter().map(|source| source.module.clone()).collect();

        let mut classes = HashMap::new();
        module_decls
            .iter()
            .flat_map(|module| module.classes.iter())
            .for_each(|class| {
                let class_path = class.class_path.join(".");
                let class_type = ClassType {
                    module: class.module.clone(),
                    class_path: class_path.clone(),
                };
                classes.insert((class.module.clone(), class_path), class_type);
            });

        let mut top_level_functions = HashMap::new();
        let mut class_methods = HashMap::new();

        functions.iter().for_each(|function| {
            let Some(&function_id) = key_to_id.get(&function.key) else {
                return;
            };

            if function.class_path.is_empty() && function.parent_functions.is_empty() {
                top_level_functions
                    .entry((function.module.clone(), function.name.clone()))
                    .or_insert_with(Vec::new)
                    .push(function_id);
            }

            if !function.class_path.is_empty() && function.parent_functions.is_empty() {
                let class_path = function.class_path.join(".");
                class_methods
                    .entry((function.module.clone(), class_path, function.name.clone()))
                    .or_insert_with(Vec::new)
                    .push(function_id);
            }
        });

        Self {
            modules,
            top_level_functions,
            class_methods,
            classes,
        }
    }

    fn resolve_top_level_function(&self, module: &str, name: &str) -> Option<usize> {
        self.top_level_functions
            .get(&(module.to_owned(), name.to_owned()))
            .and_then(|ids| ids.last().copied())
    }

    fn resolve_class(&self, module: &str, class_path: &str) -> Option<ClassType> {
        self.classes
            .get(&(module.to_owned(), class_path.to_owned()))
            .cloned()
    }

    fn resolve_method(&self, class_type: &ClassType, method: &str) -> Option<usize> {
        self.class_methods
            .get(&(
                class_type.module.clone(),
                class_type.class_path.clone(),
                method.to_owned(),
            ))
            .and_then(|ids| ids.last().copied())
    }
}

#[derive(Debug, Clone)]
enum Binding {
    Function(usize),
    Module(String),
    Class(ClassType),
    Instance(ClassType),
    ImportedMember { module: String, member: String },
    LocalValue,
}

#[derive(Default)]
struct Scope {
    bindings: HashMap<String, Binding>,
}

fn analyze_module_calls(
    source: &SourceFile,
    key_to_id: &HashMap<FunctionKey, usize>,
    symbols: &GlobalSymbols,
) -> Vec<(usize, usize)> {
    let mut analyzer = ModuleAnalyzer::new(source, key_to_id, symbols);
    analyzer.analyze()
}

struct ModuleAnalyzer<'a> {
    source: &'a SourceFile,
    source_bytes: &'a [u8],
    key_to_id: &'a HashMap<FunctionKey, usize>,
    symbols: &'a GlobalSymbols,
    scopes: Vec<Scope>,
    class_stack: Vec<String>,
    function_stack: Vec<String>,
    edges: BTreeSet<(usize, usize)>,
}

impl<'a> ModuleAnalyzer<'a> {
    fn new(
        source: &'a SourceFile,
        key_to_id: &'a HashMap<FunctionKey, usize>,
        symbols: &'a GlobalSymbols,
    ) -> Self {
        Self {
            source,
            source_bytes: source.content.as_bytes(),
            key_to_id,
            symbols,
            scopes: Vec::new(),
            class_stack: Vec::new(),
            function_stack: Vec::new(),
            edges: BTreeSet::new(),
        }
    }

    fn analyze(&mut self) -> Vec<(usize, usize)> {
        let mut parser = Parser::new();
        let language = tree_sitter_python::LANGUAGE.into();

        if parser.set_language(&language).is_err() {
            return Vec::new();
        }

        let Some(tree) = parser.parse(&self.source.content, None) else {
            return Vec::new();
        };

        let root = tree.root_node();

        let mut module_scope = Scope::default();
        self.predeclare_scope_definitions(root, &mut module_scope);
        self.scopes.push(module_scope);

        self.visit_node(root, None);

        self.edges.iter().copied().collect()
    }

    fn visit_node(&mut self, node: Node, current_caller: Option<usize>) {
        match node.kind() {
            "decorated_definition" => {
                self.visit_decorated_definition(node, current_caller);
                return;
            }
            "function_definition" | "async_function_definition" => {
                self.visit_function_definition(node, None);
                return;
            }
            "class_definition" => {
                self.visit_class_definition(node, current_caller);
                return;
            }
            "import_statement" => self.apply_import_statement(node),
            "import_from_statement" => self.apply_import_from_statement(node),
            "assignment" => self.apply_assignment(node),
            "augmented_assignment" => self.apply_augmented_assignment(node),
            "for_statement" | "for_in_clause" => self.apply_for_binding(node),
            "named_expression" => self.apply_named_expression(node),
            "except_clause" => self.apply_except_alias(node),
            "call" => {
                if let Some(caller_id) = current_caller
                    && let Some(function_expr) = node.child_by_field_name("function")
                    && let Some(callee_id) = self.resolve_call_target(function_expr)
                {
                    self.edges.insert((caller_id, callee_id));
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.visit_node(child, current_caller);
        }
    }

    fn visit_decorated_definition(&mut self, node: Node, current_caller: Option<usize>) {
        let Some(definition) = node.child_by_field_name("definition") else {
            return;
        };

        let decorated_start = node.start_position().row;

        match definition.kind() {
            "function_definition" | "async_function_definition" => {
                self.visit_function_definition(definition, Some(decorated_start));
            }
            "class_definition" => {
                self.visit_class_definition(definition, current_caller);
            }
            _ => self.visit_node(definition, current_caller),
        }
    }

    fn visit_function_definition(&mut self, node: Node, decorated_start: Option<usize>) {
        let Some(name) = extract_name(node, self.source_bytes) else {
            return;
        };

        let start_line = decorated_start.unwrap_or_else(|| node.start_position().row);
        let function_id = self.function_id(start_line);

        self.function_stack.push(name);

        if let Some(body) = node.child_by_field_name("body") {
            let mut function_scope = Scope::default();
            self.predeclare_scope_definitions(body, &mut function_scope);

            if let Some(parameters) = node.child_by_field_name("parameters") {
                self.collect_parameter_bindings(parameters, &mut function_scope);
            }

            self.scopes.push(function_scope);
            self.visit_node(body, function_id);
            self.scopes.pop();
        }

        self.function_stack.pop();
    }

    fn visit_class_definition(&mut self, node: Node, current_caller: Option<usize>) {
        let Some(name) = extract_name(node, self.source_bytes) else {
            return;
        };

        self.class_stack.push(name);

        if let Some(body) = node.child_by_field_name("body") {
            let mut class_scope = Scope::default();
            self.predeclare_scope_definitions(body, &mut class_scope);
            self.scopes.push(class_scope);
            self.visit_node(body, current_caller);
            self.scopes.pop();
        }

        self.class_stack.pop();
    }

    fn predeclare_scope_definitions(&self, scope_node: Node, scope: &mut Scope) {
        let mut cursor = scope_node.walk();

        for child in scope_node.named_children(&mut cursor) {
            match child.kind() {
                "decorated_definition" => {
                    if let Some(definition) = child.child_by_field_name("definition") {
                        let start_line = child.start_position().row;
                        self.predeclare_definition(definition, scope, Some(start_line));
                    }
                }
                "function_definition" | "async_function_definition" | "class_definition" => {
                    self.predeclare_definition(child, scope, None);
                }
                _ => {}
            }
        }
    }

    fn predeclare_definition(&self, node: Node, scope: &mut Scope, decorated_start: Option<usize>) {
        match node.kind() {
            "function_definition" | "async_function_definition" => {
                let Some(name) = extract_name(node, self.source_bytes) else {
                    return;
                };

                let start_line = decorated_start.unwrap_or_else(|| node.start_position().row);
                if let Some(function_id) = self.function_id(start_line) {
                    scope.bindings.insert(name, Binding::Function(function_id));
                }
            }
            "class_definition" => {
                let Some(name) = extract_name(node, self.source_bytes) else {
                    return;
                };

                let class_path = class_path_with_name(&self.class_stack, &name);
                let class_type = ClassType {
                    module: self.source.module.clone(),
                    class_path,
                };

                scope.bindings.insert(name, Binding::Class(class_type));
            }
            _ => {}
        }
    }

    fn apply_import_statement(&mut self, node: Node) {
        let mut cursor = node.walk();

        node.children_by_field_name("name", &mut cursor)
            .for_each(|import_node| match import_node.kind() {
                "aliased_import" => {
                    let imported = import_node
                        .child_by_field_name("name")
                        .and_then(|name| node_text(name, self.source_bytes));
                    let alias = import_node
                        .child_by_field_name("alias")
                        .and_then(|name| node_text(name, self.source_bytes));

                    if let (Some(imported), Some(alias)) = (imported, alias) {
                        self.bind(alias, Binding::Module(imported));
                    }
                }
                "dotted_name" => {
                    if let Some(imported) = node_text(import_node, self.source_bytes) {
                        let root = imported
                            .split('.')
                            .next()
                            .map(str::to_owned)
                            .unwrap_or(imported);
                        self.bind(root.clone(), Binding::Module(root));
                    }
                }
                _ => {}
            });
    }

    fn apply_import_from_statement(&mut self, node: Node) {
        let Some(module_name_node) = node.child_by_field_name("module_name") else {
            return;
        };

        let Some(raw_module) = node_text(module_name_node, self.source_bytes) else {
            return;
        };

        let Some(resolved_module) = resolve_import_module(
            &self.source.module,
            self.source.is_package,
            raw_module.as_str(),
        ) else {
            return;
        };

        let mut cursor = node.walk();
        for import_node in node.children_by_field_name("name", &mut cursor) {
            let (imported_name, binding_name) = match import_node.kind() {
                "aliased_import" => {
                    let imported = import_node
                        .child_by_field_name("name")
                        .and_then(|name| node_text(name, self.source_bytes));
                    let alias = import_node
                        .child_by_field_name("alias")
                        .and_then(|name| node_text(name, self.source_bytes));

                    match (imported, alias) {
                        (Some(imported), Some(alias)) => (imported, alias),
                        _ => continue,
                    }
                }
                _ => {
                    let Some(imported) = node_text(import_node, self.source_bytes) else {
                        continue;
                    };
                    let alias = imported
                        .split('.')
                        .next_back()
                        .map(str::to_owned)
                        .unwrap_or_else(|| imported.clone());
                    (imported, alias)
                }
            };

            let module_candidate = format!("{resolved_module}.{imported_name}");
            if self.symbols.modules.contains(&module_candidate) {
                self.bind(binding_name, Binding::Module(module_candidate));
                continue;
            }

            if let Some(class_type) = self.symbols.resolve_class(&resolved_module, &imported_name) {
                self.bind(binding_name, Binding::Class(class_type));
                continue;
            }

            let member = imported_name
                .split('.')
                .next_back()
                .map(str::to_owned)
                .unwrap_or(imported_name);

            self.bind(
                binding_name,
                Binding::ImportedMember {
                    module: resolved_module.clone(),
                    member,
                },
            );
        }
    }

    fn apply_assignment(&mut self, node: Node) {
        let Some(left) = node.child_by_field_name("left") else {
            return;
        };

        if let Some(single_name) = single_identifier(left, self.source_bytes)
            && let Some(right) = node.child_by_field_name("right")
            && let Some(class_type) = self.resolve_class_expression(right)
        {
            self.bind(single_name, Binding::Instance(class_type));
            return;
        }

        self.bind_pattern_as_local(left);
    }

    fn apply_augmented_assignment(&mut self, node: Node) {
        if let Some(left) = node.child_by_field_name("left") {
            self.bind_pattern_as_local(left);
        }
    }

    fn apply_for_binding(&mut self, node: Node) {
        if let Some(left) = node.child_by_field_name("left") {
            self.bind_pattern_as_local(left);
        }
    }

    fn apply_named_expression(&mut self, node: Node) {
        if let Some(name_node) = node.child_by_field_name("name")
            && let Some(name) = node_text(name_node, self.source_bytes)
        {
            self.bind(name, Binding::LocalValue);
        }
    }

    fn apply_except_alias(&mut self, node: Node) {
        if let Some(alias_node) = node.child_by_field_name("alias")
            && let Some(alias_name) = single_identifier(alias_node, self.source_bytes)
        {
            self.bind(alias_name, Binding::LocalValue);
        }
    }

    fn bind_pattern_as_local(&mut self, pattern: Node) {
        let mut names = Vec::new();
        collect_pattern_identifiers(pattern, self.source_bytes, &mut names);
        names
            .into_iter()
            .for_each(|name| self.bind(name, Binding::LocalValue));
    }

    fn collect_parameter_bindings(&self, parameters: Node, scope: &mut Scope) {
        let mut names = Vec::new();
        collect_parameter_identifiers(parameters, self.source_bytes, &mut names);
        names.into_iter().for_each(|name| {
            scope.bindings.insert(name, Binding::LocalValue);
        });
    }

    fn resolve_call_target(&self, function_expr: Node) -> Option<usize> {
        let expr = self.unwrap_expression(function_expr);

        match expr.kind() {
            "identifier" => self.resolve_identifier_call(expr),
            "attribute" => self.resolve_attribute_call(expr),
            _ => None,
        }
    }

    fn resolve_identifier_call(&self, node: Node) -> Option<usize> {
        let name = node_text(node, self.source_bytes)?;

        match self.lookup_binding(name.as_str()) {
            Some(Binding::Function(id)) => Some(id),
            Some(Binding::ImportedMember { module, member }) => {
                self.symbols.resolve_top_level_function(&module, &member)
            }
            _ => None,
        }
    }

    fn resolve_attribute_call(&self, node: Node) -> Option<usize> {
        let object = node.child_by_field_name("object")?;
        let attribute = node
            .child_by_field_name("attribute")
            .and_then(|attr| node_text(attr, self.source_bytes))?;

        if let Some(module_name) = self.resolve_module_namespace(object)
            && let Some(function_id) = self
                .symbols
                .resolve_top_level_function(module_name.as_str(), attribute.as_str())
        {
            return Some(function_id);
        }

        if let Some(class_type) = self.resolve_class_expression(object)
            && let Some(function_id) = self.symbols.resolve_method(&class_type, attribute.as_str())
        {
            return Some(function_id);
        }

        None
    }

    fn resolve_module_namespace(&self, expression: Node) -> Option<String> {
        let expression = self.unwrap_expression(expression);

        match expression.kind() {
            "identifier" => {
                let name = node_text(expression, self.source_bytes)?;
                match self.lookup_binding(name.as_str()) {
                    Some(Binding::Module(module)) => Some(module),
                    Some(Binding::ImportedMember { module, member }) => {
                        let candidate = format!("{module}.{member}");
                        self.symbols
                            .modules
                            .contains(&candidate)
                            .then_some(candidate)
                    }
                    _ => None,
                }
            }
            "attribute" => {
                let object = expression.child_by_field_name("object")?;
                let attr = expression
                    .child_by_field_name("attribute")
                    .and_then(|name| node_text(name, self.source_bytes))?;

                let parent = self.resolve_module_namespace(object)?;
                let candidate = format!("{parent}.{attr}");
                self.symbols
                    .modules
                    .contains(&candidate)
                    .then_some(candidate)
            }
            _ => None,
        }
    }

    fn resolve_class_expression(&self, expression: Node) -> Option<ClassType> {
        let expression = self.unwrap_expression(expression);

        match expression.kind() {
            "identifier" => {
                let name = node_text(expression, self.source_bytes)?;

                if (name == "self" || name == "cls") && !self.class_stack.is_empty() {
                    return Some(ClassType {
                        module: self.source.module.clone(),
                        class_path: self.class_stack.join("."),
                    });
                }

                match self.lookup_binding(name.as_str()) {
                    Some(Binding::Class(class_type)) | Some(Binding::Instance(class_type)) => {
                        Some(class_type)
                    }
                    Some(Binding::ImportedMember { module, member }) => {
                        self.symbols.resolve_class(module.as_str(), member.as_str())
                    }
                    _ => None,
                }
            }
            "attribute" => {
                let object = expression.child_by_field_name("object")?;
                let attr = expression
                    .child_by_field_name("attribute")
                    .and_then(|name| node_text(name, self.source_bytes))?;

                if let Some(module_name) = self.resolve_module_namespace(object)
                    && let Some(class_type) = self
                        .symbols
                        .resolve_class(module_name.as_str(), attr.as_str())
                {
                    return Some(class_type);
                }

                if let Some(base_class) = self.resolve_class_expression(object) {
                    let nested_path = format!("{}.{}", base_class.class_path, attr);
                    return self
                        .symbols
                        .resolve_class(base_class.module.as_str(), nested_path.as_str());
                }

                None
            }
            "call" => expression
                .child_by_field_name("function")
                .and_then(|constructor| self.resolve_class_expression(constructor)),
            _ => None,
        }
    }

    fn unwrap_expression<'n>(&self, mut node: Node<'n>) -> Node<'n> {
        loop {
            match node.kind() {
                "parenthesized_expression" | "await" => {
                    let next = node
                        .child_by_field_name("argument")
                        .or_else(|| first_named_child(node));

                    if let Some(next_node) = next {
                        node = next_node;
                        continue;
                    }
                }
                _ => {}
            }

            return node;
        }
    }

    fn lookup_binding(&self, name: &str) -> Option<Binding> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.bindings.get(name).cloned())
    }

    fn bind(&mut self, name: String, binding: Binding) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.bindings.insert(name, binding);
        }
    }

    fn function_id(&self, start_line: usize) -> Option<usize> {
        let key = FunctionKey {
            path: self.source.path.clone(),
            start_line,
        };
        self.key_to_id.get(&key).copied()
    }
}

fn resolve_import_module(
    current_module: &str,
    is_package: bool,
    raw_module: &str,
) -> Option<String> {
    if !raw_module.starts_with('.') {
        return Some(raw_module.to_owned());
    }

    let level = raw_module.chars().take_while(|&ch| ch == '.').count();
    let suffix = raw_module[level..].trim_matches('.');

    let mut package_parts: Vec<&str> = current_module
        .split('.')
        .filter(|part| !part.is_empty())
        .collect();

    if !is_package {
        package_parts.pop();
    }

    if level == 0 {
        return Some(raw_module.to_owned());
    }

    let remove = level.saturating_sub(1);
    if remove > package_parts.len() {
        return None;
    }

    package_parts.truncate(package_parts.len().saturating_sub(remove));

    let mut resolved: Vec<String> = package_parts.into_iter().map(str::to_owned).collect();
    if !suffix.is_empty() {
        resolved.extend(suffix.split('.').map(str::to_owned));
    }

    Some(resolved.join("."))
}

fn class_path_with_name(class_stack: &[String], name: &str) -> String {
    if class_stack.is_empty() {
        return name.to_owned();
    }

    let mut parts = class_stack.to_vec();
    parts.push(name.to_owned());
    parts.join(".")
}

fn single_identifier(node: Node, source: &[u8]) -> Option<String> {
    (node.kind() == "identifier")
        .then(|| node_text(node, source))
        .flatten()
}

fn collect_pattern_identifiers(node: Node, source: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        "identifier" => {
            if let Some(name) = node_text(node, source) {
                out.push(name);
            }
        }
        "attribute" | "subscript" => {}
        _ => {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .for_each(|child| collect_pattern_identifiers(child, source, out));
        }
    }
}

fn collect_parameter_identifiers(node: Node, source: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        "identifier" => {
            if let Some(name) = node_text(node, source) {
                out.push(name);
            }
        }
        "default_parameter" | "typed_default_parameter" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                collect_pattern_identifiers(name_node, source, out);
            }
        }
        "typed_parameter" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                collect_pattern_identifiers(name_node, source, out);
                return;
            }

            let type_node_id = node
                .child_by_field_name("type")
                .map(|type_node| type_node.id());
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if type_node_id.is_some_and(|type_id| type_id == child.id()) {
                    continue;
                }
                collect_parameter_identifiers(child, source, out);
            }
        }
        "list_splat_pattern" | "dictionary_splat_pattern" | "tuple_pattern" => {
            collect_pattern_identifiers(node, source, out);
        }
        _ => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                collect_parameter_identifiers(child, source, out);
            }
        }
    }
}

fn first_named_child(node: Node) -> Option<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).next()
}

fn extract_name(node: Node, source: &[u8]) -> Option<String> {
    node.child_by_field_name("name")
        .and_then(|name| node_text(name, source))
}

fn node_text(node: Node, source: &[u8]) -> Option<String> {
    node.utf8_text(source).ok().map(str::to_owned)
}

fn module_name_from_path(path: &str) -> (String, bool) {
    let no_ext = path.strip_suffix(".py").unwrap_or(path);

    if no_ext == "__init__" {
        return (String::new(), true);
    }

    if let Some(prefix) = no_ext.strip_suffix("/__init__") {
        return (prefix.replace('/', "."), true);
    }

    (no_ext.replace('/', "."), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_index(files: &[(&str, &str)]) -> CallGraphIndex {
        let sources: Vec<SourceFile> = files
            .iter()
            .map(|(path, content)| {
                SourceFile::from_content((*path).to_owned(), (*content).to_owned())
            })
            .collect();

        build_index_from_loaded_sources(&sources)
    }

    fn relation_targets(items: &[FunctionRef]) -> Vec<String> {
        items
            .iter()
            .map(|item| format!("{}:{}:{}", item.path, item.start_line, item.name))
            .collect()
    }

    #[test]
    fn resolves_cross_module_import_calls() {
        let index = build_index(&[
            ("a.py", "def foo():\n    return 1\n"),
            ("b.py", "import a\n\ndef bar():\n    return a.foo()\n"),
        ]);

        let bar_rel = index.relationships_for("b.py", 2);
        assert_eq!(
            relation_targets(&bar_rel.callees),
            vec!["a.py:0:foo".to_owned()]
        );

        let foo_rel = index.relationships_for("a.py", 0);
        assert_eq!(
            relation_targets(&foo_rel.callers),
            vec!["b.py:2:bar".to_owned()]
        );
    }

    #[test]
    fn resolves_from_import_alias_calls() {
        let index = build_index(&[
            ("util.py", "def run():\n    return 1\n"),
            (
                "main.py",
                "from util import run as execute\n\ndef entry():\n    execute()\n",
            ),
        ]);

        let rel = index.relationships_for("main.py", 2);
        assert_eq!(
            relation_targets(&rel.callees),
            vec!["util.py:0:run".to_owned()]
        );
    }

    #[test]
    fn resolves_instance_method_calls_from_constructor_assignment() {
        let index = build_index(&[
            (
                "models.py",
                "class Repo:\n    def save(self):\n        return 1\n",
            ),
            (
                "service.py",
                "from models import Repo\n\ndef process():\n    repo = Repo()\n    repo.save()\n",
            ),
        ]);

        let rel = index.relationships_for("service.py", 2);
        assert_eq!(
            relation_targets(&rel.callees),
            vec!["models.py:1:save".to_owned()]
        );
    }

    #[test]
    fn resolves_nested_function_calls() {
        let index = build_index(&[(
            "nested.py",
            "def outer():\n    def inner():\n        return 1\n    inner()\n",
        )]);

        let outer_rel = index.relationships_for("nested.py", 0);
        assert_eq!(
            relation_targets(&outer_rel.callees),
            vec!["nested.py:1:inner".to_owned()]
        );

        let inner_rel = index.relationships_for("nested.py", 1);
        assert_eq!(
            relation_targets(&inner_rel.callers),
            vec!["nested.py:0:outer".to_owned()]
        );
    }

    #[test]
    fn handles_relative_import_resolution() {
        let index = build_index(&[
            ("pkg/__init__.py", ""),
            ("pkg/a.py", "def foo():\n    return 1\n"),
            ("pkg/b.py", "from .a import foo\n\ndef bar():\n    foo()\n"),
        ]);

        let rel = index.relationships_for("pkg/b.py", 2);
        assert_eq!(
            relation_targets(&rel.callees),
            vec!["pkg/a.py:0:foo".to_owned()]
        );
    }

    #[test]
    fn assignment_shadowing_prevents_false_positive_calls() {
        let index = build_index(&[
            ("util.py", "def run():\n    return 1\n"),
            (
                "main.py",
                "from util import run\n\ndef caller():\n    run = lambda: None\n    run()\n",
            ),
        ]);

        let rel = index.relationships_for("main.py", 2);
        assert!(rel.callees.is_empty());
    }

    #[test]
    fn decorated_functions_use_decorator_start_line_keys() {
        let index = build_index(&[
            ("decorated.py", "@cache\ndef target():\n    return 1\n"),
            (
                "main.py",
                "from decorated import target\n\ndef caller():\n    target()\n",
            ),
        ]);

        let rel = index.relationships_for("decorated.py", 0);
        assert_eq!(
            relation_targets(&rel.callers),
            vec!["main.py:2:caller".to_owned()]
        );
    }

    #[test]
    fn handles_large_projects_without_explosive_growth() {
        let mut files = Vec::new();
        let file_count = 300usize;

        (0..file_count).for_each(|i| {
            files.push((
                format!("module_{i}.py"),
                format!("def f_{i}():\n    return {i}\n\ndef g_{i}():\n    return f_{i}()\n"),
            ));
        });

        let sources: Vec<(&str, &str)> = files
            .iter()
            .map(|(path, content)| (path.as_str(), content.as_str()))
            .collect();

        let index = build_index(&sources);

        (0..file_count).for_each(|i| {
            let file = format!("module_{i}.py");
            let rel = index.relationships_for(file.as_str(), 3);
            assert_eq!(rel.callees.len(), 1);
        });
    }
}
