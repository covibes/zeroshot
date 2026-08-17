use std::io;
use std::sync::Arc;

use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    ConnectionBinding, StaticConnectionIdentityResolver, SystemConnectionTime,
};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::accept_async_with_config;
use url::Url;

use super::{
    DISCOVERY_PATH, NativeV2TargetAuthority, OECP_PATH, SESSION_PATH, SETUP_PATH,
    TargetAuthorityError, TargetAuthorityErrorKind, TargetDiscoveryDocument, TargetOecpSession,
    TargetSessionAuthority, TargetSetupDocument, TargetSetupResult,
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
            controller,
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
            ("POST", SESSION_PATH) if request.body.is_empty() => self.handle_session(request).await,
            _ => HttpResponse::empty(404),
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

#[derive(Clone)]
struct RequestHead {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    encoded_len: usize,
}

impl RequestHead {
    fn is_websocket_upgrade(&self) -> bool {
        self.header_exact("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    }

    fn header_exact(&self, name: &str) -> Option<&str> {
        let mut values = self
            .headers
            .iter()
            .filter(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_str());
        let value = values.next()?;
        if values.next().is_some() {
            return None;
        }
        Some(value)
    }

    fn bearer(&self) -> Result<&str, ()> {
        let value = self.header_exact("authorization").ok_or(())?;
        let token = value.strip_prefix("Bearer ").ok_or(())?;
        if valid_issued_bearer(token) {
            Ok(token)
        } else {
            Err(())
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    head: RequestHead,
    body: Vec<u8>,
}

async fn peek_request_head(stream: &TcpStream) -> io::Result<RequestHead> {
    let mut buffer = vec![0_u8; MAX_HEADER_BYTES];
    loop {
        let count = stream.peek(&mut buffer).await?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "empty request",
            ));
        }
        let bytes = buffer.get(..count).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "request peek exceeded buffer")
        })?;
        match parse_request_head(bytes)? {
            Some(head) => return Ok(head),
            None if count == buffer.len() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "request headers exceed limit",
                ));
            }
            None => tokio::time::sleep(std::time::Duration::from_millis(1)).await,
        }
    }
}

fn parse_request_head(bytes: &[u8]) -> io::Result<Option<RequestHead>> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    let encoded_len = match request.parse(bytes).map_err(invalid_http)? {
        httparse::Status::Complete(length) => length,
        httparse::Status::Partial => return Ok(None),
    };
    let method = request
        .method
        .ok_or_else(|| invalid_http("missing method"))?
        .to_owned();
    let path = request
        .path
        .ok_or_else(|| invalid_http("missing path"))?
        .to_owned();
    if !path.starts_with('/') || path.contains('?') || path.contains('#') {
        return Err(invalid_http("invalid request target"));
    }
    let headers = request
        .headers
        .iter()
        .map(|header| {
            let value = std::str::from_utf8(header.value).map_err(invalid_http)?;
            Ok((header.name.to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect::<io::Result<Vec<_>>>()?;
    Ok(Some(RequestHead {
        method,
        path,
        headers,
        encoded_len,
    }))
}

fn invalid_http(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

async fn read_http_request(stream: &mut TcpStream, head: RequestHead) -> io::Result<HttpRequest> {
    if head.header_exact("transfer-encoding").is_some() {
        return Err(invalid_http("transfer encoding is unsupported"));
    }
    let content_length = match head.header_exact("content-length") {
        Some(value) => value.parse::<usize>().map_err(invalid_http)?,
        None => 0,
    };
    if content_length > MAX_SETUP_BYTES {
        return Err(invalid_http("request body exceeds limit"));
    }
    let mut encoded = vec![0_u8; head.encoded_len.saturating_add(content_length)];
    stream.read_exact(&mut encoded).await?;
    let body = encoded.split_off(head.encoded_len);
    Ok(HttpRequest {
        method: head.method.clone(),
        path: head.path.clone(),
        head,
        body,
    })
}

struct HttpResponse {
    status: u16,
    content_type: Option<&'static str>,
    no_store: bool,
    body: Vec<u8>,
}

impl HttpResponse {
    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: None,
            no_store: false,
            body: Vec::new(),
        }
    }

    fn json(status: u16, value: &impl Serialize) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => Self {
                status,
                content_type: Some("application/json"),
                no_store: false,
                body,
            },
            Err(_) => Self::empty(500),
        }
    }

    fn private_json(status: u16, value: &impl Serialize) -> Self {
        let mut response = Self::json(status, value);
        response.no_store = true;
        response
    }
}

fn authority_error_response(error: TargetAuthorityError) -> HttpResponse {
    match error.kind() {
        TargetAuthorityErrorKind::Invalid => HttpResponse::empty(400),
        TargetAuthorityErrorKind::Unauthorized => HttpResponse::empty(401),
        TargetAuthorityErrorKind::Conflict => HttpResponse::empty(409),
        TargetAuthorityErrorKind::Unavailable => HttpResponse::empty(503),
    }
}

async fn write_and_close(mut stream: TcpStream, response: HttpResponse) -> io::Result<()> {
    write_http_response(&mut stream, response).await
}

async fn write_http_response(stream: &mut TcpStream, response: HttpResponse) -> io::Result<()> {
    let reason = http_reason(response.status);
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        reason,
        response.body.len()
    );
    if let Some(content_type) = response.content_type {
        head.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    if response.no_store {
        head.push_str("Cache-Control: no-store\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&response.body).await?;
    stream.shutdown().await
}

fn http_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}
