use std::io;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GetParams, GetResult, InitializeParams, InitializeResult, RunAttachParams, RunAttachResult,
    RunForceParams, RunForceResult, RunListParams, RunListResult, RunLogsParams, RunLogsResult,
    RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult, RunWatchParams,
    RunWatchResult, TargetOecpSessionRequest, TargetPrivateBootstrapRequest,
    TARGET_PRIVATE_BOOTSTRAP_PATH, is_canonical_uuid_v7, RUN_CONFLICT,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    ConnectionBinding, ConnectionIdentity, StaticConnectionIdentityResolver, SystemConnectionTime,
};
use openengine_cluster_server::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunWatchEventStream,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::accept_async_with_config;
use url::Url;

use super::{
    DISCOVERY_PATH, NativeV2TargetAuthority, OECP_PATH, RUN_PATH, SESSION_PATH,
    TargetAuthorityError, TargetDiscoveryDocument, TargetOecpSession, TargetRunRequest,
    TargetAuthentication, TargetSessionAuthority,
};
use crate::native_v2_cloud::NativeV2CloudController;
use super::private_access::{PrivateTargetAccess, TargetBootstrapKey};

#[path = "transport_http.rs"]
mod http;
use http::{
    HttpRequest, HttpResponse, RequestHead, authority_error_response, peek_request_head,
    run_error_response, read_http_request, write_and_close, write_http_response,
};

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_PRIVATE_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_BEARER_BYTES: usize = 16 * 1024;
const REQUEST_HEAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Concrete target-wide HTTP/WebSocket binding. Hosted access consumes bearer authority supplied
/// by its host. Explicit direct access uses one static target identity and no Authorization.
pub struct NativeV2TargetServer {
    target: Arc<NativeV2TargetAuthority>,
    access: TargetServerAccess,
    oecp_endpoint: String,
}

enum TargetServerAccess {
    Hosted(Arc<dyn TargetSessionAuthority>),
    Private {
        access: Arc<PrivateTargetAccess>,
        identity: ConnectionIdentity,
    },
    Direct(ConnectionIdentity),
}

impl TargetServerAccess {
    const fn authentication(&self) -> TargetAuthentication {
        match self {
            Self::Hosted(_) => TargetAuthentication::HostedOauth,
            Self::Private { .. } => TargetAuthentication::PrivateCapability,
            Self::Direct(_) => TargetAuthentication::None,
        }
    }
}

impl NativeV2TargetServer {
    pub fn new_hosted(
        target: Arc<NativeV2TargetAuthority>,
        sessions: Arc<dyn TargetSessionAuthority>,
        oecp_endpoint: impl Into<String>,
    ) -> Result<Self, TargetAuthorityError> {
        let endpoint = oecp_endpoint.into();
        validate_oecp_endpoint(&endpoint)?;
        Ok(Self {
            target,
            access: TargetServerAccess::Hosted(sessions),
            oecp_endpoint: endpoint,
        })
    }

    pub fn new_direct(
        target: Arc<NativeV2TargetAuthority>,
        identity: ConnectionIdentity,
        oecp_endpoint: impl Into<String>,
    ) -> Result<Self, TargetAuthorityError> {
        let endpoint = oecp_endpoint.into();
        validate_oecp_endpoint(&endpoint)?;
        Ok(Self {
            target,
            access: TargetServerAccess::Direct(identity),
            oecp_endpoint: endpoint,
        })
    }

    pub fn new_private(
        target: Arc<NativeV2TargetAuthority>,
        identity: ConnectionIdentity,
        oecp_endpoint: impl Into<String>,
        bootstrap_key: TargetBootstrapKey,
    ) -> Result<Self, TargetAuthorityError> {
        let endpoint = oecp_endpoint.into();
        validate_oecp_endpoint(&endpoint)?;
        Ok(Self {
            target,
            access: TargetServerAccess::Private {
                access: Arc::new(PrivateTargetAccess::new(bootstrap_key)),
                identity,
            },
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
    /// as discovery/session, and the resulting OECP backend is the shared target controller.
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
        let identity = match self.authenticate_oecp(&head).await {
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
            ("GET", DISCOVERY_PATH) if request.body.is_empty() => HttpResponse::json(
                200,
                &TargetDiscoveryDocument::direct(self.access.authentication()),
            ),
            ("POST", TARGET_PRIVATE_BOOTSTRAP_PATH) => self.handle_private_bootstrap(request).await,
            ("POST", RUN_PATH) => self.handle_run(request).await,
            ("POST", SESSION_PATH) => self.handle_session(request).await,
            _ => HttpResponse::empty(404),
        }
    }

    async fn handle_private_bootstrap(&self, request: HttpRequest) -> HttpResponse {
        let TargetServerAccess::Private { access, .. } = &self.access else {
            return HttpResponse::empty(404);
        };
        let request = match serde_json::from_slice::<TargetPrivateBootstrapRequest>(&request.body) {
            Ok(request) => request,
            Err(_) => return HttpResponse::empty(400),
        };
        match access.bootstrap(&request).await {
            Ok(()) => HttpResponse::empty(204),
            Err(error) if error.kind() == super::TargetAuthorityErrorKind::Unavailable => {
                HttpResponse::empty(404)
            }
            Err(error) => authority_error_response(error),
        }
    }

    async fn handle_run(&self, request: HttpRequest) -> HttpResponse {
        if let Err(error) = self.authenticate_control(&request.head).await {
            return authority_error_response(error);
        }
        let submission = match serde_json::from_slice::<TargetRunRequest>(&request.body) {
            Ok(submission) => submission,
            Err(_) => return HttpResponse::empty(400),
        };
        if !is_canonical_uuid_v7(&submission.run_id) {
            return HttpResponse::empty(400);
        }
        match self.target.submit(submission).await {
            Ok(receipt) => HttpResponse::private_json(200, &receipt),
            Err(error) => run_error_response(error),
        }
    }

    async fn handle_session(&self, request: HttpRequest) -> HttpResponse {
        let identity = match self.authenticate_control(&request.head).await {
            Ok(identity) => identity,
            Err(error) => return authority_error_response(error),
        };
        let session_request =
            match serde_json::from_slice::<TargetOecpSessionRequest>(&request.body) {
                Ok(request) if request.run_id.as_ref().is_none_or(is_canonical_uuid_v7) => request,
                _ => return HttpResponse::empty(400),
            };
        if let Err(error) = self.target.controller().await {
            return authority_error_response(error);
        }
        self.issue_session(&identity, &session_request).await
    }

    async fn issue_session(
        &self,
        identity: &openengine_cluster_server::identity::ConnectionIdentity,
        request: &TargetOecpSessionRequest,
    ) -> HttpResponse {
        match &self.access {
            TargetServerAccess::Hosted(sessions) => {
                match sessions.issue_oecp(identity, request).await {
                    Ok(bearer_token) if valid_issued_bearer(&bearer_token) => {
                        HttpResponse::private_json(
                            200,
                            &TargetOecpSession {
                                endpoint: self.oecp_endpoint.clone(),
                                bearer_token: Some(bearer_token),
                            },
                        )
                    }
                    _ => HttpResponse::empty(503),
                }
            }
            TargetServerAccess::Private { access, .. } => match access.token().await {
                Ok(bearer_token) => HttpResponse::private_json(
                    200,
                    &TargetOecpSession {
                        endpoint: self.oecp_endpoint.clone(),
                        bearer_token: Some(bearer_token),
                    },
                ),
                Err(error) => authority_error_response(error),
            },
            TargetServerAccess::Direct(_) => HttpResponse::private_json(
                200,
                &TargetOecpSession {
                    endpoint: self.oecp_endpoint.clone(),
                    bearer_token: None,
                },
            ),
        }
    }

    async fn authenticate_control(
        &self,
        head: &RequestHead,
    ) -> Result<openengine_cluster_server::identity::ConnectionIdentity, TargetAuthorityError> {
        self.authenticate(head, BearerPurpose::Control).await
    }

    async fn authenticate_oecp(
        &self,
        head: &RequestHead,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        self.authenticate(head, BearerPurpose::Oecp).await
    }

    async fn authenticate(
        &self,
        head: &RequestHead,
        purpose: BearerPurpose,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        match &self.access {
            TargetServerAccess::Hosted(sessions) => {
                let bearer = head
                    .bearer()
                    .map_err(|()| TargetAuthorityError::unauthorized())?;
                match purpose {
                    BearerPurpose::Control => sessions.authenticate_control(bearer).await,
                    BearerPurpose::Oecp => sessions.authenticate_oecp(bearer).await,
                }
            }
            TargetServerAccess::Private { access, identity } => {
                let bearer = head
                    .bearer()
                    .map_err(|()| TargetAuthorityError::unauthorized())?;
                access.authenticate(bearer).await?;
                Ok(identity.clone())
            }
            TargetServerAccess::Direct(identity) => Ok(identity.clone()),
        }
    }
}

#[derive(Clone, Copy)]
enum BearerPurpose {
    Control,
    Oecp,
}

/// Target OECP is an observation/control surface. HTTP submission is the only route that accepts
/// a caller-assigned run identity, exact source, and bounded environment.
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
