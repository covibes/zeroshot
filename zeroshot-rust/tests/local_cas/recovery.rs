#[cfg(unix)]
use std::pin::Pin;
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::task::{Context, Poll};
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};
#[cfg(unix)]
use tokio::sync::Notify;
#[cfg(unix)]
use zeroshot_engine::artifact_store::{ArtifactStoreFailureKind, ArtifactStoreOperation};

use super::*;

#[cfg(unix)]
struct SignalingReader<R> {
    inner: R,
    polled: Arc<Notify>,
}

#[cfg(unix)]
impl<R: AsyncRead + Unpin> AsyncRead for SignalingReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        this.polled.notify_one();
        Pin::new(&mut this.inner).poll_read(context, buffer)
    }
}

#[tokio::test]
async fn abandoned_manifest_stage_cannot_block_release_after_restart() {
    let root = TestRoot::new("manifest-recovery");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let bytes = b"durable committed bytes".to_vec();
    let staged = store
        .stage(intent(&bytes, "manifest-recovery"), stream(bytes))
        .await
        .assert_value_with("stage succeeds");
    let artifact_ref = store
        .publish(&staged)
        .await
        .assert_value_with("publish succeeds");
    drop(store);

    let abandoned = root
        .path()
        .join("staging")
        .join(format!("ref-{}-999.tmp", artifact_ref.artifact_id.as_str()));
    std::fs::write(&abandoned, b"synchronized but uncommitted manifest")
        .assert_value_with("simulate crash before manifest rename");

    let restarted =
        LocalCasArtifactStore::new(root.path()).assert_value_with("restart cleans staging");
    assert!(!abandoned.exists());
    assert_eq!(
        restarted
            .release(&artifact_ref.artifact_id)
            .await
            .assert_value_with("abandoned manifest stage cannot block release"),
        ReleaseResult::Released
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_stage_cleanup_errors_are_reported_and_recovered_on_restart() {
    let root = TestRoot::new("failed-stage-cleanup");
    let store = LocalCasArtifactStore::new(root.path()).assert_value_with("construct local CAS");
    let staging = root.path().join("staging");
    let displaced_staging = root.path().join("displaced-staging");
    let (reader, mut writer) = tokio::io::duplex(16);
    let reader_polled = Arc::new(Notify::new());
    let signaling_reader = SignalingReader {
        inner: reader,
        polled: Arc::clone(&reader_polled),
    };
    let staging_store = store.clone();
    let stage_task = tokio::spawn(async move {
        staging_store
            .stage(
                intent(b"expected", "failed-stage-cleanup"),
                Box::new(signaling_reader),
            )
            .await
    });

    tokio::time::timeout(Duration::from_secs(1), reader_polled.notified())
        .await
        .assert_value_with("stage reader must be blocked before injecting cleanup failure");
    std::fs::rename(&staging, &displaced_staging).assert_value_with("displace staging directory");
    std::fs::write(&staging, b"not a directory").assert_value_with("block failed-stage cleanup");
    writer
        .write_all(b"different")
        .await
        .assert_value_with("send oversized stage bytes");
    drop(writer);

    let failure = stage_task
        .await
        .assert_value_with("stage task joins")
        .assert_error_with("cleanup failure must replace the content-validation failure");
    assert_eq!(
        failure.kind(),
        ArtifactStoreFailureKind::Io(ArtifactStoreOperation::Stage)
    );

    std::fs::remove_file(&staging).assert_value_with("remove cleanup blocker");
    std::fs::rename(&displaced_staging, &staging).assert_value_with("restore staging directory");
    assert_eq!(
        std::fs::read_dir(&staging)
            .assert_value_with("read restored staging directory")
            .count(),
        1,
        "failed cleanup leaves one recoverable stage"
    );
    drop(store);

    let _restarted = LocalCasArtifactStore::new(root.path())
        .assert_value_with("restart cleans failed stage residue");
    assert_eq!(
        std::fs::read_dir(&staging)
            .assert_value_with("read cleaned staging directory")
            .count(),
        0
    );
}

use openengine_cluster_testkit::assertions::{AssertValue, AssertError};
