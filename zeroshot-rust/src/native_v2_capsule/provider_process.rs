//! Shared contained-process mechanics for native-v2 agent harnesses.

use std::path::{Path, PathBuf};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::execution::SessionScope;
use crate::execution::process::{
    HostedProcessPool, HostedProcessScope, LocalProcessRunner, ProcessFrame, ProcessLaunchEvidence,
    ProcessRunnerError, ProcessSession, ProcessSessionCommand, ProcessSessionOutput,
    MAX_PROCESS_MESSAGE_BYTES,
};
use crate::native_v2_contract::NodeRuntimeBinding;
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NodeRole, NodeRunnerError,
};
use crate::worker_catalog::ReasoningEffort;

const CONTINUE_PROMPT: &str = "Continue";

#[path = "provider_process/diagnostic.rs"]
mod diagnostic;
pub(crate) use diagnostic::{provider_failure_diagnostic, safe_provider_text};
#[cfg(test)]
use diagnostic::MAX_PROVIDER_DIAGNOSTIC_BYTES;

#[derive(Clone, Copy)]
pub(crate) enum ProviderProcessRunners {
    Hosted(HostedProcessPool),
    Local,
}

impl ProviderProcessRunners {
    pub(crate) const fn hosted(pool: HostedProcessPool) -> Self {
        Self::Hosted(pool)
    }

    pub(crate) const fn local() -> Self {
        Self::Local
    }

    pub(crate) fn turn_process(
        self,
        root: &Path,
        scope: HostedProcessScope,
    ) -> Result<(LocalProcessRunner, PathBuf), ProcessRunnerError> {
        match self {
            Self::Hosted(pool) => {
                let identity = pool.identity(scope)?;
                let home = identity.prepare_private_home(root)?;
                Ok((identity.runner(), home))
            }
            Self::Local => {
                let home = crate::execution::process::prepare_local_private_home(root, scope)?;
                Ok((LocalProcessRunner::new(), home))
            }
        }
    }
}

pub(crate) async fn send_process_input(
    process: &mut ProcessSession,
    bytes: &[u8],
) -> Result<(), ProcessRunnerError> {
    for chunk in bytes.chunks(MAX_PROCESS_MESSAGE_BYTES) {
        process.send(ProcessFrame::new(chunk.to_vec())?).await?;
    }
    process.close_stdin().await
}

pub(crate) enum ProcessExchange<T> {
    Complete(T),
    InputFailure(ProcessInputFailure<T>),
}

pub(crate) struct ProcessInputFailure<T> {
    pub(crate) output: T,
    pub(crate) input_error: ProcessRunnerError,
    pub(crate) completion: Result<ProcessSessionOutput, ProcessRunnerError>,
}

/// Streams stdin while the provider-owned parser drains the existing bounded stdout queue.
/// Cleanup and output draining remain concurrent after an input failure so parsed metadata is
/// retained without introducing another output buffer.
pub(crate) async fn exchange_process_io<T>(
    process: &mut ProcessSession,
    bytes: &[u8],
    output: impl Future<Output = T>,
) -> ProcessExchange<T> {
    enum First<T> {
        Input(Result<(), ProcessRunnerError>),
        Output(T),
    }

    let mut input = Box::pin(send_process_input(process, bytes));
    let mut output = Box::pin(output);
    let first = tokio::select! {
        result = &mut input => First::Input(result),
        result = &mut output => First::Output(result),
    };

    match first {
        First::Input(Ok(())) => ProcessExchange::Complete(output.await),
        First::Input(Err(input_error)) => {
            drop(input);
            let (completion, output) = tokio::join!(process.release(), output);
            ProcessExchange::InputFailure(ProcessInputFailure {
                output,
                input_error,
                completion,
            })
        }
        First::Output(output_result) => {
            drop(output);
            match input.await {
                Ok(()) => ProcessExchange::Complete(output_result),
                Err(input_error) => ProcessExchange::InputFailure(ProcessInputFailure {
                    output: output_result,
                    input_error,
                    completion: process.release().await,
                }),
            }
        }
    }
}

pub(crate) async fn open_provider_process(
    runner: LocalProcessRunner,
    command: ProcessSessionCommand,
    control: &DriverControl,
) -> Result<Result<ProcessSession, ProcessRunnerError>, NodeRunnerError> {
    match runner.open(command, control.cancellation()).await {
        Ok(process) => Ok(Ok(process)),
        Err(error) => {
            if error.launch_evidence() == ProcessLaunchEvidence::MayHaveStarted {
                control.record_token_usage(None).await?;
            }
            if control.is_cancelled() {
                return Err(NodeRunnerError::Cancelled);
            }
            Ok(Err(error))
        }
    }
}

pub(crate) struct ProviderSessionCore {
    live: AtomicBool,
    pub(crate) turn: Mutex<()>,
}

macro_rules! impl_provider_node_session {
    ($session:ty) => {
        #[async_trait::async_trait]
        impl crate::native_v2_runner::NodeSession for $session {
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }

            async fn is_live(&self) -> bool {
                self.core.is_live()
            }

            async fn close(&self) {
                self.core.close();
            }
        }
    };
}

pub(crate) use impl_provider_node_session;

#[derive(Clone, Copy)]
pub(crate) enum ClosedSessionFailure {
    Driver,
    SessionLost,
}

impl ClosedSessionFailure {
    const fn runner_error(self) -> NodeRunnerError {
        match self {
            Self::Driver => NodeRunnerError::Driver,
            Self::SessionLost => NodeRunnerError::SessionLost,
        }
    }
}

impl ProviderSessionCore {
    pub(crate) fn new() -> Self {
        Self {
            live: AtomicBool::new(true),
            turn: Mutex::new(()),
        }
    }

    pub(crate) fn is_live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    pub(crate) fn close(&self) {
        self.live.store(false, Ordering::Release);
    }

    pub(crate) fn ensure_live(
        &self,
        closed_session: ClosedSessionFailure,
    ) -> Result<(), NodeRunnerError> {
        self.is_live()
            .then_some(())
            .ok_or(closed_session.runner_error())
    }
}

pub(crate) fn process_scope(
    invocation: &DriverInvocation,
) -> Result<HostedProcessScope, NodeRunnerError> {
    let NodeRuntimeBinding::Agent { session_scope, .. } = &invocation.node.binding else {
        return Err(NodeRunnerError::Driver);
    };
    let node_instance = invocation.node.reference.node_instance.get();
    let execution = invocation.node.reference.execution.get();
    match (invocation.role, *session_scope) {
        (NodeRole::Worker, SessionScope::NodeInstance) => {
            Ok(HostedProcessScope::WriterNodeInstance(node_instance))
        }
        (NodeRole::Worker, SessionScope::Execution) => {
            Ok(HostedProcessScope::WriterExecution(execution))
        }
        (NodeRole::Verifier, SessionScope::NodeInstance) => {
            Ok(HostedProcessScope::VerifierNodeInstance(node_instance))
        }
        (NodeRole::Verifier, SessionScope::Execution) => {
            Ok(HostedProcessScope::VerifierExecution(execution))
        }
        (NodeRole::GitDelivery, _) => Err(NodeRunnerError::Driver),
    }
}

/// Returns fatal process facts and, once either the process or provider output failed, stderr.
pub(crate) fn process_failure_detail(
    output: &ProcessSessionOutput,
    externally_cancelled: bool,
    provider_output_failed: bool,
) -> Result<Option<String>, NodeRunnerError> {
    if output.cancelled || externally_cancelled {
        return Err(NodeRunnerError::Cancelled);
    }
    let mut failures = process_failure_reasons(output);
    if failures.is_empty() && !provider_output_failed {
        return Ok(None);
    }
    append_process_stderr(
        &mut failures,
        &output.stderr_tail,
        output.stderr_tail_truncated,
    );
    Ok((!failures.is_empty()).then(|| failures.join("; ")))
}

fn process_failure_reasons(output: &ProcessSessionOutput) -> Vec<String> {
    let mut failures = Vec::new();
    if output.timed_out {
        failures.push("provider process timed out".to_owned());
    }
    if !output.cleanup.proves_tree_empty() {
        failures.push("process cleanup did not prove the process tree empty".to_owned());
    }
    if let Some(error) = output
        .post_launch_error
        .as_deref()
        .filter(|error| !error.trim().is_empty())
    {
        failures.push(error.to_owned());
    }
    if !output.timed_out {
        if let Some(signal) = output.termination_signal {
            let core_dump = if output.core_dumped {
                " (core dumped)"
            } else {
                ""
            };
            failures.push(format!(
                "provider process terminated by signal {signal}{core_dump}"
            ));
        } else if output.exit_code != Some(0) {
            failures.push(match output.exit_code {
                Some(code) => format!("provider process exited with status {code}"),
                None => "provider process exited without a status".to_owned(),
            });
        }
    }
    failures
}

fn append_process_stderr(failures: &mut Vec<String>, stderr: &[u8], truncated: bool) {
    if stderr.is_empty() {
        return;
    }
    let stderr = String::from_utf8_lossy(stderr);
    if !stderr.trim().is_empty() {
        let prefix = if truncated {
            "stderr (truncated tail): "
        } else {
            "stderr: "
        };
        failures.push(format!("{prefix}{}", stderr.trim()));
    }
}

/// Adds provider-safe context at a seam whose legacy error carried only `Driver`.
///
/// More specific failures retain their classification. Callers supply static context or values
/// that are safe to publish; terminal reporting applies credential redaction before emission.
pub(crate) fn with_driver_detail(
    error: NodeRunnerError,
    detail: impl Into<String>,
) -> NodeRunnerError {
    match error {
        NodeRunnerError::Driver => NodeRunnerError::DriverDetail(detail.into()),
        error => error,
    }
}

pub(crate) struct ProviderFailureRetry {
    provider: &'static str,
    initial_prompt: String,
    redactions: Vec<String>,
    used: bool,
}

pub(crate) struct ProviderFailure<'a> {
    pub(crate) detail: Option<&'a str>,
    pub(crate) retryable: bool,
    pub(crate) has_session: bool,
    pub(crate) deadline: Instant,
}

impl ProviderFailureRetry {
    pub(crate) fn new(
        provider: &'static str,
        initial_prompt: String,
        redactions: Vec<String>,
    ) -> Self {
        Self {
            provider,
            initial_prompt,
            redactions,
            used: false,
        }
    }

    pub(crate) async fn after_failure(
        &mut self,
        control: &DriverControl,
        failure: ProviderFailure<'_>,
    ) -> Result<String, NodeRunnerError> {
        let diagnostic =
            provider_failure_diagnostic(self.provider, failure.detail, None, &self.redactions);
        control
            .emit(LiveOutput::new(LiveOutputStream::Error, diagnostic)?)
            .await?;
        if !failure.retryable || self.used || Instant::now() >= failure.deadline {
            return Err(NodeRunnerError::Driver);
        }
        self.used = true;
        control
            .emit(LiveOutput::new(
                LiveOutputStream::System,
                format!("{} provider failed; continuing once", self.provider),
            )?)
            .await?;
        Ok(if failure.has_session {
            CONTINUE_PROMPT.to_owned()
        } else {
            self.initial_prompt.clone()
        })
    }

    pub(crate) async fn report_terminal(
        &self,
        control: &DriverControl,
        error: &NodeRunnerError,
    ) -> Result<(), NodeRunnerError> {
        let detail = match error {
            NodeRunnerError::Driver => None,
            NodeRunnerError::DriverDetail(detail) => Some(detail.as_str()),
            _ => return Ok(()),
        };
        let diagnostic = provider_failure_diagnostic(self.provider, detail, None, &self.redactions);
        control
            .emit(LiveOutput::new(LiveOutputStream::Error, diagnostic)?)
            .await?;
        Ok(())
    }
}

pub(crate) fn redaction_values<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut values = values
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    values.dedup();
    values
}

pub(crate) const fn effort_token(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

#[cfg(test)]
#[path = "provider_process/tests.rs"]
mod tests;
