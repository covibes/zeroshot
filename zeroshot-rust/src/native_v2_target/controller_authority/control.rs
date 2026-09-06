use async_trait::async_trait;
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionListRequest, ConnectionListResult,
    ConnectionMutationResult, ConnectionSetRequest,
};
use openengine_cluster_protocol::{
    RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams, RunStatusParams,
    RunSubmitResult, RunWatchParams,
};
use openengine_cluster_protocol::{RunProfile, RunProfileMutationResult, RunProfileRunRequest};
use openengine_cluster_protocol::{
    RunProfileDefaultRequest, RunProfileDefaultResult, RunProfileDeleteResult,
};
use openengine_cluster_protocol::{
    RunProfileListRequest, RunProfileListResult, RunProfileSelector, RunProfileSetRequest,
};
use reqwest::header::ACCEPT;
use zeroshot_engine::native_v2_cli::oecp::BoxedSubscription;
use zeroshot_engine::native_v2_cli::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
};
use zeroshot_engine::native_v2_target_authority::{
    TargetOecpSession, TargetRunReceipt, TargetRunRejection, TargetRunRequest,
};

use super::contract::{authority_error, read_json, require_response_route};
use super::{HostedLogin, TargetHttpControlAuthority};
use crate::native_v2_target::{
    TargetAccess, TargetAuthorityError, TargetControlAuthority, TargetOecpAccess, TargetRecord,
};

#[async_trait]
impl TargetControlAuthority for TargetHttpControlAuthority {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        match target.access {
            TargetAccess::Hosted { .. } => self.descriptors(target).await.map(|_| ()),
            TargetAccess::Direct => self.controller_descriptor(target).await.map(|_| ()),
        }
    }

    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError> {
        let device_token = target
            .access
            .device_token()
            .ok_or_else(|| authority_error("direct target does not use login"))?;
        let (auth, controller) = self.descriptors(target).await?;
        let _refresh_guard = self.lock_refresh_family(&target.id).await?;
        self.login_inner(HostedLogin {
            target_id: &target.id,
            device_token,
            auth: &auth,
            audience: &controller.audience,
        })
        .await
    }

    async fn submit(
        &self,
        target: &TargetRecord,
        request: &TargetRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError> {
        let (controller, access) = self.controller_access(target).await?;
        let response = self
            .with_access(
                self.client.post(controller.run_url.clone()),
                access.as_deref(),
            )?
            .header(ACCEPT, "application/json")
            .json(request)
            .send()
            .await
            .map_err(|_| TargetAuthorityError::disconnected("target run request failed"))?;
        require_response_route(&response, &controller.run_url)?;
        if response.status() == reqwest::StatusCode::BAD_REQUEST {
            return Err(target_run_rejection(response).await);
        }
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "target run request failed with status {}",
                response.status().as_u16()
            )));
        }
        let receipt: TargetRunReceipt = read_json(response, "target run").await?;
        Ok(RunSubmitResult {
            run_id: receipt.run_id,
        })
    }

    async fn oecp_session(
        &self,
        target: &TargetRecord,
        request: &openengine_cluster_protocol::TargetOecpSessionRequest,
    ) -> Result<TargetOecpAccess, TargetAuthorityError> {
        let (controller, access) = self.controller_access(target).await?;
        let response = self
            .with_access(
                self.client.post(controller.session_url.clone()),
                access.as_deref(),
            )?
            .header(ACCEPT, "application/json")
            .json(request)
            .send()
            .await
            .map_err(|_| {
                TargetAuthorityError::disconnected("target OECP session request failed")
            })?;
        require_response_route(&response, &controller.session_url)?;
        if !response.status().is_success() {
            return Err(authority_error(format!(
                "target OECP session request failed with status {}",
                response.status().as_u16()
            )));
        }
        let session: TargetOecpSession = read_json(response, "target OECP session").await?;
        TargetOecpAccess::new(session.endpoint, session.bearer_token, &target.access)
            .map_err(|_| authority_error("target OECP session response is malformed"))
    }

    async fn connection_list(
        &self,
        target: &TargetRecord,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, TargetAuthorityError> {
        TargetHttpControlAuthority::connection_list(self, target, request).await
    }

    async fn connection_set(
        &self,
        target: &TargetRecord,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, TargetAuthorityError> {
        TargetHttpControlAuthority::connection_set(self, target, request).await
    }

    async fn connection_delete(
        &self,
        target: &TargetRecord,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, TargetAuthorityError> {
        TargetHttpControlAuthority::connection_delete(self, target, request).await
    }

    async fn profile_list(
        &self,
        target: &TargetRecord,
        request: RunProfileListRequest,
    ) -> Result<RunProfileListResult, TargetAuthorityError> {
        TargetHttpControlAuthority::profile_list(self, target, request).await
    }

    async fn profile_show(
        &self,
        target: &TargetRecord,
        selector: RunProfileSelector,
    ) -> Result<RunProfile, TargetAuthorityError> {
        TargetHttpControlAuthority::profile_show(self, target, selector).await
    }

    async fn profile_set(
        &self,
        target: &TargetRecord,
        request: RunProfileSetRequest,
    ) -> Result<RunProfileMutationResult, TargetAuthorityError> {
        TargetHttpControlAuthority::profile_set(self, target, request).await
    }

    async fn profile_delete(
        &self,
        target: &TargetRecord,
        selector: RunProfileSelector,
    ) -> Result<RunProfileDeleteResult, TargetAuthorityError> {
        TargetHttpControlAuthority::profile_delete(self, target, selector).await
    }

    async fn profile_default(
        &self,
        target: &TargetRecord,
        request: RunProfileDefaultRequest,
    ) -> Result<RunProfileDefaultResult, TargetAuthorityError> {
        TargetHttpControlAuthority::profile_default(self, target, request).await
    }

    async fn profile_run(
        &self,
        target: &TargetRecord,
        request: &RunProfileRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError> {
        TargetHttpControlAuthority::profile_run(self, target, request).await
    }

    async fn hosted_run_list(
        &self,
        target: &TargetRecord,
        params: RunListParams,
    ) -> Result<CliRunListResult, TargetAuthorityError> {
        TargetHttpControlAuthority::hosted_run_list(self, target, params).await
    }

    async fn hosted_run_status(
        &self,
        target: &TargetRecord,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, TargetAuthorityError> {
        TargetHttpControlAuthority::hosted_run_status(self, target, params).await
    }

    async fn hosted_run_watch(
        &self,
        target: &TargetRecord,
        params: RunWatchParams,
    ) -> Result<BoxedSubscription<CliRunWatchEventNotification>, TargetAuthorityError> {
        TargetHttpControlAuthority::hosted_run_watch(self, target, params).await
    }

    async fn hosted_run_logs(
        &self,
        target: &TargetRecord,
        params: RunLogsParams,
    ) -> Result<BoxedSubscription<RunLogEventNotification>, TargetAuthorityError> {
        TargetHttpControlAuthority::hosted_run_logs(self, target, params).await
    }

    async fn hosted_run_force(
        &self,
        target: &TargetRecord,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, TargetAuthorityError> {
        TargetHttpControlAuthority::hosted_run_force(self, target, params).await
    }
}

async fn target_run_rejection(response: reqwest::Response) -> TargetAuthorityError {
    match read_json::<TargetRunRejection>(response, "target run rejection").await {
        Ok(rejection) => authority_error(format!(
            "target run request was rejected: {}",
            rejection.message()
        )),
        Err(_) => authority_error("target run request failed with status 400"),
    }
}
