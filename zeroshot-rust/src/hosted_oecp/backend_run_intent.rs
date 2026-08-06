use openengine_cluster_protocol::{ApplyParams, Phase};
use openengine_cluster_server::{BackendError, ConnectionContext};

use super::backend::HostedBackend;
use super::backend_support::{
    second_apply_error, validate_apply, validate_graph_input, validate_request,
};

impl HostedBackend {
    pub(super) async fn reserve_run_intent(
        &self,
        params: &ApplyParams,
    ) -> Result<(), BackendError> {
        validate_apply(params)?;
        validate_graph_input(params)?;
        validate_request(params, &self.authority)?;
        match self
            .reserve_apply(&ConnectionContext::default(), params)
            .await?
        {
            None => Ok(()),
            Some(_) => Err(second_apply_error(params, params)),
        }
    }

    pub(super) async fn release_run_intent_reservation(&self, params: &ApplyParams) {
        let mut state = self.state.lock().await;
        if state.admission.as_ref() == Some(params) && state.committed.is_none() {
            state.phase = Phase::Empty;
            state.admission = None;
            drop(state);
            self.changed.notify_waiters();
        }
    }

    pub(super) async fn run_intent_platform_failure(&self) -> bool {
        let state = self.state.lock().await;
        state.shutting_down
            || state.shutdown_forced_run
            || (state.terminal_failure && state.terminal_failure_retryable)
    }
}
