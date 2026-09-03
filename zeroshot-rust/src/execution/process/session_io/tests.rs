use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch};

use super::*;

struct FailingReader {
    kind: io::ErrorKind,
    message: &'static str,
}

impl AsyncRead for FailingReader {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::new(self.kind, self.message)))
    }
}

#[derive(Clone, Copy)]
enum WriteFailure {
    Write,
    Shutdown,
}

struct FailingWriter(WriteFailure);

impl AsyncWrite for FailingWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.0 {
            WriteFailure::Write => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected write cause",
            ))),
            WriteFailure::Shutdown => Poll::Ready(Ok(buffer.len())),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.0 {
            WriteFailure::Write => Poll::Ready(Ok(())),
            WriteFailure::Shutdown => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected shutdown cause",
            ))),
        }
    }
}

#[tokio::test]
async fn stdout_and_stderr_read_failures_retain_the_io_cause() {
    let (output, _output_rx) = mpsc::channel(1);
    let stdout = read_stdout(
        FailingReader {
            kind: io::ErrorKind::ConnectionReset,
            message: "injected stdout cause",
        },
        output,
    )
    .await
    .assert_error()
    .into_detail();
    let stderr = read_stderr(
        FailingReader {
            kind: io::ErrorKind::UnexpectedEof,
            message: "injected stderr cause",
        },
        std::sync::Arc::new(std::sync::Mutex::new(TailBuffer::new(16))),
    )
    .await
    .assert_error()
    .into_detail();

    assert_io_detail(
        &stdout,
        "process stdout read failed",
        "ConnectionReset",
        "injected stdout cause",
    );
    assert_io_detail(
        &stderr,
        "process stderr read failed",
        "UnexpectedEof",
        "injected stderr cause",
    );
}

#[tokio::test]
async fn stdin_write_failure_reaches_acknowledgement_and_supervisor_channel() {
    let (commands, command_rx) = mpsc::channel(1);
    let (_stop, stop_rx) = watch::channel(false);
    let (failures, mut failure_rx) = mpsc::unbounded_channel();
    let (acknowledge, acknowledged) = oneshot::channel();
    commands
        .send(WriterCommand::Frame(b"input".to_vec(), acknowledge))
        .await
        .assert_value();

    run_writer(
        FailingWriter(WriteFailure::Write),
        command_rx,
        stop_rx,
        failures,
    )
    .await;

    let acknowledged = acknowledged.await.assert_value().assert_error();
    let reported = failure_rx.recv().await.assert_value().into_detail();
    assert_io_detail(
        &acknowledged,
        "process stdin write failed",
        "BrokenPipe",
        "injected write cause",
    );
    assert_eq!(reported, acknowledged);
}

#[tokio::test]
async fn explicit_and_channel_drop_shutdown_failures_retain_the_io_cause() {
    let explicit = shutdown_case(true).await;
    let channel_drop = shutdown_case(false).await;

    assert_io_detail(
        &explicit,
        "process stdin shutdown failed",
        "PermissionDenied",
        "injected shutdown cause",
    );
    assert_io_detail(
        &channel_drop,
        "process stdin shutdown after command channel closed failed",
        "PermissionDenied",
        "injected shutdown cause",
    );
}

async fn shutdown_case(explicit: bool) -> String {
    let (commands, command_rx) = mpsc::channel(1);
    let (_stop, stop_rx) = watch::channel(false);
    let (failures, mut failure_rx) = mpsc::unbounded_channel();
    let acknowledged = if explicit {
        let (acknowledge, acknowledged) = oneshot::channel();
        commands
            .send(WriterCommand::Close(acknowledge))
            .await
            .assert_value();
        Some(acknowledged)
    } else {
        None
    };
    drop(commands);

    run_writer(
        FailingWriter(WriteFailure::Shutdown),
        command_rx,
        stop_rx,
        failures,
    )
    .await;

    let reported = failure_rx.recv().await.assert_value().into_detail();
    if let Some(acknowledged) = acknowledged {
        assert_eq!(acknowledged.await.assert_value().assert_error(), reported);
    }
    reported
}

fn assert_io_detail(detail: &str, operation: &str, kind: &str, message: &str) {
    assert!(detail.starts_with(operation));
    assert!(detail.contains(&format!("kind={kind}")));
    assert!(detail.contains("raw_os_error=none"));
    assert!(detail.contains(&format!("message={message}")));
}
