use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::server_auth::{authenticate_first_request, TransportCapability};
use super::server_workspace::verify_prepared_workspace_at;

const CAPABILITY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[tokio::test]
async fn valid_private_envelope_is_removed_without_changing_the_request() {
    let request = r#"{ "jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {}, "params": {"duplicate":true} }"#;
    let second = r#"{"jsonrpc":"2.0","id":8,"method":"get","params":{}}"#;
    let mut wire = format!(
        r#"{{"_zeroshotOecpTransport":{{"capability":"{CAPABILITY}"}},"request":{request}}}"#
    )
    .into_bytes();
    wire.push(b'\n');
    wire.extend_from_slice(second.as_bytes());
    wire.push(b'\n');
    let capability = TransportCapability::parse(CAPABILITY.as_bytes()).expect("valid capability");
    let mut reader = std::io::Cursor::new(wire);

    let authenticated = authenticate_first_request(&mut reader, &capability)
        .await
        .expect("valid envelope authenticates");

    assert_eq!(authenticated, format!("{request}\n{second}\n").into_bytes());
}

#[tokio::test]
async fn missing_or_wrong_capability_fails_before_request_forwarding() {
    let capability = TransportCapability::parse(CAPABILITY.as_bytes()).expect("valid capability");
    for wire in [
        format!(
            "{}\n",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#
        ),
        format!(
            "{}\n",
            r#"{"_zeroshotOecpTransport":{"capability":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},"request":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}}"#
        ),
        format!(
            "{}\n",
            r#"{"_zeroshotOecpTransport":{"capability":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","extra":true},"request":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}}"#
        ),
    ] {
        let mut reader = std::io::Cursor::new(wire.into_bytes());
        assert!(
            authenticate_first_request(&mut reader, &capability)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn browser_http_and_websocket_prefaces_fail_closed() {
    let capability = TransportCapability::parse(CAPABILITY.as_bytes()).expect("valid capability");
    for preface in [
        b"GET /oecp HTTP/1.1\r\nHost: capsule\r\nUpgrade: websocket\r\n\r\n".as_slice(),
        b"POST /oecp HTTP/1.1\r\nHost: capsule\r\nOrigin: https://attacker.example\r\n\r\n"
            .as_slice(),
        b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".as_slice(),
    ] {
        let mut reader = std::io::Cursor::new(preface);
        assert!(
            authenticate_first_request(&mut reader, &capability)
                .await
                .is_err()
        );
    }
}

#[test]
fn readiness_rejects_a_workspace_file_with_an_existing_hard_link() {
    let fixture = Fixture::new("readiness-hardlink");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    let file = workspace.join("source.txt");
    fs::write(&file, b"prepared").expect("workspace file");
    fs::hard_link(&file, fixture.directory().join("outside-link"))
        .expect("create external hard link");

    assert!(verify_prepared_workspace_at(&workspace).is_err());
}

#[test]
fn verification_after_the_initial_scan_rejects_a_new_hard_link() {
    let fixture = Fixture::new("post-scan-link");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    let file = workspace.join("source.txt");
    fs::write(&file, b"prepared").expect("workspace file");
    verify_prepared_workspace_at(&workspace).expect("initial workspace is safe");

    fs::hard_link(&file, fixture.directory().join("late-link"))
        .expect("create link after initial scan");

    assert!(verify_prepared_workspace_at(&workspace).is_err());
}

#[test]
fn verification_after_the_initial_scan_rejects_a_hard_link_swap() {
    let fixture = Fixture::new("post-scan-swap");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    let destination = workspace.join("source.txt");
    fs::write(&destination, b"prepared").expect("workspace file");
    verify_prepared_workspace_at(&workspace).expect("initial workspace is safe");

    let outside = fixture.directory().join("outside.txt");
    fs::write(&outside, b"outside authority").expect("outside file");
    let replacement = workspace.join("replacement.txt");
    fs::hard_link(&outside, &replacement).expect("hard-link replacement into workspace");
    fs::rename(&replacement, &destination).expect("swap hard link over scanned path");

    assert!(verify_prepared_workspace_at(&workspace).is_err());
}

struct Fixture {
    directory: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let directory = std::env::temp_dir().join(format!(
            "zeroshot-hosted-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).expect("fixture directory");
        Self { directory }
    }

    fn directory(&self) -> &Path {
        &self.directory
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
