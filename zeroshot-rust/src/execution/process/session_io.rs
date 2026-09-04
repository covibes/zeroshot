use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use super::io_error_detail;
use super::session::ProcessOutputChunk;
use super::tail_buffer::TailBuffer;

pub(super) const PROCESS_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;

pub(super) enum WriterCommand {
    Frame(Vec<u8>, oneshot::Sender<Result<(), String>>),
    Close(oneshot::Sender<Result<(), String>>),
}

#[derive(Debug)]
pub(super) struct IoFailure {
    detail: String,
    expected_during_release: bool,
}

impl IoFailure {
    fn from_io(operation: &'static str, error: &std::io::Error) -> Self {
        Self {
            detail: io_error_detail(operation, error),
            expected_during_release: false,
        }
    }

    fn static_detail(detail: &'static str) -> Self {
        Self {
            detail: detail.to_owned(),
            expected_during_release: false,
        }
    }

    fn release_artifact(detail: &'static str) -> Self {
        Self {
            detail: detail.to_owned(),
            expected_during_release: true,
        }
    }

    pub(super) const fn should_report(&self, releasing: bool) -> bool {
        !releasing || !self.expected_during_release
    }

    pub(super) fn into_detail(self) -> String {
        self.detail
    }
}

pub(super) fn spawn_stdout_pump(
    stdout: Option<ChildStdout>,
    output: mpsc::Sender<ProcessOutputChunk>,
    failures: mpsc::UnboundedSender<IoFailure>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(stdout) = stdout else {
            let _ = failures.send(IoFailure::static_detail(
                "process stdout pipe is unavailable",
            ));
            return;
        };
        if let Err(failure) = read_stdout(stdout, output).await {
            let _ = failures.send(failure);
        }
    })
}

async fn read_stdout<R>(
    mut stdout: R,
    output: mpsc::Sender<ProcessOutputChunk>,
) -> Result<(), IoFailure>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = vec![0_u8; PROCESS_OUTPUT_CHUNK_BYTES];
    loop {
        let read = stdout
            .read(&mut chunk)
            .await
            .map_err(|error| IoFailure::from_io("process stdout read failed", &error))?;
        if read == 0 {
            return Ok(());
        }
        let bytes = chunk.get(..read).ok_or_else(|| {
            IoFailure::static_detail("process stdout read returned an invalid byte count")
        })?;
        output
            .send(ProcessOutputChunk::from_bytes(bytes.to_vec()))
            .await
            .map_err(|_| IoFailure::release_artifact("process stdout delivery failed"))?;
    }
}

pub(super) fn spawn_stderr_pump(
    stderr: Option<ChildStderr>,
    tail: Arc<Mutex<TailBuffer>>,
    failures: mpsc::UnboundedSender<IoFailure>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(stderr) = stderr else {
            let _ = failures.send(IoFailure::static_detail(
                "process stderr pipe is unavailable",
            ));
            return;
        };
        if let Err(failure) = read_stderr(stderr, tail).await {
            let _ = failures.send(failure);
        }
    })
}

async fn read_stderr<R>(mut stderr: R, tail: Arc<Mutex<TailBuffer>>) -> Result<(), IoFailure>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stderr
            .read(&mut chunk)
            .await
            .map_err(|error| IoFailure::from_io("process stderr read failed", &error))?;
        if read == 0 {
            return Ok(());
        }
        let bytes = chunk.get(..read).ok_or_else(|| {
            IoFailure::static_detail("process stderr read returned an invalid byte count")
        })?;
        tail.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .append(bytes);
    }
}

pub(super) fn spawn_writer(
    stdin: Option<ChildStdin>,
    commands: mpsc::Receiver<WriterCommand>,
    stop: watch::Receiver<bool>,
    failures: mpsc::UnboundedSender<IoFailure>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(stdin) = stdin else {
            let _ = failures.send(IoFailure::static_detail(
                "process stdin pipe is unavailable",
            ));
            return;
        };
        run_writer(stdin, commands, stop, failures).await;
    })
}

async fn run_writer<W>(
    mut stdin: W,
    mut commands: mpsc::Receiver<WriterCommand>,
    mut stop: watch::Receiver<bool>,
    failures: mpsc::UnboundedSender<IoFailure>,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            biased;
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    report_shutdown_failure(
                        &mut stdin,
                        "process stdin shutdown after writer stop failed",
                        &failures,
                    ).await;
                    return;
                }
            }
            command = commands.recv() => {
                match command {
                    Some(WriterCommand::Frame(frame, acknowledge)) => {
                        let result = tokio::select! {
                            biased;
                            changed = stop.changed() => {
                                let _ = changed;
                                Err(IoFailure::static_detail("process stdin writer stopped"))
                            }
                            result = stdin.write_all(&frame) => {
                                result.map_err(|error| {
                                    IoFailure::from_io("process stdin write failed", &error)
                                })
                            }
                        };
                        if let Err(failure) = result {
                            let _ = acknowledge.send(Err(failure.detail.clone()));
                            let _ = failures.send(failure);
                            report_shutdown_failure(
                                &mut stdin,
                                "process stdin shutdown after write failure failed",
                                &failures,
                            ).await;
                            return;
                        }
                        let _ = acknowledge.send(Ok(()));
                    }
                    Some(WriterCommand::Close(acknowledge)) => {
                        match shutdown_stdin(&mut stdin, "process stdin shutdown failed").await {
                            Ok(()) => {
                                let _ = acknowledge.send(Ok(()));
                            }
                            Err(failure) => {
                                let _ = acknowledge.send(Err(failure.detail.clone()));
                                let _ = failures.send(failure);
                            }
                        }
                        return;
                    }
                    None => {
                        report_shutdown_failure(
                            &mut stdin,
                            "process stdin shutdown after command channel closed failed",
                            &failures,
                        ).await;
                        return;
                    }
                }
            }
        }
    }
}

async fn shutdown_stdin<W>(stdin: &mut W, operation: &'static str) -> Result<(), IoFailure>
where
    W: AsyncWrite + Unpin,
{
    stdin
        .shutdown()
        .await
        .map_err(|error| IoFailure::from_io(operation, &error))
}

async fn report_shutdown_failure<W>(
    stdin: &mut W,
    operation: &'static str,
    failures: &mpsc::UnboundedSender<IoFailure>,
) where
    W: AsyncWrite + Unpin,
{
    if let Err(failure) = shutdown_stdin(stdin, operation).await {
        let _ = failures.send(failure);
    }
}

#[cfg(test)]
#[path = "session_io/tests.rs"]
mod tests;
