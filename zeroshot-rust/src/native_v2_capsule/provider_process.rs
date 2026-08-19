//! Shared contained-process mechanics for native-v2 agent harnesses.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::execution::SessionScope;
use crate::execution::process::{
    HostedProcessPool, HostedProcessScope, LocalProcessRunner, ProcessSessionOutput,
};
use crate::native_v2_contract::NodeRuntimeBinding;
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NodeRole, NodeRunnerError,
};
use crate::worker_catalog::ReasoningEffort;

const MAX_PROVIDER_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const CONTINUE_PROMPT: &str = "Continue";

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
    ) -> Result<(LocalProcessRunner, PathBuf), NodeRunnerError> {
        match self {
            Self::Hosted(pool) => {
                let identity = pool.identity(scope).map_err(|_| NodeRunnerError::Driver)?;
                let home = identity
                    .prepare_private_home(root)
                    .map_err(|_| NodeRunnerError::Driver)?;
                Ok((identity.runner(), home))
            }
            Self::Local => {
                let home = crate::execution::process::prepare_local_private_home(root, scope)
                    .map_err(|_| NodeRunnerError::Driver)?;
                Ok((LocalProcessRunner::new(), home))
            }
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

pub(crate) fn validate_process_output(
    output: &ProcessSessionOutput,
    control: &DriverControl,
) -> Result<(), NodeRunnerError> {
    validate_process_cleanup(output, control)?;
    if output.exit_code != Some(0) {
        return Err(NodeRunnerError::Driver);
    }
    Ok(())
}

pub(crate) fn validate_process_cleanup(
    output: &ProcessSessionOutput,
    control: &DriverControl,
) -> Result<(), NodeRunnerError> {
    if output.cancelled || control.is_cancelled() {
        return Err(NodeRunnerError::Cancelled);
    }
    if output.timed_out || !output.cleanup.proves_tree_empty() || output.post_launch_error.is_some()
    {
        return Err(NodeRunnerError::Driver);
    }
    Ok(())
}

pub(crate) fn provider_failure_diagnostic(
    provider: &str,
    detail: Option<&str>,
    output: Option<&ProcessSessionOutput>,
    redactions: &[String],
) -> String {
    let mut detail = detail
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            output.and_then(|process| {
                (!process.stderr_tail.is_empty())
                    .then(|| String::from_utf8_lossy(&process.stderr_tail).into_owned())
            })
        })
        .or_else(|| output.and_then(|process| process.post_launch_error.clone()))
        .unwrap_or_else(|| "execution failed without provider detail".to_owned());
    for value in redactions {
        detail = detail.replace(value, "[REDACTED]");
    }
    detail = detail
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect();
    let mut diagnostic = format!("{provider} provider failure: {}", detail.trim());
    if diagnostic.len() > MAX_PROVIDER_DIAGNOSTIC_BYTES {
        let mut end = MAX_PROVIDER_DIAGNOSTIC_BYTES.saturating_sub(3);
        while !diagnostic.is_char_boundary(end) {
            end -= 1;
        }
        diagnostic.truncate(end);
        diagnostic.push_str("...");
    }
    diagnostic
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

    pub(crate) fn after_failure(
        &mut self,
        control: &DriverControl,
        failure: ProviderFailure<'_>,
    ) -> Result<String, NodeRunnerError> {
        let diagnostic =
            provider_failure_diagnostic(self.provider, failure.detail, None, &self.redactions);
        control.emit(LiveOutput::new(LiveOutputStream::Error, diagnostic)?)?;
        if !failure.retryable || self.used || Instant::now() >= failure.deadline {
            return Err(NodeRunnerError::Driver);
        }
        self.used = true;
        control.emit(LiveOutput::new(
            LiveOutputStream::System,
            format!("{} provider failed; continuing once", self.provider),
        )?)?;
        Ok(if failure.has_session {
            CONTINUE_PROMPT.to_owned()
        } else {
            self.initial_prompt.clone()
        })
    }

    pub(crate) fn report_terminal(
        &self,
        control: &DriverControl,
        error: &NodeRunnerError,
    ) -> Result<(), NodeRunnerError> {
        if *error == NodeRunnerError::Driver {
            let diagnostic =
                provider_failure_diagnostic(self.provider, None, None, &self.redactions);
            control.emit(LiveOutput::new(LiveOutputStream::Error, diagnostic)?)?;
        }
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
mod tests {
    use super::*;

    #[test]
    fn closed_session_failure_maps_to_selected_runner_error() {
        let session = ProviderSessionCore::new();
        session.close();

        assert_eq!(
            session.ensure_live(ClosedSessionFailure::Driver),
            Err(NodeRunnerError::Driver)
        );
        assert_eq!(
            session.ensure_live(ClosedSessionFailure::SessionLost),
            Err(NodeRunnerError::SessionLost)
        );
    }

    #[test]
    fn provider_diagnostic_is_redacted_sanitized_and_bounded() {
        let detail = format!(
            "token=secret\u{0} {}",
            "x".repeat(MAX_PROVIDER_DIAGNOSTIC_BYTES)
        );
        let diagnostic =
            provider_failure_diagnostic("Codex", Some(&detail), None, &["secret".to_owned()]);

        assert!(diagnostic.starts_with("Codex provider failure: token=[REDACTED] "));
        assert!(!diagnostic.contains("secret"));
        assert!(!diagnostic.contains('\0'));
        assert_eq!(diagnostic.len(), MAX_PROVIDER_DIAGNOSTIC_BYTES);
        assert!(diagnostic.ends_with("..."));
    }
}
