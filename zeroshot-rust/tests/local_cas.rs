use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_protocol::{ArtifactRef, MediaType};
use tokio::io::AsyncReadExt;
use zeroshot_engine::artifact_store::local_cas::LocalCasArtifactStore;
use zeroshot_engine::artifact_store::{ArtifactStore, ArtifactStoreFailureKind, ReleaseResult};

#[path = "support/artifacts.rs"]
mod artifacts;
#[path = "support/assert_value.rs"]
mod assert_value;
#[path = "local_cas/recovery.rs"]
mod recovery;

use artifacts::{byte_stream as stream, test_intent as intent};
use assert_value::{AssertError, AssertValue};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot(PathBuf);

impl TestRoot {
    fn new(label: &str) -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        Self(std::env::temp_dir().join(format!(
            "zeroshot-local-cas-{label}-{}-{sequence}",
            std::process::id()
        )))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn blob_path(root: &Path, artifact_ref: &ArtifactRef) -> PathBuf {
    let digest = artifact_ref.sha256.as_str();
    root.join("blobs/sha256")
        .join(digest.get(..2).assert_value())
        .join(digest)
}

fn ref_path(root: &Path, artifact_ref: &ArtifactRef) -> PathBuf {
    root.join("refs")
        .join(format!("{}.json", artifact_ref.artifact_id.as_str()))
}

#[tokio::test]
async fn one_writer_lock_is_shared_only_by_clones() {
    let root = TestRoot::new("lock");
    let store =
        LocalCasArtifactStore::new(root.path()).assert_value_with("first writer locks root");
    let clone = store.clone();
    let failure =
        LocalCasArtifactStore::new(root.path()).assert_error_with("independent writer must fail");
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::LockUnavailable);

    let staged = clone
        .stage(intent(b"clone", "clone"), stream(b"clone".to_vec()))
        .await
        .assert_value_with("clone shares writer");
    clone
        .publish(&staged)
        .await
        .assert_value_with("clone publishes");
    drop(store);
    let failure =
        LocalCasArtifactStore::new(root.path()).assert_error_with("clone must retain the lock");
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::LockUnavailable);
    drop(clone);
    LocalCasArtifactStore::new(root.path()).assert_value_with("lock releases with final clone");
}

#[test]
fn startup_removes_only_regular_abandoned_stages() {
    let root = TestRoot::new("cleanup");
    std::fs::create_dir_all(root.path().join("staging"))
        .assert_value_with("create staging directory");
    std::fs::write(root.path().join("staging/abandoned.tmp"), b"partial")
        .assert_value_with("write abandoned stage");
    let _store =
        LocalCasArtifactStore::new(root.path()).assert_value_with("startup cleanup succeeds");
    assert_eq!(
        std::fs::read_dir(root.path().join("staging"))
            .assert_value_with("read staging directory")
            .count(),
        0
    );
}

#[tokio::test]
async fn publish_is_synchronized_atomic_and_independent_of_source_directory() {
    let root = TestRoot::new("atomic");
    let source = root.path().with_extension("source");
    std::fs::create_dir(&source).assert_value_with("create source directory");
    let source_file = source.join("artifact.bin");
    let bytes = b"workspace-independent artifact".to_vec();
    std::fs::write(&source_file, &bytes).assert_value_with("write source artifact");
    let input = tokio::fs::File::open(&source_file)
        .await
        .assert_value_with("open source artifact");

    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let staged = store
        .stage(intent(&bytes, "source-removal"), Box::new(input))
        .await
        .assert_value_with("stage source artifact");
    std::fs::remove_dir_all(&source).assert_value_with("remove producing workspace");
    let artifact_ref = store
        .publish(&staged)
        .await
        .assert_value_with("publish staged bytes");
    assert_eq!(
        store
            .publish(&staged)
            .await
            .assert_value_with("publish retry is idempotent"),
        artifact_ref
    );

    let mut opened = store
        .open(&artifact_ref.artifact_id)
        .await
        .assert_value_with("open committed artifact");
    let mut actual = Vec::new();
    opened
        .read_to_end(&mut actual)
        .await
        .assert_value_with("read verified stream");
    assert_eq!(actual, bytes);
    assert!(blob_path(root.path(), &artifact_ref).is_file());
    assert!(ref_path(root.path(), &artifact_ref).is_file());
    assert_eq!(
        std::fs::read_dir(root.path().join("staging"))
            .assert_value_with("read staging")
            .count(),
        0
    );
    assert!(
        std::fs::read_dir(root.path().join("refs"))
            .assert_value_with("read refs")
            .all(|entry| entry
                .assert_value_with("read ref entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".json"))
    );
}

#[tokio::test]
async fn open_and_inspect_reject_truncated_modified_missing_and_conflicting_content() {
    let root = TestRoot::new("corruption");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let bytes = b"verified bytes".to_vec();
    let staged = store
        .stage(intent(&bytes, "corruption"), stream(bytes.clone()))
        .await
        .assert_value_with("stage succeeds");
    let artifact_ref = store
        .publish(&staged)
        .await
        .assert_value_with("publish succeeds");
    let blob = blob_path(root.path(), &artifact_ref);
    let manifest = ref_path(root.path(), &artifact_ref);

    std::fs::write(&blob, bytes.get(..3).assert_value()).assert_value_with("truncate blob");
    let failure = store
        .open(&artifact_ref.artifact_id)
        .await
        .assert_error_with("truncated blob must fail");
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
    let mut modified = bytes.clone();
    *modified.first_mut().assert_value() ^= 0xff;
    std::fs::write(&blob, &modified).assert_value_with("modify blob");
    assert_eq!(
        store
            .inspect(&artifact_ref.artifact_id)
            .await
            .assert_error_with("modified blob must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    std::fs::remove_file(&blob).assert_value_with("remove blob");
    let failure = store
        .open(&artifact_ref.artifact_id)
        .await
        .assert_error_with("missing blob must fail");
    assert_eq!(
        failure.kind(),
        ArtifactStoreFailureKind::MissingCommittedContent
    );

    std::fs::remove_dir(blob.parent().assert_value_with("blob prefix exists"))
        .assert_value_with("remove empty blob prefix");
    let failure = store
        .open(&artifact_ref.artifact_id)
        .await
        .assert_error_with("missing blob prefix must fail");
    assert_eq!(
        failure.kind(),
        ArtifactStoreFailureKind::MissingCommittedContent
    );

    std::fs::create_dir(blob.parent().assert_value_with("blob prefix exists"))
        .assert_value_with("restore blob prefix");
    std::fs::write(&blob, &bytes).assert_value_with("restore blob");
    let mut conflicting = artifact_ref.clone();
    conflicting.media_type =
        MediaType::new("application/conflict").assert_value_with("media type is valid");
    std::fs::write(
        &manifest,
        serde_json::to_vec(&conflicting).assert_value_with("encode conflicting manifest"),
    )
    .assert_value_with("replace manifest");
    assert_eq!(
        store
            .inspect(&artifact_ref.artifact_id)
            .await
            .assert_error_with("identity-conflicting manifest must fail")
            .kind(),
        ArtifactStoreFailureKind::IdentityConflict
    );
}

#[tokio::test]
async fn conflicting_blob_is_rejected_before_manifest_publication() {
    let root = TestRoot::new("blob-conflict");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let bytes = b"expected bytes".to_vec();
    let artifact_intent = intent(&bytes, "blob-conflict");
    let projected = artifact_intent.artifact_ref().assert_value();
    let blob = blob_path(root.path(), &projected);
    std::fs::create_dir_all(blob.parent().assert_value_with("blob parent exists"))
        .assert_value_with("create blob prefix");
    std::fs::write(&blob, b"wrong content!").assert_value_with("write conflicting blob");
    let staged = store
        .stage(artifact_intent, stream(bytes))
        .await
        .assert_value_with("stage succeeds");
    assert_eq!(
        store
            .publish(&staged)
            .await
            .assert_error_with("conflicting blob must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    assert!(!ref_path(root.path(), &projected).exists());
}

#[tokio::test]
async fn lineage_refs_share_bytes_until_the_last_release() {
    let root = TestRoot::new("release");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let bytes = b"shared local bytes".to_vec();
    let first = store
        .stage(intent(&bytes, "one"), stream(bytes.clone()))
        .await
        .assert_value_with("first stage succeeds");
    let first_ref = store
        .publish(&first)
        .await
        .assert_value_with("first publish succeeds");
    let second = store
        .stage(intent(&bytes, "two"), stream(bytes))
        .await
        .assert_value_with("second stage succeeds");
    let second_ref = store
        .publish(&second)
        .await
        .assert_value_with("second publish succeeds");
    let blob = blob_path(root.path(), &first_ref);
    assert_eq!(blob, blob_path(root.path(), &second_ref));

    assert_eq!(
        store
            .release(&first_ref.artifact_id)
            .await
            .assert_value_with("first release succeeds"),
        ReleaseResult::Released
    );
    assert!(blob.is_file());
    assert!(
        store
            .inspect(&second_ref.artifact_id)
            .await
            .assert_value_with("remaining ref inspects")
            .is_some()
    );
    assert_eq!(
        store
            .release(&second_ref.artifact_id)
            .await
            .assert_value_with("last release succeeds"),
        ReleaseResult::Released
    );
    assert!(!blob.exists());
    assert_eq!(
        store
            .release(&second_ref.artifact_id)
            .await
            .assert_value_with("release retry succeeds"),
        ReleaseResult::NotFound
    );
}

#[cfg(unix)]
#[test]
fn startup_rejects_symlink_and_non_regular_entries() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new("symlink-startup");
    let target = root.path().with_extension("target");
    std::fs::create_dir(&target).assert_value_with("create symlink target");
    symlink(&target, root.path()).assert_value_with("create root symlink");
    let failure =
        LocalCasArtifactStore::new(root.path()).assert_error_with("symlink root must fail");
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
    std::fs::remove_file(root.path()).assert_value_with("remove root symlink");
    std::fs::remove_dir(&target).assert_value_with("remove symlink target");

    std::fs::create_dir_all(root.path().join("staging/non-regular"))
        .assert_value_with("create non-regular stage entry");
    let failure = LocalCasArtifactStore::new(root.path())
        .assert_error_with("non-regular stage entry must fail");
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
}

#[cfg(unix)]
#[tokio::test]
async fn publish_and_inspect_reject_symlink_entries() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new("symlink-runtime");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let bytes = b"symlink protected".to_vec();
    let artifact_intent = intent(&bytes, "symlink");
    let projected = artifact_intent.artifact_ref().assert_value();
    let staged = store
        .stage(artifact_intent, stream(bytes.clone()))
        .await
        .assert_value_with("stage succeeds");
    let blob = blob_path(root.path(), &projected);
    std::fs::create_dir_all(blob.parent().assert_value_with("blob parent exists"))
        .assert_value_with("create blob parent");
    let target = root.path().join("target.bin");
    std::fs::write(&target, &bytes).assert_value_with("write target");
    symlink(&target, &blob).assert_value_with("create blob symlink");
    assert_eq!(
        store
            .publish(&staged)
            .await
            .assert_error_with("blob symlink must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    std::fs::remove_file(&blob).assert_value_with("remove blob symlink");
    let artifact_ref = store
        .publish(&staged)
        .await
        .assert_value_with("publish after repair");
    let manifest = ref_path(root.path(), &artifact_ref);
    std::fs::remove_file(&manifest).assert_value_with("remove manifest");
    symlink(&target, &manifest).assert_value_with("create manifest symlink");
    assert_eq!(
        store
            .inspect(&artifact_ref.artifact_id)
            .await
            .assert_error_with("manifest symlink must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
}

#[cfg(unix)]
#[tokio::test]
async fn inspect_and_open_reject_symlinked_blob_prefix_directory() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new("symlink-prefix");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let bytes = b"prefix protected".to_vec();
    let staged = store
        .stage(intent(&bytes, "symlink-prefix"), stream(bytes.clone()))
        .await
        .assert_value_with("stage succeeds");
    let artifact_ref = store
        .publish(&staged)
        .await
        .assert_value_with("publish succeeds");
    let prefix = blob_path(root.path(), &artifact_ref)
        .parent()
        .assert_value_with("blob prefix exists")
        .to_path_buf();
    drop(store);

    let displaced = root.path().join("displaced-prefix");
    std::fs::rename(&prefix, &displaced).assert_value_with("displace blob prefix");
    symlink(&displaced, &prefix).assert_value_with("replace blob prefix with symlink");
    let reopened = LocalCasArtifactStore::new(root.path()).assert_value_with("reopen local CAS");

    assert_eq!(
        reopened
            .inspect(&artifact_ref.artifact_id)
            .await
            .assert_error_with("inspect must reject a symlinked blob prefix")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    let failure = reopened
        .open(&artifact_ref.artifact_id)
        .await
        .assert_error_with("open must reject a symlinked blob prefix");
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
}

#[cfg(unix)]
#[tokio::test]
async fn local_layout_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let root = TestRoot::new("permissions");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let staged = store
        .stage(
            intent(b"private", "permissions"),
            stream(b"private".to_vec()),
        )
        .await
        .assert_value_with("stage succeeds");
    let artifact_ref = store
        .publish(&staged)
        .await
        .assert_value_with("publish succeeds");
    for directory in [
        root.path().to_path_buf(),
        root.path().join("staging"),
        root.path().join("blobs"),
        root.path().join("blobs/sha256"),
        blob_path(root.path(), &artifact_ref)
            .parent()
            .assert_value_with("blob parent exists")
            .to_path_buf(),
        root.path().join("refs"),
    ] {
        assert_eq!(
            std::fs::metadata(directory)
                .assert_value_with("directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    for file in [
        root.path().join("store.lock"),
        blob_path(root.path(), &artifact_ref),
        ref_path(root.path(), &artifact_ref),
    ] {
        assert_eq!(
            std::fs::metadata(file)
                .assert_value_with("file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
