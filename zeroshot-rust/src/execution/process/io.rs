use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

#[derive(Debug)]
pub struct ReaderOutcome {
    pub output: Vec<u8>,
    pub error: Option<String>,
}

#[derive(Debug)]
pub enum ProcessEvent {
    Stdin(WriterOutcome),
    Stdout(ReaderOutcome),
    Stderr(ReaderOutcome),
}

#[derive(Debug)]
pub struct WriterOutcome {
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

pub struct PendingIo<'a> {
    stdin_done: &'a mut bool,
    stdout: &'a mut Option<ReaderOutcome>,
    stderr: &'a mut Option<ReaderOutcome>,
    post_launch_errors: &'a mut Vec<String>,
}

impl<'a> PendingIo<'a> {
    pub fn new(
        stdin_done: &'a mut bool,
        stdout: &'a mut Option<ReaderOutcome>,
        stderr: &'a mut Option<ReaderOutcome>,
        post_launch_errors: &'a mut Vec<String>,
    ) -> Self {
        Self {
            stdin_done,
            stdout,
            stderr,
            post_launch_errors,
        }
    }
}

async fn read_bounded<R>(mut reader: R, max: usize) -> ReaderOutcome
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(read) => read,
            Err(error) => {
                return ReaderOutcome {
                    output,
                    error: Some(error.to_string()),
                };
            }
        };
        if read == 0 {
            return ReaderOutcome {
                output,
                error: None,
            };
        }
        if output.len().saturating_add(read) > max {
            let keep = max.saturating_sub(output.len());
            if keep > 0 {
                output.extend_from_slice(&chunk[..keep]);
            }
            return ReaderOutcome {
                output,
                error: Some(format!("stream exceeded {} bytes", max)),
            };
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

pub fn spawn_stdin_task(
    stdin: Option<tokio::process::ChildStdin>,
    input: Vec<u8>,
    events: mpsc::UnboundedSender<ProcessEvent>,
) {
    tokio::spawn(async move {
        let error = match stdin {
            Some(mut stdin) => {
                if input.is_empty() {
                    stdin.shutdown().await.err().map(|error| error.to_string())
                } else {
                    match stdin.write_all(&input).await {
                        Ok(()) => stdin.shutdown().await.err().map(|error| error.to_string()),
                        Err(error) => Some(error.to_string()),
                    }
                }
            }
            None if input.is_empty() => None,
            None => Some("child stdin pipe was not available".to_owned()),
        };
        let _ = events.send(ProcessEvent::Stdin(WriterOutcome { error }));
    });
}

pub fn spawn_reader_task<R>(
    reader: Option<R>,
    max: usize,
    stream: ProcessStream,
    events: mpsc::UnboundedSender<ProcessEvent>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let outcome = match reader {
            Some(reader) => read_bounded(reader, max).await,
            None => ReaderOutcome {
                output: Vec::new(),
                error: Some(format!(
                    "child {} pipe was not available",
                    stream_name(stream)
                )),
            },
        };
        let event = match stream {
            ProcessStream::Stdout => ProcessEvent::Stdout(outcome),
            ProcessStream::Stderr => ProcessEvent::Stderr(outcome),
        };
        let _ = events.send(event);
    });
}

pub fn record_process_event(
    event: ProcessEvent,
    stdin_done: &mut bool,
    stdout: &mut Option<ReaderOutcome>,
    stderr: &mut Option<ReaderOutcome>,
) -> Option<String> {
    match event {
        ProcessEvent::Stdin(outcome) => {
            *stdin_done = true;
            outcome
                .error
                .map(|error| format!("stdin write failed: {error}"))
        }
        ProcessEvent::Stdout(outcome) => {
            let error = outcome
                .error
                .as_ref()
                .map(|error| format!("stdout read failed: {error}"));
            *stdout = Some(outcome);
            error
        }
        ProcessEvent::Stderr(outcome) => {
            let error = outcome
                .error
                .as_ref()
                .map(|error| format!("stderr read failed: {error}"));
            *stderr = Some(outcome);
            error
        }
    }
}

pub async fn collect_remaining_events(
    events: &mut mpsc::UnboundedReceiver<ProcessEvent>,
    pending: PendingIo<'_>,
) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while !*pending.stdin_done || pending.stdout.is_none() || pending.stderr.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            pending
                .post_launch_errors
                .push("process I/O collection timed out".to_owned());
            break;
        }
        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Some(event)) => {
                if let Some(error) =
                    record_process_event(event, pending.stdin_done, pending.stdout, pending.stderr)
                {
                    pending.post_launch_errors.push(error);
                }
            }
            Ok(None) => break,
            Err(_) => {
                pending
                    .post_launch_errors
                    .push("process I/O collection timed out".to_owned());
                break;
            }
        }
    }
}

pub fn join_errors(errors: Vec<String>) -> Option<String> {
    if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    }
}

fn stream_name(stream: ProcessStream) -> &'static str {
    match stream {
        ProcessStream::Stdout => "stdout",
        ProcessStream::Stderr => "stderr",
    }
}
