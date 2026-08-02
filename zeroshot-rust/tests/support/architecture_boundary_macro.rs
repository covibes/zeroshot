/// Silences unused-export warnings for a single-test boundary file that only calls
/// `product_root`/`read` directly from `support/architecture.rs`. `$module` is the local
/// `mod` binding for that support file.
macro_rules! suppress_single_test_boundary_unused_exports {
    ($module:ident) => {
        const _: fn() -> std::path::PathBuf = $module::repository_root;
        const _: fn(&std::path::Path, &std::path::Path, &mut std::collections::BTreeSet<String>) =
            $module::relative_files;
        const _: fn() -> serde_json::Value = $module::workspace_metadata;
        const _: for<'a> fn(&'a serde_json::Value) -> &'a serde_json::Value =
            $module::product_package;
        const _: fn() -> String = $module::runtime_source;
        const _: fn(&[&str]) -> String = $module::rust_sources;
    };
}
pub(crate) use suppress_single_test_boundary_unused_exports;
