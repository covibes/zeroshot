use std::sync::Arc;

use openengine_cluster_protocol::RunId;
use tokio::sync::{Mutex, watch};

use crate::native_v2_contract::ExecutionRef;

#[derive(Clone, Default)]
pub(super) struct ProxyActivity {
    state: Arc<Mutex<ProxyActivityState>>,
}

#[derive(Default)]
struct ProxyActivityState {
    entries: Vec<ProxyExecution>,
    closed_runs: std::collections::BTreeSet<RunId>,
}

struct ProxyExecution {
    reference: ExecutionRef,
    cancellation: watch::Sender<bool>,
    closing: watch::Sender<bool>,
    closed: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

impl ProxyActivity {
    pub(super) async fn register(
        &self,
        reference: ExecutionRef,
        cancellation: watch::Sender<bool>,
    ) -> Result<ProxyRegistration, crate::native_v2_runner::NodeRunnerError> {
        let (closing, closing_receiver) = watch::channel(false);
        let (closed, closed_receiver) = watch::channel(false);
        let (done_sender, done) = watch::channel(false);
        let mut state = self.state.lock().await;
        if state.closed_runs.contains(&reference.run_id) {
            return Err(crate::native_v2_runner::NodeRunnerError::RunClosed);
        }
        if state
            .entries
            .iter()
            .any(|entry| entry.reference == reference)
        {
            return Err(crate::native_v2_runner::NodeRunnerError::ExecutionActive);
        }
        state.entries.push(ProxyExecution {
            reference,
            cancellation,
            closing,
            closed,
            done,
        });
        Ok(ProxyRegistration {
            closing: closing_receiver,
            closed: closed_receiver,
            done: done_sender,
        })
    }

    pub(super) async fn accept_start(
        &self,
        reference: &ExecutionRef,
        done: &watch::Sender<bool>,
        acceptance: tokio::sync::oneshot::Sender<()>,
    ) -> Result<(), crate::native_v2_runner::NodeRunnerError> {
        let expected = done.subscribe();
        let state = self.state.lock().await;
        if state.closed_runs.contains(&reference.run_id) {
            return Err(crate::native_v2_runner::NodeRunnerError::RunClosed);
        }
        if !state
            .entries
            .iter()
            .any(|entry| entry.reference == *reference && entry.done.same_channel(&expected))
        {
            return Err(crate::native_v2_runner::NodeRunnerError::Cancelled);
        }
        acceptance
            .send(())
            .map_err(|_| crate::native_v2_runner::NodeRunnerError::Cancelled)
    }

    pub(super) async fn finish(&self, reference: &ExecutionRef, done: &watch::Sender<bool>) {
        let expected = done.subscribe();
        let mut state = self.state.lock().await;
        if let Some(index) = state
            .entries
            .iter()
            .position(|entry| &entry.reference == reference && entry.done.same_channel(&expected))
        {
            state.entries.swap_remove(index);
        }
        done.send_replace(true);
    }

    pub(super) async fn begin_close(&self, run_id: &RunId) {
        let mut state = self.state.lock().await;
        state.closed_runs.insert(run_id.clone());
        signal_run(&state.entries, run_id, RunSignal::Closing);
    }

    pub(super) async fn complete_close(&self, run_id: &RunId) {
        self.signal_run(run_id, RunSignal::Closed).await;
    }

    async fn signal_run(&self, run_id: &RunId, signal: RunSignal) {
        let state = self.state.lock().await;
        signal_run(&state.entries, run_id, signal);
    }

    pub(super) async fn wait_run(&self, run_id: &RunId) {
        let mut completions = {
            let state = self.state.lock().await;
            state
                .entries
                .iter()
                .filter(|entry| &entry.reference.run_id == run_id)
                .map(|entry| entry.done.clone())
                .collect::<Vec<_>>()
        };
        for completion in &mut completions {
            while !*completion.borrow_and_update() {
                if completion.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

fn signal_run(entries: &[ProxyExecution], run_id: &RunId, signal: RunSignal) {
    for entry in entries
        .iter()
        .filter(|entry| &entry.reference.run_id == run_id)
    {
        signal.send(entry);
    }
}

#[derive(Clone, Copy)]
enum RunSignal {
    Closing,
    Closed,
}

impl RunSignal {
    fn send(self, execution: &ProxyExecution) {
        match self {
            Self::Closing => {
                execution.closing.send_replace(true);
                execution.cancellation.send_replace(true);
            }
            Self::Closed => {
                execution.closed.send_replace(true);
            }
        }
    }
}

pub(super) struct ProxyRegistration {
    pub(super) closing: watch::Receiver<bool>,
    pub(super) closed: watch::Receiver<bool>,
    pub(super) done: watch::Sender<bool>,
}
