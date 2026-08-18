use std::io;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GetParams, GetResult, InitializeParams, InitializeResult, RunAttachParams, RunAttachResult,
    RunForceParams, RunForceResult, RunListParams, RunListResult, RunLogsParams, RunLogsResult,
    RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult, RunWatchParams,
    RunWatchResult, RUN_CONFLICT,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    ConnectionBinding, StaticConnectionIdentityResolver, SystemConnectionTime,
};
use openengine_cluster_server::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunWatchEventStream,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::accept_async_with_config;
use url::Url;

use super::{
    DISCOVERY_PATH, NativeV2TargetAuthority, OECP_PATH, RUN_PATH, SESSION_PATH, SETUP_PATH,
    TargetAuthorityError, TargetDiscoveryDocument, TargetOecpSession, TargetRunIntent,
    TargetSessionAuthority, TargetSetupDocument, TargetSetupResult,
};
use crate::native_v2_cloud::NativeV2CloudController;

#[path = "transport_http.rs"]
mod http;
use http::{
    HttpRequest, HttpResponse, RequestHead, authority_error_response, peek_request_head,
    read_http_request, write_and_close, write_http_response,
};

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_SETUP_BYTES: usize = 1024 * 1024;
const MAX_BEARER_BYTES: usize = 16 * 1024;
const REQUEST_HEAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Concrete target-wide HTTP/WebSocket binding. TLS termination and OAuth remain host-owned;
/// this server consumes the already-issued controller bearer through [`TargetSessionAuthority`].
pub struct NativeV2TargetServer {
    target: Arc<NativeV2TargetAuthority>,
    sessions: Arc<dyn TargetSessionAuthority>,
    oecp_endpoint: String,
}

impl NativeV2TargetServer {
    pub fn new(
        target: Arc<NativeV2TargetAuthority>,
        sessions: Arc<dyn TargetSessionAuthority>,
        oecp_endpoint: impl Into<String>,
    ) -> Result<Self, TargetAuthorityError> {
        let endpoint = oecp_endpoint.into();
        validate_oecp_endpoint(&endpoint)?;
        Ok(Self {
            target,
            sessions,
            oecp_endpoint: endpoint,
        })
    }

    /// Serves a supplied listener. Cloud hosting may instead call [`Self::serve_connection`] from
    /// its existing listener/TLS lifecycle.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) -> io::Result<()> {
        loop {
            let (stream, _) = listener.accept().await?;
            let server = self.clone();
            tokio::spawn(async move {
                let _ = server.serve_connection(stream).await;
            });
        }
    }

    /// Routes one real TCP connection. WebSocket handshakes remain on the same target authority
    /// as discovery/setup/session, and the resulting OECP backend is the shared target controller.
    pub async fn serve_connection(&self, mut stream: TcpStream) -> io::Result<()> {
        let head = tokio::time::timeout(REQUEST_HEAD_TIMEOUT, peek_request_head(&stream))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request headers timed out"))??;
        if head.is_websocket_upgrade() {
            return self.serve_oecp(stream, head).await;
        }
        let request = read_http_request(&mut stream, head).await?;
        let response = self.handle_http(request).await;
        write_http_response(&mut stream, response).await
    }

    async fn serve_oecp(&self, stream: TcpStream, head: RequestHead) -> io::Result<()> {
        if head.method != "GET" || head.path != OECP_PATH {
            return write_and_close(stream, HttpResponse::empty(404)).await;
        }
        let bearer = match head.bearer() {
            Ok(value) => value,
            Err(()) => return write_and_close(stream, HttpResponse::empty(401)).await,
        };
        let identity = match self.sessions.authenticate_oecp(bearer).await {
            Ok(identity) => identity,
            Err(error) => return write_and_close(stream, authority_error_response(error)).await,
        };
        let controller = match self.target.controller().await {
            Ok(controller) => controller,
            Err(error) => {
                return write_and_close(stream, authority_error_response(error)).await;
            }
        };
        let websocket = accept_async_with_config(
            stream,
            Some(openengine_cluster_server::websocket::websocket_config()),
        )
        .await
        .map_err(io::Error::other)?;
        let binding = ConnectionBinding::new(
            Arc::new(TargetOecpBackend { controller }),
            StaticConnectionIdentityResolver::new(identity),
            SystemConnectionTime,
            CancellationSignal::default(),
        );
        openengine_cluster_server::websocket::serve_websocket(binding, websocket).await
    }

    async fn handle_http(&self, request: HttpRequest) -> HttpResponse {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", DISCOVERY_PATH) if request.body.is_empty() => {
                HttpResponse::json(200, &TargetDiscoveryDocument::default())
            }
            ("PUT", SETUP_PATH) => self.handle_setup(request).await,
            ("POST", RUN_PATH) => self.handle_run(request).await,
            ("POST", SESSION_PATH) if request.body.is_empty() => self.handle_session(request).await,
            _ => HttpResponse::empty(404),
        }
    }

    async fn handle_run(&self, request: HttpRequest) -> HttpResponse {
        if let Err(error) = self.authenticate_control(&request.head).await {
            return authority_error_response(error);
        }
        let intent = match serde_json::from_slice::<TargetRunIntent>(&request.body) {
            Ok(intent) => intent,
            Err(_) => return HttpResponse::empty(400),
        };
        match self.target.submit(intent).await {
            Ok(receipt) => HttpResponse::private_json(200, &receipt),
            Err(error) => authority_error_response(error),
        }
    }

    async fn handle_setup(&self, request: HttpRequest) -> HttpResponse {
        if let Err(error) = self.authenticate_control(&request.head).await {
            return authority_error_response(error);
        }
        let setup = match serde_json::from_slice::<TargetSetupDocument>(&request.body) {
            Ok(setup) => setup,
            Err(_) => return HttpResponse::empty(400),
        };
        match self.target.install(setup).await {
            Ok(outcome) => HttpResponse::json(200, &TargetSetupResult { outcome }),
            Err(error) => authority_error_response(error),
        }
    }

    async fn handle_session(&self, request: HttpRequest) -> HttpResponse {
        let identity = match self.authenticate_control(&request.head).await {
            Ok(identity) => identity,
            Err(error) => return authority_error_response(error),
        };
        if let Err(error) = self.target.controller().await {
            return authority_error_response(error);
        }
        match self.sessions.issue_oecp(&identity).await {
            Ok(bearer_token) if valid_issued_bearer(&bearer_token) => HttpResponse::private_json(
                200,
                &TargetOecpSession {
                    endpoint: self.oecp_endpoint.clone(),
                    bearer_token,
                },
            ),
            _ => HttpResponse::empty(503),
        }
    }

    async fn authenticate_control(
        &self,
        head: &RequestHead,
    ) -> Result<openengine_cluster_server::identity::ConnectionIdentity, TargetAuthorityError> {
        let bearer = head
            .bearer()
            .map_err(|()| TargetAuthorityError::unauthorized())?;
        self.sessions.authenticate_control(bearer).await
    }
}

/// Target OECP is an observation/control surface. Host-owned HTTP submission is the only route
/// that may assign a run identity, resolve source, and select the exact environment.
struct TargetOecpBackend {
    controller: Arc<NativeV2CloudController>,
}

#[async_trait]
impl ClusterBackend for TargetOecpBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        ClusterBackend::initialize(self.controller.as_ref(), context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        ClusterBackend::get(self.controller.as_ref(), context, params).await
    }

    async fn run_submit(
        &self,
        _context: &ConnectionContext,
        _params: RunSubmitParams,
    ) -> Result<RunSubmitResult, BackendError> {
        Err(BackendError::application(
            RUN_CONFLICT,
            "target OECP does not accept run submissions",
            None,
        ))
    }

    async fn run_list(
        &self,
        context: &ConnectionContext,
        params: RunListParams,
    ) -> Result<RunListResult, BackendError> {
        ClusterBackend::run_list(self.controller.as_ref(), context, params).await
    }

    async fn run_status(
        &self,
        context: &ConnectionContext,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, BackendError> {
        ClusterBackend::run_status(self.controller.as_ref(), context, params).await
    }

    async fn run_watch(
        &self,
        context: &ConnectionContext,
        params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchEventStream), BackendError> {
        ClusterBackend::run_watch(self.controller.as_ref(), context, params).await
    }

    async fn run_logs(
        &self,
        context: &ConnectionContext,
        params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogEventStream), BackendError> {
        ClusterBackend::run_logs(self.controller.as_ref(), context, params).await
    }

    async fn run_attach(
        &self,
        context: &ConnectionContext,
        params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachEventStream), BackendError> {
        ClusterBackend::run_attach(self.controller.as_ref(), context, params).await
    }

    async fn run_force(
        &self,
        context: &ConnectionContext,
        params: RunForceParams,
    ) -> Result<RunForceResult, BackendError> {
        ClusterBackend::run_force(self.controller.as_ref(), context, params).await
    }
}

fn validate_oecp_endpoint(endpoint: &str) -> Result<(), TargetAuthorityError> {
    let url = Url::parse(endpoint)
        .map_err(|_| TargetAuthorityError::invalid("OECP endpoint must be an absolute URL"))?;
    if !matches!(url.scheme(), "ws" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != OECP_PATH
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(TargetAuthorityError::invalid(
            "OECP endpoint must be an authority URL ending in /native-v2/oecp",
        ));
    }
    Ok(())
}

fn valid_issued_bearer(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_BEARER_BYTES
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}
