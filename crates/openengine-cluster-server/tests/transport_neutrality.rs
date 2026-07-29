use std::fs;
use std::path::{Path, PathBuf};

fn rust_sources_under(path: &Path) -> Vec<PathBuf> {
    if path.is_file() {
        return (path.extension().and_then(|extension| extension.to_str()) == Some("rs"))
            .then(|| path.to_owned())
            .into_iter()
            .collect();
    }

    let mut sources = Vec::new();
    for entry in fs::read_dir(path).expect("source directory must be readable") {
        let entry = entry.expect("source directory entry must be readable");
        let entry_path = entry.path();
        if entry_path.is_dir() {
            sources.extend(rust_sources_under(&entry_path));
        } else if entry_path
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("rs")
        {
            sources.push(entry_path);
        }
    }
    sources
}

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn connection_core_contains_no_transport_binding_tokens() {
    let root = crate_root();
    let mut sources = rust_sources_under(&root.join("src/connection.rs"));
    sources.extend(rust_sources_under(&root.join("src/connection")));

    for source_path in sources {
        let source = fs::read_to_string(&source_path).expect("connection source must be readable");
        for banned in ["LinesCodec", "Framed", "serve_ndjson", "stdin", "stdio"] {
            assert!(
                !source.contains(banned),
                "{} contains transport-specific token {banned:?}",
                source_path.display()
            );
        }
    }
}

#[test]
fn websocket_does_not_depend_on_stdio_module() {
    let path = crate_root().join("src/websocket.rs");
    let source = fs::read_to_string(&path).expect("WebSocket source must be readable");

    assert!(
        !source.contains("crate::stdio"),
        "{} must depend on the connection core, not the stdio module",
        path.display()
    );
}

#[test]
fn stdio_module_references_are_confined_to_authorized_sources() {
    let root = crate_root();
    let allowed = [
        root.join("src/stdio.rs"),
        root.join("src/lib.rs"),
        root.join("src/watch/fixtures.rs"),
    ];

    for source_path in rust_sources_under(&root.join("src")) {
        let source = fs::read_to_string(&source_path).expect("crate source must be readable");
        assert!(
            !source.contains("crate::stdio") || allowed.contains(&source_path),
            "{} contains an unauthorized crate::stdio reference",
            source_path.display()
        );
    }
}
