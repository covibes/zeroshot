//! Backend-neutral Cluster Protocol dispatcher and transport-neutral connection core.

pub mod admission;
pub mod agent_attach;
pub mod graph_verifier;
pub mod lifecycle;
pub mod logs;
pub mod stdio;
pub mod watch;
pub mod websocket;
pub mod worker_registry;

mod connection;
mod dispatch;
mod subscription_stream;
mod wire;
pub(crate) use wire::{serialize_backend_error, serialize_error, serialize_success};

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    AgentAttachParams, AgentAttachResult, ApplyParams, ApplyResult, DeleteParams, DeleteResult,
    GetParams, GetResult, InitializeParams, InitializeResult, LogsParams, LogsResult, PlanParams,
    PlanResult, INVALID_PHASE, ResubmitParams, ResubmitResult, RetryParams, RetryResult,
    StopParams, StopResult, UpdateParams, UpdateResult, WatchParams, WatchResult,
};
use serde_json::Value;
use thiserror::Error;

use crate::agent_attach::{AgentAttachEventStream, AgentAttachHandle};
use crate::logs::{LogEventStream, LogsHandle};
use crate::watch::{WatchEventStream, WatchHandle};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConnectionContext {
    pub peer_label: Option<String>,
    pub cancellation: admission::CancellationSignal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendErrorKind {
    Internal,
    InvalidParams,
    Application,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct BackendError {
    pub kind: BackendErrorKind,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl BackendError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: BackendErrorKind::Internal,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn invalid_params(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            kind: BackendErrorKind::InvalidParams,
            code: code.into(),
            message: message.into(),
            details,
        }
    }

    #[must_use]
    pub fn application(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            kind: BackendErrorKind::Application,
            code: code.into(),
            message: message.into(),
            details,
        }
    }
}

#[async_trait]
pub trait ClusterBackend: Send + Sync + 'static {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError>;

    async fn plan(
        &self,
        _context: &ConnectionContext,
        _params: PlanParams,
    ) -> Result<PlanResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not admit graphs",
            None,
        ))
    }

    async fn apply(
        &self,
        _context: &ConnectionContext,
        _params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not admit graphs",
            None,
        ))
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError>;

    async fn update(
        &self,
        _context: &ConnectionContext,
        _params: UpdateParams,
    ) -> Result<UpdateResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle updates",
            None,
        ))
    }

    async fn stop(
        &self,
        _context: &ConnectionContext,
        _params: StopParams,
    ) -> Result<StopResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle stop",
            None,
        ))
    }

    async fn retry(
        &self,
        _context: &ConnectionContext,
        _params: RetryParams,
    ) -> Result<RetryResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle retry",
            None,
        ))
    }

    async fn resubmit(
        &self,
        _context: &ConnectionContext,
        _params: ResubmitParams,
    ) -> Result<ResubmitResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle resubmit",
            None,
        ))
    }

    async fn delete(
        &self,
        _context: &ConnectionContext,
        _params: DeleteParams,
    ) -> Result<DeleteResult, BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support lifecycle delete",
            None,
        ))
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        _params: WatchParams,
        _queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support watch",
            None,
        ))
    }

    async fn logs(
        &self,
        _context: &ConnectionContext,
        _params: LogsParams,
        _queue_capacity: usize,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support logs",
            None,
        ))
    }

    async fn agent_attach(
        &self,
        _context: &ConnectionContext,
        _params: AgentAttachParams,
        _queue_capacity: usize,
    ) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
        Err(BackendError::application(
            INVALID_PHASE,
            "Backend does not support agent attach",
            None,
        ))
    }
}

pub struct Dispatcher<B> {
    backend: Arc<B>,
    context: ConnectionContext,
}

impl<B> Clone for Dispatcher<B> {
    fn clone(&self) -> Self {
        Self {
            backend: Arc::clone(&self.backend),
            context: self.context.clone(),
        }
    }
}
