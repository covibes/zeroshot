/// Silences unused-export warnings for a single-test boundary file that only calls an
/// arbitrary subset of `support/architecture.rs` helpers directly. `$module` is the local
/// `mod` binding for that support file; `$name` lists every OTHER export the file does not
/// call. Each export gets a type-annotated `const _: ... = $module::$name;` (a repo-wide
/// dead-code-suppression attribute is disallowed here) naming that export's exact signature
/// once here, so call sites stay a plain list of identifiers.
macro_rules! suppress_unused_architecture_exports {
    ($module:ident, $($name:ident),+ $(,)?) => {
        $($crate::architecture_boundary_macro::suppress_unused_architecture_exports!(@one $module, $name);)+
    };
    (@one $module:ident, product_root) => {
        const _: fn() -> std::path::PathBuf = $module::product_root;
    };
    (@one $module:ident, repository_root) => {
        const _: fn() -> std::path::PathBuf = $module::repository_root;
    };
    (@one $module:ident, read) => {
        const _: fn(&std::path::Path) -> String = $module::read;
    };
    (@one $module:ident, relative_files) => {
        const _: fn(&std::path::Path, &std::path::Path, &mut std::collections::BTreeSet<String>) =
            $module::relative_files;
    };
    (@one $module:ident, workspace_metadata) => {
        const _: fn() -> serde_json::Value = $module::workspace_metadata;
    };
    (@one $module:ident, product_package) => {
        const _: for<'a> fn(&'a serde_json::Value) -> &'a serde_json::Value =
            $module::product_package;
    };
    (@one $module:ident, runtime_source) => {
        const _: fn() -> String = $module::runtime_source;
    };
    (@one $module:ident, rust_sources) => {
        const _: fn(&[&str]) -> String = $module::rust_sources;
    };
}
pub(crate) use suppress_unused_architecture_exports;
