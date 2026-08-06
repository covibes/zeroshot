use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use openengine_cluster_protocol::{Generation, RunId, WorkerOutcome};
use serde_json::{json, Value};

use super::server_auth::{authenticate_first_request, TransportCapability};
use super::server_workspace::{verify_delivery_workspace_at, verify_prepared_workspace_at};
use super::server::InlineDirtyDelivery;
use super::server_transport::{SEQUENTIAL_FINALIZATION_BOUND, SHUTDOWN_DEADLINE};
use super::ports::DeliveryIntent;

const CAPABILITY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[test]
fn shutdown_deadline_exceeds_every_sequential_finalization_stage() {
    assert_eq!(SEQUENTIAL_FINALIZATION_BOUND, Duration::from_secs(31));
    assert!(SHUTDOWN_DEADLINE > SEQUENTIAL_FINALIZATION_BOUND);
}

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

#[cfg(unix)]
#[test]
fn readiness_accepts_repository_metadata_and_contained_relative_symlinks() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new("repository-metadata");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    fs::create_dir(workspace.join(".git")).expect("git metadata directory");
    fs::write(workspace.join(".git/config"), b"[core]\n").expect("git metadata");
    symlink(".", workspace.join("hooks")).expect("contained source symlink");

    verify_prepared_workspace_at(&workspace).expect("cloned repository is safe");
}

#[cfg(unix)]
#[test]
fn readiness_rejects_a_relative_symlink_that_escapes_the_workspace() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new("escaping-symlink");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    symlink("../outside", workspace.join("escape")).expect("escaping source symlink");

    assert!(verify_prepared_workspace_at(&workspace).is_err());
}

#[test]
fn killed_atomic_write_orphan_is_removed_before_delivery_verification() {
    let fixture = Fixture::new("killed-write-orphan");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    let orphan = workspace.join(".zeroshot-write-4242-01234567-89ab-cdef-0123-456789abcdef");
    fs::write(&orphan, b"partial content from killed writer").expect("orphaned temp file");

    verify_delivery_workspace_at(&workspace)
        .expect("post-tree-death verification removes the reserved orphan");

    assert!(!orphan.exists());
    assert_eq!(
        fs::read_dir(&workspace)
            .expect("verified workspace")
            .count(),
        0,
        "reserved write orphan must not reach trusted delivery"
    );
}

#[test]
fn inline_delivery_accepts_only_canonical_fixed_repository_receipts() {
    let base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let delivery = InlineDirtyDelivery::new("the-open-engine/private-repository", base);
    let valid = ship_intent(json!({
        "status": "succeeded",
        "summary": "completed",
        "artifacts": [],
        "repository": "the-open-engine/private-repository",
        "branch": "zeroshot/hosted-79ec8f94d0ce096bb4a8",
        "headRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "pullRequestUrl": "https://github.com/the-open-engine/private-repository/pull/17"
    }));
    assert_eq!(
        delivery.validate(&valid).expect("canonical receipt"),
        "https://github.com/the-open-engine/private-repository/pull/17"
    );

    for output in [
        json!({
            "status": "succeeded", "summary": "completed", "artifacts": [],
            "repository": "attacker/repository",
            "branch": "zeroshot/hosted-79ec8f94d0ce096bb4a8",
            "headRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "pullRequestUrl": "https://github.com/attacker/repository/pull/17"
        }),
        json!({
            "status": "succeeded", "summary": "completed", "artifacts": [],
            "repository": "the-open-engine/private-repository",
            "branch": "zeroshot/hosted-0123456789abcdefabcd",
            "headRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "pullRequestUrl": "https://github.com/the-open-engine/private-repository/pull/17"
        }),
        json!({
            "status": "succeeded", "summary": "completed", "artifacts": [],
            "repository": "the-open-engine/private-repository",
            "branch": "zeroshot/hosted-79ec8f94d0ce096bb4a8",
            "headRevision": base,
            "pullRequestUrl": "https://github.com/the-open-engine/private-repository/pull/17"
        }),
        json!({
            "status": "succeeded", "summary": "completed", "artifacts": [],
            "repository": "the-open-engine/private-repository",
            "branch": "zeroshot/hosted-79ec8f94d0ce096bb4a8",
            "headRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "pullRequestUrl": "https://evil.example/pull/17"
        }),
        json!({
            "status": "failed", "summary": "failed", "artifacts": [],
            "repository": null, "branch": null, "headRevision": null, "pullRequestUrl": null
        }),
    ] {
        assert!(delivery.validate(&ship_intent(output)).is_err());
    }
}

fn ship_intent(output: Value) -> DeliveryIntent {
    DeliveryIntent::new(
        Generation::new(1).expect("generation"),
        RunId::new("hosted-run-receipt"),
        "hosted-cluster-receipt",
        &WorkerOutcome::Verified {
            output,
            artifacts: Vec::new(),
        },
    )
    .expect("delivery intent")
}

#[test]
fn preflight_rejects_and_preserves_a_preexisting_reserved_temp_name() {
    let fixture = Fixture::new("preexisting-write-name");
    let workspace = fixture.directory().join("workspace");
    fs::create_dir(&workspace).expect("workspace directory");
    let reserved = workspace.join(".zeroshot-write-4242-fedcba98-7654-3210-fedc-ba9876543210");
    fs::write(&reserved, b"prepared repository content").expect("reserved source file");

    assert!(verify_prepared_workspace_at(&workspace).is_err());
    assert_eq!(
        fs::read(&reserved).expect("preflight must preserve source content"),
        b"prepared repository content"
    );
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
