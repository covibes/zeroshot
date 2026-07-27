use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use openengine_cluster_protocol::{ArtifactRef, MediaType};
use tokio::io::AsyncReadExt;
use zeroshot_engine::artifact_store::local_cas::LocalCasArtifactStore;
use zeroshot_engine::artifact_store::{ArtifactStore, ArtifactStoreFailureKind, ReleaseResult};

#[path = "support/artifacts.rs"]
mod artifacts;
#[path = "local_cas/recovery.rs"]
mod recovery;

use artifacts::{byte_stream as stream, test_intent as intent};

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
    root.join("blobs/sha256").join(&digest[..2]).join(digest)
}

fn ref_path(root: &Path, artifact_ref: &ArtifactRef) -> PathBuf {
    root.join("refs")
        .join(format!("{}.json", artifact_ref.artifact_id.as_str()))
}

#[tokio::test]
async fn one_writer_lock_is_shared_only_by_clones() {
    let root = TestRoot::new("lock");
    let store = LocalCasArtifactStore::new(root.path()).expect("first writer locks root");
    let clone = store.clone();
    let failure = match LocalCasArtifactStore::new(root.path()) {
        Ok(_) => panic!("independent writer must fail"),
        Err(failure) => failure,
    };
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::LockUnavailable);

    let staged = clone
        .stage(intent(b"clone", "clone"), stream(b"clone".to_vec()))
        .await
        .expect("clone shares writer");
    clone.publish(&staged).await.expect("clone publishes");
    drop(store);
    let failure = match LocalCasArtifactStore::new(root.path()) {
        Ok(_) => panic!("clone must retain the lock"),
        Err(failure) => failure,
    };
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::LockUnavailable);
    drop(clone);
    LocalCasArtifactStore::new(root.path()).expect("lock releases with final clone");
}

#[test]
fn startup_removes_only_regular_abandoned_stages() {
    let root = TestRoot::new("cleanup");
    std::fs::create_dir_all(root.path().join("staging")).expect("create staging directory");
    std::fs::write(root.path().join("staging/abandoned.tmp"), b"partial")
        .expect("write abandoned stage");
    let _store = LocalCasArtifactStore::new(root.path()).expect("startup cleanup succeeds");
    assert_eq!(
        std::fs::read_dir(root.path().join("staging"))
            .expect("read staging directory")
            .count(),
        0
    );
}

#[tokio::test]
async fn publish_is_synchronized_atomic_and_independent_of_source_directory() {
    let root = TestRoot::new("atomic");
    let source = root.path().with_extension("source");
    std::fs::create_dir(&source).expect("create source directory");
    let source_file = source.join("artifact.bin");
    let bytes = b"workspace-independent artifact".to_vec();
    std::fs::write(&source_file, &bytes).expect("write source artifact");
    let input = tokio::fs::File::open(&source_file)
        .await
        .expect("open source artifact");

    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let staged = store
        .stage(intent(&bytes, "source-removal"), Box::new(input))
        .await
        .expect("stage source artifact");
    std::fs::remove_dir_all(&source).expect("remove producing workspace");
    let artifact_ref = store.publish(&staged).await.expect("publish staged bytes");
    assert_eq!(
        store
            .publish(&staged)
            .await
            .expect("publish retry is idempotent"),
        artifact_ref
    );

    let mut opened = store
        .open(&artifact_ref.artifact_id)
        .await
        .expect("open committed artifact");
    let mut actual = Vec::new();
    opened
        .read_to_end(&mut actual)
        .await
        .expect("read verified stream");
    assert_eq!(actual, bytes);
    assert!(blob_path(root.path(), &artifact_ref).is_file());
    assert!(ref_path(root.path(), &artifact_ref).is_file());
    assert_eq!(
        std::fs::read_dir(root.path().join("staging"))
            .expect("read staging")
            .count(),
        0
    );
    assert!(
        std::fs::read_dir(root.path().join("refs"))
            .expect("read refs")
            .all(|entry| entry
                .expect("read ref entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".json"))
    );
}

#[tokio::test]
async fn open_and_inspect_reject_truncated_modified_missing_and_conflicting_content() {
    let root = TestRoot::new("corruption");
    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let bytes = b"verified bytes".to_vec();
    let staged = store
        .stage(intent(&bytes, "corruption"), stream(bytes.clone()))
        .await
        .expect("stage succeeds");
    let artifact_ref = store.publish(&staged).await.expect("publish succeeds");
    let blob = blob_path(root.path(), &artifact_ref);
    let manifest = ref_path(root.path(), &artifact_ref);

    std::fs::write(&blob, &bytes[..3]).expect("truncate blob");
    let failure = match store.open(&artifact_ref.artifact_id).await {
        Ok(_) => panic!("truncated blob must fail"),
        Err(failure) => failure,
    };
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
    let mut modified = bytes.clone();
    modified[0] ^= 0xff;
    std::fs::write(&blob, &modified).expect("modify blob");
    assert_eq!(
        store
            .inspect(&artifact_ref.artifact_id)
            .await
            .expect_err("modified blob must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    std::fs::remove_file(&blob).expect("remove blob");
    let failure = match store.open(&artifact_ref.artifact_id).await {
        Ok(_) => panic!("missing blob must fail"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind(),
        ArtifactStoreFailureKind::MissingCommittedContent
    );

    std::fs::remove_dir(blob.parent().expect("blob prefix exists"))
        .expect("remove empty blob prefix");
    let failure = match store.open(&artifact_ref.artifact_id).await {
        Ok(_) => panic!("missing blob prefix must fail"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind(),
        ArtifactStoreFailureKind::MissingCommittedContent
    );

    std::fs::create_dir(blob.parent().expect("blob prefix exists")).expect("restore blob prefix");
    std::fs::write(&blob, &bytes).expect("restore blob");
    let mut conflicting = artifact_ref.clone();
    conflicting.media_type = MediaType::new("application/conflict").expect("media type is valid");
    std::fs::write(
        &manifest,
        serde_json::to_vec(&conflicting).expect("encode conflicting manifest"),
    )
    .expect("replace manifest");
    assert_eq!(
        store
            .inspect(&artifact_ref.artifact_id)
            .await
            .expect_err("identity-conflicting manifest must fail")
            .kind(),
        ArtifactStoreFailureKind::IdentityConflict
    );
}

#[tokio::test]
async fn conflicting_blob_is_rejected_before_manifest_publication() {
    let root = TestRoot::new("blob-conflict");
    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let bytes = b"expected bytes".to_vec();
    let artifact_intent = intent(&bytes, "blob-conflict");
    let projected = artifact_intent.artifact_ref();
    let blob = blob_path(root.path(), &projected);
    std::fs::create_dir_all(blob.parent().expect("blob parent exists"))
        .expect("create blob prefix");
    std::fs::write(&blob, b"wrong content!").expect("write conflicting blob");
    let staged = store
        .stage(artifact_intent, stream(bytes))
        .await
        .expect("stage succeeds");
    assert_eq!(
        store
            .publish(&staged)
            .await
            .expect_err("conflicting blob must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    assert!(!ref_path(root.path(), &projected).exists());
}

#[tokio::test]
async fn lineage_refs_share_bytes_until_the_last_release() {
    let root = TestRoot::new("release");
    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let bytes = b"shared local bytes".to_vec();
    let first = store
        .stage(intent(&bytes, "one"), stream(bytes.clone()))
        .await
        .expect("first stage succeeds");
    let first_ref = store.publish(&first).await.expect("first publish succeeds");
    let second = store
        .stage(intent(&bytes, "two"), stream(bytes))
        .await
        .expect("second stage succeeds");
    let second_ref = store
        .publish(&second)
        .await
        .expect("second publish succeeds");
    let blob = blob_path(root.path(), &first_ref);
    assert_eq!(blob, blob_path(root.path(), &second_ref));

    assert_eq!(
        store
            .release(&first_ref.artifact_id)
            .await
            .expect("first release succeeds"),
        ReleaseResult::Released
    );
    assert!(blob.is_file());
    assert!(
        store
            .inspect(&second_ref.artifact_id)
            .await
            .expect("remaining ref inspects")
            .is_some()
    );
    assert_eq!(
        store
            .release(&second_ref.artifact_id)
            .await
            .expect("last release succeeds"),
        ReleaseResult::Released
    );
    assert!(!blob.exists());
    assert_eq!(
        store
            .release(&second_ref.artifact_id)
            .await
            .expect("release retry succeeds"),
        ReleaseResult::NotFound
    );
}

#[cfg(unix)]
#[test]
fn startup_rejects_symlink_and_non_regular_entries() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new("symlink-startup");
    let target = root.path().with_extension("target");
    std::fs::create_dir(&target).expect("create symlink target");
    symlink(&target, root.path()).expect("create root symlink");
    let failure = match LocalCasArtifactStore::new(root.path()) {
        Ok(_) => panic!("symlink root must fail"),
        Err(failure) => failure,
    };
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
    std::fs::remove_file(root.path()).expect("remove root symlink");
    std::fs::remove_dir(&target).expect("remove symlink target");

    std::fs::create_dir_all(root.path().join("staging/non-regular"))
        .expect("create non-regular stage entry");
    let failure = match LocalCasArtifactStore::new(root.path()) {
        Ok(_) => panic!("non-regular stage entry must fail"),
        Err(failure) => failure,
    };
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
}

#[cfg(unix)]
#[tokio::test]
async fn publish_and_inspect_reject_symlink_entries() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new("symlink-runtime");
    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let bytes = b"symlink protected".to_vec();
    let artifact_intent = intent(&bytes, "symlink");
    let projected = artifact_intent.artifact_ref();
    let staged = store
        .stage(artifact_intent, stream(bytes.clone()))
        .await
        .expect("stage succeeds");
    let blob = blob_path(root.path(), &projected);
    std::fs::create_dir_all(blob.parent().expect("blob parent exists"))
        .expect("create blob parent");
    let target = root.path().join("target.bin");
    std::fs::write(&target, &bytes).expect("write target");
    symlink(&target, &blob).expect("create blob symlink");
    assert_eq!(
        store
            .publish(&staged)
            .await
            .expect_err("blob symlink must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    std::fs::remove_file(&blob).expect("remove blob symlink");
    let artifact_ref = store.publish(&staged).await.expect("publish after repair");
    let manifest = ref_path(root.path(), &artifact_ref);
    std::fs::remove_file(&manifest).expect("remove manifest");
    symlink(&target, &manifest).expect("create manifest symlink");
    assert_eq!(
        store
            .inspect(&artifact_ref.artifact_id)
            .await
            .expect_err("manifest symlink must fail")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
}

#[cfg(unix)]
#[tokio::test]
async fn inspect_and_open_reject_symlinked_blob_prefix_directory() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new("symlink-prefix");
    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let bytes = b"prefix protected".to_vec();
    let staged = store
        .stage(intent(&bytes, "symlink-prefix"), stream(bytes.clone()))
        .await
        .expect("stage succeeds");
    let artifact_ref = store.publish(&staged).await.expect("publish succeeds");
    let prefix = blob_path(root.path(), &artifact_ref)
        .parent()
        .expect("blob prefix exists")
        .to_path_buf();
    drop(store);

    let displaced = root.path().join("displaced-prefix");
    std::fs::rename(&prefix, &displaced).expect("displace blob prefix");
    symlink(&displaced, &prefix).expect("replace blob prefix with symlink");
    let reopened = LocalCasArtifactStore::new(root.path()).expect("reopen local CAS");

    assert_eq!(
        reopened
            .inspect(&artifact_ref.artifact_id)
            .await
            .expect_err("inspect must reject a symlinked blob prefix")
            .kind(),
        ArtifactStoreFailureKind::CorruptContent
    );
    let failure = match reopened.open(&artifact_ref.artifact_id).await {
        Ok(_) => panic!("open must reject a symlinked blob prefix"),
        Err(failure) => failure,
    };
    assert_eq!(failure.kind(), ArtifactStoreFailureKind::CorruptContent);
}

#[cfg(unix)]
#[tokio::test]
async fn local_layout_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let root = TestRoot::new("permissions");
    let store = LocalCasArtifactStore::new(root.path()).expect("construct local CAS");
    let staged = store
        .stage(
            intent(b"private", "permissions"),
            stream(b"private".to_vec()),
        )
        .await
        .expect("stage succeeds");
    let artifact_ref = store.publish(&staged).await.expect("publish succeeds");
    for directory in [
        root.path().to_path_buf(),
        root.path().join("staging"),
        root.path().join("blobs"),
        root.path().join("blobs/sha256"),
        blob_path(root.path(), &artifact_ref)
            .parent()
            .expect("blob parent exists")
            .to_path_buf(),
        root.path().join("refs"),
    ] {
        assert_eq!(
            std::fs::metadata(directory)
                .expect("directory metadata")
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
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
