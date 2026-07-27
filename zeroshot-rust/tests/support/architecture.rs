use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

pub fn product_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn repository_root() -> PathBuf {
    product_root()
        .parent()
        .expect("product crate must be a root workspace member")
        .to_path_buf()
}

pub fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

pub fn relative_files(root: &Path, directory: &Path, output: &mut BTreeSet<String>) {
    for entry in fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("read directory {}: {error}", directory.display()))
    {
        let entry = entry.expect("directory entry must be readable");
        let path = entry.path();
        if path.is_dir() {
            relative_files(root, &path, output);
        } else {
            output.insert(
                path.strip_prefix(root)
                    .expect("file must be under product root")
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

pub fn workspace_metadata() -> Value {
    let root = repository_root();
    let output = Command::new("cargo")
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .current_dir(root)
        .output()
        .expect("cargo metadata must run");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("cargo metadata must emit JSON")
}

pub fn product_package(metadata: &Value) -> &Value {
    metadata["packages"]
        .as_array()
        .expect("metadata packages must be an array")
        .iter()
        .find(|package| package["name"] == "zeroshot-rust")
        .expect("workspace must contain zeroshot-rust")
}

pub fn runtime_source() -> String {
    let product = product_root();
    format!(
        "{}\n{}",
        read(&product.join("src/lib.rs")),
        read(&product.join("src/main.rs"))
    )
}

pub fn rust_sources(relative_roots: &[&str]) -> String {
    let product = product_root();
    let mut files = BTreeSet::new();
    for relative_root in relative_roots {
        let path = product.join(relative_root);
        if path.is_dir() {
            relative_files(&product, &path, &mut files);
        } else {
            files.insert((*relative_root).to_owned());
        }
    }
    files
        .into_iter()
        .map(|path| read(&product.join(path)))
        .collect::<Vec<_>>()
        .join("\n")
}
