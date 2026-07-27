//! A scripted `GraphVerifier` fixture: queued approve/reject/park/fail outcomes.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{CompiledGraphIr, GraphDiagnostic, GraphSpec};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError, VerifiedGraph};
use tokio::sync::{Mutex, Notify};

#[derive(Clone, Debug)]
pub enum ScriptedOutcome {
    Approve {
        compiled_ir: Box<CompiledGraphIr>,
        diagnostics: Vec<GraphDiagnostic>,
    },
    Reject {
        diagnostics: Vec<GraphDiagnostic>,
    },
    Park {
        barrier: VerifierBarrier,
        then: Box<ScriptedOutcome>,
    },
    Fail {
        message: String,
    },
}

impl ScriptedOutcome {
    #[must_use]
    pub fn approve(compiled_ir: CompiledGraphIr, diagnostics: Vec<GraphDiagnostic>) -> Self {
        Self::Approve {
            compiled_ir: Box::new(compiled_ir),
            diagnostics,
        }
    }

    #[must_use]
    pub fn reject(diagnostics: Vec<GraphDiagnostic>) -> Self {
        Self::Reject { diagnostics }
    }

    #[must_use]
    pub fn park(barrier: VerifierBarrier, then: Self) -> Self {
        Self::Park {
            barrier,
            then: Box::new(then),
        }
    }

    #[must_use]
    pub fn fail(message: impl Into<String>) -> Self {
        Self::Fail {
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct VerifierBarrier {
    inner: Arc<VerifierBarrierInner>,
}

#[derive(Debug, Default)]
struct VerifierBarrierInner {
    entered: AtomicBool,
    released: AtomicBool,
    entered_notify: Notify,
    released_notify: Notify,
}

impl VerifierBarrier {
    pub async fn wait_until_entered(&self) {
        while !self.inner.entered.load(Ordering::Acquire) {
            self.inner.entered_notify.notified().await;
        }
    }

    pub fn release(&self) {
        self.inner.released.store(true, Ordering::Release);
        self.inner.released_notify.notify_waiters();
    }

    async fn park(&self) {
        self.inner.entered.store(true, Ordering::Release);
        self.inner.entered_notify.notify_waiters();
        while !self.inner.released.load(Ordering::Acquire) {
            self.inner.released_notify.notified().await;
        }
    }
}

#[derive(Debug)]
pub struct ScriptedVerifier {
    outcomes: Mutex<VecDeque<ScriptedOutcome>>,
    calls: AtomicUsize,
}

impl ScriptedVerifier {
    #[must_use]
    pub fn new(outcomes: Vec<ScriptedOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into()),
            calls: AtomicUsize::new(0),
        }
    }

    #[must_use]
    pub fn call_count(&self) -> usize {
        self.calls.load(Ordering::Acquire)
    }
}

#[async_trait]
impl GraphVerifier for ScriptedVerifier {
    async fn verify(&self, _graph: &GraphSpec) -> Result<VerifiedGraph, VerificationError> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        let mut outcome = self.outcomes.lock().await.pop_front().ok_or_else(|| {
            VerificationError::Internal("scripted verifier queue exhausted".into())
        })?;
        loop {
            match outcome {
                ScriptedOutcome::Approve {
                    compiled_ir,
                    diagnostics,
                } => {
                    return Ok(VerifiedGraph {
                        compiled_ir: *compiled_ir,
                        diagnostics,
                    });
                }
                ScriptedOutcome::Reject { diagnostics } => {
                    return Err(VerificationError::Rejected { diagnostics });
                }
                ScriptedOutcome::Park { barrier, then } => {
                    barrier.park().await;
                    outcome = *then;
                }
                ScriptedOutcome::Fail { message } => {
                    return Err(VerificationError::Internal(message));
                }
            }
        }
    }
}
