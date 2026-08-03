use std::collections::BTreeMap;
use std::path::PathBuf;

use openengine_cluster_protocol::{
    LegacyShipRequest, LegacyShipResult, LegacyShipStatus, WorkerErrorCode, WorkerOutcome,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::time::{timeout, Duration, Instant};

use crate::execution::driver::{DriverCancellation, WorkspaceCapability};
use crate::execution::process::{
    LocalProcessRunner, ProcessCleanupEvidence, ProcessFrame, ProcessRunnerError, ProcessSession,
    ProcessSessionCommand, ProcessSessionOutput,
};
use crate::execution::WorkspaceAccessMode;

use super::ports::{
    ISOLATION_PROFILE, PROVIDER_PROFILE, PROXY_ENDPOINT, PROXY_MODEL, PROXY_SENTINEL_KEY,
    WORKSPACE_ROOT,
};

pub(super) const NODE_PROGRAM: &str = "/usr/local/bin/node";
const NODE_WORKER: &str = "/opt/zeroshot/zeroshot-rust/hosted-node/worker.js";
const WORKER_FRAME_BYTES: usize = 64 * 1024;
const PROCESS_SAFETY_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerError {
    Launch,
    Protocol,
    Exited,
    Cleanup,
}

#[derive(Clone)]
pub(super) struct WorkerCommand {
    pub(super) program: String,
    pub(super) argv: Vec<String>,
    pub(super) current_dir: PathBuf,
    pub(super) isolated: bool,
}

impl WorkerCommand {
    pub(super) fn production() -> Self {
        Self {
            program: NODE_PROGRAM.to_owned(),
            argv: vec![NODE_WORKER.to_owned()],
            current_dir: PathBuf::from(WORKSPACE_ROOT),
            isolated: true,
        }
    }
}

pub struct WorkerExecution {
    session: ProcessSession,
    buffered: Vec<u8>,
    isolated: bool,
    cluster_id: String,
}

impl WorkerExecution {
    pub(super) async fn spawn_command(
        request: &LegacyShipRequest,
        cancellation: watch::Receiver<bool>,
        command: WorkerCommand,
    ) -> Result<Self, WorkerError> {
        let isolated = command.isolated;
        let command = ProcessSessionCommand {
            program: command.program,
            argv: command.argv,
            environment: fixed_environment(),
            workspace: WorkspaceCapability {
                current_dir: command.current_dir,
                mode: WorkspaceAccessMode::Exclusive,
            },
            deadline: Instant::now() + PROCESS_SAFETY_DEADLINE,
        };
        let runner = if isolated {
            LocalProcessRunner::hosted_worker().map_err(map_runner_error)?
        } else {
            LocalProcessRunner::new()
        };
        let mut execution = Self {
            session: runner
                .open(command, DriverCancellation::new(cancellation))
                .await
                .map_err(map_runner_error)?,
            buffered: Vec::new(),
            cluster_id: String::new(),
            isolated,
        };
        let started = timeout(
            WORKER_START_TIMEOUT,
            execution.call(1, "start", json!({ "request": request })),
        )
        .await
        .unwrap_or(Err(WorkerError::Exited))
        .and_then(validate_started_receipt);
        match started {
            Ok(cluster_id) => execution.cluster_id = cluster_id,
            Err(error) => {
                return match execution.prove_stopped().await {
                    Ok(_) => Err(error),
                    Err(cleanup) => Err(cleanup),
                };
            }
        }
        Ok(execution)
    }

    pub async fn wait_terminal(&mut self) -> Result<WorkerOutcome, WorkerError> {
        let value = self.call(2, "result", json!({})).await?;
        Ok(normalize_terminal_receipt(
            value,
            Some(self.cluster_id.as_str()),
        ))
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Result<Value, WorkerError> {
        let mut frame = serde_json::to_vec(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|_| WorkerError::Protocol)?;
        frame.push(b'\n');
        if frame.len() > WORKER_FRAME_BYTES {
            return Err(WorkerError::Protocol);
        }
        let message_bytes = frame.len() - 1;
        self.session
            .send(ProcessFrame::with_framing(frame, message_bytes).map_err(map_runner_error)?)
            .await
            .map_err(map_runner_error)?;
        self.read_response(id).await
    }

    async fn read_response(&mut self, expected_id: u64) -> Result<Value, WorkerError> {
        loop {
            if let Some(line) = take_line(&mut self.buffered)? {
                return decode_response(&line, expected_id);
            }
            let chunk = self
                .session
                .recv_stdout()
                .await
                .ok_or(WorkerError::Exited)?;
            append_chunk(&mut self.buffered, chunk.as_slice())?;
        }
    }

    pub async fn prove_stopped(mut self) -> Result<ProcessCleanupEvidence, WorkerError> {
        let _ = self.session.close_stdin().await;
        let output = self.session.release().await.map_err(map_runner_error)?;
        validate_cleanup(&output, self.isolated)
    }
}

fn fixed_environment() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".to_owned(), "/tmp/zeroshot-oecp".to_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
        ("NODE_ENV".to_owned(), "production".to_owned()),
        ("OPENAI_API_KEY".to_owned(), PROXY_SENTINEL_KEY.to_owned()),
        ("OPENAI_BASE_URL".to_owned(), PROXY_ENDPOINT.to_owned()),
        (
            "ZEROSHOT_ISOLATION_PROFILE".to_owned(),
            ISOLATION_PROFILE.to_owned(),
        ),
        ("ZEROSHOT_MODEL".to_owned(), PROXY_MODEL.to_owned()),
        (
            "ZEROSHOT_PROVIDER_PROFILE".to_owned(),
            PROVIDER_PROFILE.to_owned(),
        ),
    ])
}

fn take_line(buffer: &mut Vec<u8>) -> Result<Option<Vec<u8>>, WorkerError> {
    let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    if newline == 0 || newline >= WORKER_FRAME_BYTES {
        return Err(WorkerError::Protocol);
    }
    let mut remaining = buffer.split_off(newline + 1);
    std::mem::swap(buffer, &mut remaining);
    remaining.truncate(newline);
    if remaining.last() == Some(&b'\r') {
        remaining.pop();
    }
    Ok(Some(remaining))
}

fn append_chunk(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<(), WorkerError> {
    if buffer.len().saturating_add(chunk.len()) > WORKER_FRAME_BYTES {
        return Err(WorkerError::Protocol);
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

fn decode_response(line: &[u8], expected_id: u64) -> Result<Value, WorkerError> {
    let response: ResponseFrame =
        serde_json::from_slice(line).map_err(|_| WorkerError::Protocol)?;
    if response.kind != "response" || response.id != Some(expected_id) {
        return Err(WorkerError::Protocol);
    }
    match (response.ok, response.result, response.error) {
        (true, Some(result), None) => Ok(result),
        _ => Err(WorkerError::Protocol),
    }
}

fn validate_started_receipt(value: Value) -> Result<String, WorkerError> {
    let receipt: StartedReceipt =
        serde_json::from_value(value).map_err(|_| WorkerError::Protocol)?;
    let safe_cluster_id = !receipt.cluster_id.is_empty()
        && receipt.cluster_id.len() <= 256
        && receipt
            .cluster_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'));
    if receipt.state != "running"
        || !safe_cluster_id
        || receipt.sequence == 0
        || receipt.stop_requested
        || receipt.terminal
    {
        return Err(WorkerError::Protocol);
    }
    Ok(receipt.cluster_id)
}

fn normalize_terminal_receipt(value: Value, expected_cluster_id: Option<&str>) -> WorkerOutcome {
    let Ok(wire) = serde_json::from_value::<TerminalReceiptWire>(value) else {
        return WorkerOutcome::malformed();
    };
    let Some(receipt) = wire.resolve() else {
        return WorkerOutcome::malformed();
    };
    if expected_cluster_id.is_some_and(|expected| receipt.cluster_id() != expected) {
        return WorkerOutcome::malformed();
    }
    match receipt {
        TerminalReceipt::Completed { result, .. }
            if result.status == LegacyShipStatus::Succeeded =>
        {
            WorkerOutcome::Verified {
                output: json!({
                    "summary": "Hosted worker completed",
                    "status": "succeeded",
                    "artifacts": [],
                }),
                artifacts: Vec::new(),
            }
        }
        TerminalReceipt::Completed { .. } => {
            WorkerOutcome::declared_failure(WorkerErrorCode::Crash)
        }
        TerminalReceipt::Failed(_) | TerminalReceipt::TimedOut(_) => {
            WorkerOutcome::declared_failure(WorkerErrorCode::Crash)
        }
        TerminalReceipt::Malformed(_) => WorkerOutcome::malformed(),
        TerminalReceipt::Stopped(_) => WorkerOutcome::declared_failure(WorkerErrorCode::Refusal),
    }
}

fn validate_cleanup(
    output: &ProcessSessionOutput,
    requires_explicit_evidence: bool,
) -> Result<ProcessCleanupEvidence, WorkerError> {
    if output.cleanup.proves_tree_empty()
        && (!requires_explicit_evidence || output.cleanup == ProcessCleanupEvidence::Reaped)
    {
        Ok(output.cleanup)
    } else {
        Err(WorkerError::Cleanup)
    }
}

fn map_runner_error(error: ProcessRunnerError) -> WorkerError {
    match error {
        ProcessRunnerError::InvalidCommand(_) | ProcessRunnerError::Launch(_) => {
            WorkerError::Launch
        }
        ProcessRunnerError::Io(_) => WorkerError::Cleanup,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseFrame {
    #[serde(rename = "type")]
    kind: String,
    id: Option<u64>,
    ok: bool,
    result: Option<Value>,
    error: Option<ResponseError>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseError {
    #[serde(rename = "code")]
    _code: String,
    #[serde(rename = "message")]
    _message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StartedReceipt {
    state: String,
    cluster_id: String,
    sequence: u64,
    stop_requested: bool,
    terminal: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TerminalReceiptWire {
    state: String,
    cluster_id: String,
    finished_at: f64,
    result: Option<LegacyShipResult>,
    outcome: Option<WorkerOutcome>,
    stop: Option<StopReceipt>,
}

struct TerminalMetadata {
    cluster_id: String,
    _finished_at: f64,
}

enum TerminalReceipt {
    Completed {
        metadata: TerminalMetadata,
        result: LegacyShipResult,
    },
    Failed(TerminalMetadata),
    TimedOut(TerminalMetadata),
    Stopped(TerminalMetadata),
    Malformed(TerminalMetadata),
}

impl TerminalReceiptWire {
    fn resolve(self) -> Option<TerminalReceipt> {
        let metadata = TerminalMetadata {
            cluster_id: self.cluster_id,
            _finished_at: self.finished_at,
        };
        match (self.state.as_str(), self.result, self.outcome, self.stop) {
            ("completed", Some(result), None, None) => {
                Some(TerminalReceipt::Completed { metadata, result })
            }
            ("failed", None, Some(_), None) => Some(TerminalReceipt::Failed(metadata)),
            ("timed_out", None, Some(_), None) => Some(TerminalReceipt::TimedOut(metadata)),
            ("stopped", None, None, Some(_)) => Some(TerminalReceipt::Stopped(metadata)),
            ("malformed", None, Some(_), None) => Some(TerminalReceipt::Malformed(metadata)),
            _ => None,
        }
    }
}

impl TerminalReceipt {
    fn cluster_id(&self) -> &str {
        let metadata = match self {
            Self::Completed { metadata, .. }
            | Self::Failed(metadata)
            | Self::TimedOut(metadata)
            | Self::Stopped(metadata)
            | Self::Malformed(metadata) => metadata,
        };
        &metadata.cluster_id
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StopReceipt {
    #[serde(rename = "requested")]
    _requested: bool,
    #[serde(rename = "effective")]
    _effective: bool,
    #[serde(rename = "externalEffectsRolledBack")]
    _external_effects_rolled_back: bool,
}

#[cfg(all(test, unix))]
#[path = "worker_tests.rs"]
mod tests;
