//! Minimal `AgentAttachStore`/`ClusterBackend` fixture for exercising the `agent_attach` port
//! contract, independent of `openengine-cluster-testkit`'s production-shaped
//! `InMemoryAdmissionStore`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    AgentAttachEvent, AgentAttachParams, AgentAttachResult, ClusterStatus, ExecutionRef, GetParams,
    GetResult, InitializeParams, InitializeResult, ServerCapabilities, SubscriptionId,
};
use tokio::sync::{mpsc, Mutex};

use super::{
    default_agent_attach_error_mapping, subscribe_and_stream_agent_attach, AgentAttachEventStream,
    AgentAttachHandle, AgentAttachStore, AgentAttachStoreError, AgentAttachSubscription,
    SubscribeAndStreamAgentAttachRequest,
};
use crate::{BackendError, ClusterBackend, ConnectionContext};

#[derive(Default)]
struct ExecutionState {
    active: bool,
    live: Vec<(mpsc::Sender<AgentAttachEvent>, Arc<AtomicBool>)>,
}

/// A minimal in-process [`AgentAttachStore`] keyed by [`ExecutionRef`]: registering a ref via
/// [`Self::register_active`] makes it resolvable; [`Self::mark_inactive`] flips it to the `GONE`
/// path without removing it. No retained history: only live fan-out to every currently registered
/// subscriber. A slot whose bounded queue is full is marked overflowed and dropped from live
/// fan-out; a slot whose receiver has already been dropped (cancelled) is dropped silently.
#[derive(Default)]
pub struct AgentAttachFixtureStore {
    executions: Mutex<HashMap<ExecutionRef, ExecutionState>>,
}

impl AgentAttachFixtureStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register_active(&self, execution: ExecutionRef) {
        self.executions.lock().await.insert(
            execution,
            ExecutionState {
                active: true,
                live: Vec::new(),
            },
        );
    }

    pub async fn mark_inactive(&self, execution: &ExecutionRef) {
        if let Some(state) = self.executions.lock().await.get_mut(execution) {
            state.active = false;
        }
    }

    pub async fn publish(&self, execution: &ExecutionRef, event: AgentAttachEvent) {
        let mut executions = self.executions.lock().await;
        let Some(state) = executions.get_mut(execution) else {
            return;
        };
        state.live.retain(
            |(sender, overflowed)| match sender.try_send(event.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    overflowed.store(true, Ordering::Release);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
        );
    }
}

#[async_trait]
impl AgentAttachStore for AgentAttachFixtureStore {
    async fn subscribe(
        &self,
        execution: &ExecutionRef,
        queue_capacity: usize,
    ) -> Result<AgentAttachSubscription, AgentAttachStoreError> {
        let mut executions = self.executions.lock().await;
        let state = executions
            .get_mut(execution)
            .ok_or(AgentAttachStoreError::UnknownExecution)?;
        if !state.active {
            return Err(AgentAttachStoreError::InactiveExecution);
        }
        let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
        let overflowed = Arc::new(AtomicBool::new(false));
        state.live.push((sender, Arc::clone(&overflowed)));
        Ok(AgentAttachSubscription {
            receiver,
            overflowed,
        })
    }
}

/// Wraps an [`AgentAttachFixtureStore`] as a minimal [`ClusterBackend`] advertising
/// `agent_attach: true`; `initialize`/`get` return an empty status since this fixture exists only
/// to exercise `agent_attach`.
pub struct AgentAttachFixtureBackend {
    pub store: Arc<AgentAttachFixtureStore>,
    next_subscription_id: AtomicU64,
}

impl AgentAttachFixtureBackend {
    #[must_use]
    pub fn new(store: Arc<AgentAttachFixtureStore>) -> Self {
        Self {
            store,
            next_subscription_id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl ClusterBackend for AgentAttachFixtureBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities {
                agent_attach: true,
                ..ServerCapabilities::default()
            },
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult::empty())
    }

    async fn agent_attach(
        &self,
        _context: &ConnectionContext,
        params: AgentAttachParams,
        queue_capacity: usize,
    ) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
        let store: Arc<dyn AgentAttachStore> = Arc::clone(&self.store) as Arc<dyn AgentAttachStore>;
        let subscription_id = SubscriptionId::new(format!(
            "sub-{}",
            self.next_subscription_id.fetch_add(1, Ordering::Relaxed)
        ));
        subscribe_and_stream_agent_attach(
            &store,
            SubscribeAndStreamAgentAttachRequest {
                execution: params.execution,
                subscription_id,
                queue_capacity,
            },
            default_agent_attach_error_mapping,
        )
        .await
    }
}
