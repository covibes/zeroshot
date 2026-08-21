use async_trait::async_trait;
use openengine_cluster_protocol::{
    HostedRunStreamFrame, RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams,
    RunStatusParams, RunWatchParams,
};
use reqwest::header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE};
use reqwest::{RequestBuilder, Response, Url};
use serde::de::DeserializeOwned;

use super::contract::{HostedRunsDescriptor, read_json, require_response_route};
use super::TargetHttpControlAuthority;
use zeroshot_engine::native_v2_cli::oecp::BoxedSubscription;
use zeroshot_engine::native_v2_cli::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
    CliSubscription, CliSubscriptionItem, NativeV2CliError,
};
use crate::native_v2_target::{TargetAccess, TargetAuthorityError, TargetRecord};

const NDJSON_MEDIA_TYPE: &str = "application/x-ndjson";
const MAX_STREAM_FRAME_BYTES: usize = 64 * 1024;

struct HostedRunSubscription<E> {
    response: Response,
    buffered: Vec<u8>,
    closed: bool,
    marker: std::marker::PhantomData<E>,
}

impl<E> HostedRunSubscription<E> {
    const fn new(response: Response) -> Self {
        Self {
            response,
            buffered: Vec::new(),
            closed: false,
            marker: std::marker::PhantomData,
        }
    }
}

#[async_trait]
impl<E> CliSubscription<E> for HostedRunSubscription<E>
where
    E: DeserializeOwned + Send,
{
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError> {
        if self.closed {
            return Ok(None);
        }
        loop {
            if let Some(line) = self.take_line() {
                return self.decode(&line).map(Some);
            }
            if self.buffered.len() > MAX_STREAM_FRAME_BYTES {
                return Err(stream_error("hosted run stream frame is too large"));
            }
            if !self.read_more().await? {
                return Ok(None);
            }
        }
    }
}

impl<E> HostedRunSubscription<E>
where
    E: DeserializeOwned,
{
    fn take_line(&mut self) -> Option<Vec<u8>> {
        let line_end = self.buffered.iter().position(|byte| *byte == b'\n')?;
        let mut line = self.buffered.drain(..=line_end).collect::<Vec<_>>();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        Some(line)
    }

    async fn read_more(&mut self) -> Result<bool, NativeV2CliError> {
        let chunk = self
            .response
            .chunk()
            .await
            .map_err(|_| NativeV2CliError::Disconnected)?;
        match chunk {
            Some(chunk) => {
                self.buffered.extend_from_slice(&chunk);
                Ok(true)
            }
            None if self.buffered.is_empty() => Ok(false),
            None => Err(NativeV2CliError::Disconnected),
        }
    }

    fn decode(&mut self, line: &[u8]) -> Result<CliSubscriptionItem<E>, NativeV2CliError> {
        if line.is_empty() || line.len() > MAX_STREAM_FRAME_BYTES {
            return Err(stream_error("hosted run stream frame is malformed"));
        }
        match serde_json::from_slice::<HostedRunStreamFrame<E>>(line)
            .map_err(|_| stream_error("hosted run stream frame is malformed"))?
        {
            HostedRunStreamFrame::Event { event } => Ok(CliSubscriptionItem::Event(event)),
            HostedRunStreamFrame::Closed { reason } => {
                self.closed = true;
                Ok(CliSubscriptionItem::Closed { reason })
            }
        }
    }
}

impl TargetHttpControlAuthority {
    async fn require_hosted_run_access(
        &self,
        target: &TargetRecord,
    ) -> Result<(HostedRunsDescriptor, String), TargetAuthorityError> {
        if matches!(target.access, TargetAccess::Direct) {
            return Err(TargetAuthorityError::new(
                "direct target does not use hosted run lifecycle",
            ));
        }
        let (auth, controller) = self.descriptors(target).await?;
        let routes = auth.hosted_runs.clone();
        let access = self
            .access_token(target, &auth, &controller.audience)
            .await?;
        Ok((routes, access))
    }

    async fn hosted_json<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
        url: &Url,
        operation: &'static str,
    ) -> Result<T, TargetAuthorityError> {
        let response = request.send().await.map_err(|_| {
            TargetAuthorityError::disconnected(format!("{operation} request failed"))
        })?;
        require_response_route(&response, url)?;
        if !response.status().is_success() {
            return Err(TargetAuthorityError::new(format!(
                "{operation} request failed with status {}",
                response.status().as_u16()
            )));
        }
        read_json(response, operation).await
    }

    async fn hosted_stream<E>(
        &self,
        url: Url,
        access: &str,
        operation: &'static str,
    ) -> Result<BoxedSubscription<E>, TargetAuthorityError>
    where
        E: DeserializeOwned + Send + 'static,
    {
        let response = self
            .authorized(self.stream_client.get(url.clone()), access)?
            .header(ACCEPT, NDJSON_MEDIA_TYPE)
            .header(CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| {
                TargetAuthorityError::disconnected(format!("{operation} request failed"))
            })?;
        require_response_route(&response, &url)?;
        if !response.status().is_success() {
            return Err(TargetAuthorityError::new(format!(
                "{operation} request failed with status {}",
                response.status().as_u16()
            )));
        }
        Ok(BoxedSubscription::new(HostedRunSubscription::new(response)))
    }
}

impl TargetHttpControlAuthority {
    pub(super) async fn hosted_run_list(
        &self,
        target: &TargetRecord,
        _params: RunListParams,
    ) -> Result<CliRunListResult, TargetAuthorityError> {
        let (routes, access) = self.require_hosted_run_access(target).await?;
        let url = routes.list_url()?;
        let request = self
            .authorized(self.client.get(url.clone()), &access)?
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store");
        self.hosted_json(request, &url, "hosted run list").await
    }

    pub(super) async fn hosted_run_status(
        &self,
        target: &TargetRecord,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, TargetAuthorityError> {
        let (routes, access) = self.require_hosted_run_access(target).await?;
        let url = routes.status_url(&params.run_id)?;
        let request = self
            .authorized(self.client.get(url.clone()), &access)?
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store");
        self.hosted_json(request, &url, "hosted run status").await
    }

    pub(super) async fn hosted_run_watch(
        &self,
        target: &TargetRecord,
        params: RunWatchParams,
    ) -> Result<BoxedSubscription<CliRunWatchEventNotification>, TargetAuthorityError> {
        let (routes, access) = self.require_hosted_run_access(target).await?;
        let url = routes.watch_url(&params.run_id, params.from_cursor.as_ref())?;
        self.hosted_stream(url, &access, "hosted run watch").await
    }

    pub(super) async fn hosted_run_logs(
        &self,
        target: &TargetRecord,
        params: RunLogsParams,
    ) -> Result<BoxedSubscription<RunLogEventNotification>, TargetAuthorityError> {
        let (routes, access) = self.require_hosted_run_access(target).await?;
        let url = routes.logs_url(
            &params.run_id,
            params.from_cursor.as_ref(),
            params.execution.as_ref(),
        )?;
        self.hosted_stream(url, &access, "hosted run logs").await
    }

    pub(super) async fn hosted_run_force(
        &self,
        target: &TargetRecord,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, TargetAuthorityError> {
        let (routes, access) = self.require_hosted_run_access(target).await?;
        let url = routes.force_url(&params.run_id)?;
        let request = self
            .authorized(self.client.post(url.clone()), &access)?
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .body("{}");
        self.hosted_json(request, &url, "hosted run force").await
    }
}

fn stream_error(message: &'static str) -> NativeV2CliError {
    NativeV2CliError::Target(message.to_owned())
}
