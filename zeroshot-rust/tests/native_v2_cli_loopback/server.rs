use super::*;

mod hosted_runs;

use hosted_runs::{HostedRunState, serve_hosted_run};

struct TestSessions;

#[async_trait]
impl TargetSessionAuthority for TestSessions {
    async fn authenticate_control(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        (bearer_token == "control-token")
            .then(test_identity)
            .ok_or_else(TargetAuthorityError::unauthorized)
    }

    async fn issue_oecp(
        &self,
        _identity: &ConnectionIdentity,
        _request: &TargetOecpSessionRequest,
    ) -> Result<String, TargetAuthorityError> {
        Ok("oecp-token".to_owned())
    }

    async fn authenticate_oecp(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        (bearer_token == "oecp-token")
            .then(test_identity)
            .ok_or_else(TargetAuthorityError::unauthorized)
    }
}

fn test_identity() -> ConnectionIdentity {
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("acceptance-user"),
        tenant: TenantId::new("acceptance-target"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    })
}

pub(crate) struct LoopbackHost {
    pub(crate) origin: String,
    task: tokio::task::JoinHandle<()>,
}

impl LoopbackHost {
    pub(crate) async fn start() -> Self {
        Self::start_with_factory(Arc::new(TestControllerFactory)).await
    }

    pub(crate) async fn start_with_factory(factory: Arc<dyn TargetControllerFactory>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
        let address = listener.local_addr().assert_value();
        let origin = format!("http://{address}");
        let authority = Arc::new(NativeV2TargetAuthority::new(factory));
        let native = Arc::new(
            NativeV2TargetServer::new_hosted(
                authority.clone(),
                Arc::new(TestSessions),
                format!("ws://{address}/native-v2/oecp"),
            )
            .assert_value(),
        );
        let hosted_runs = Arc::new(HostedRunState::default());
        let hosted_origin = origin.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.assert_value();
                let native = native.clone();
                let authority = authority.clone();
                let hosted_runs = hosted_runs.clone();
                let hosted_origin = hosted_origin.clone();
                tokio::spawn(async move {
                    let path = peek_path(&stream).await.assert_value();
                    if is_hosted_auth_path(&path) {
                        serve_hosted_auth(stream, &hosted_origin)
                            .await
                            .assert_value();
                    } else if path.starts_with("/native-v2/runs") {
                        if let Err(error) = serve_hosted_run(stream, authority, hosted_runs).await {
                            assert!(
                                matches!(
                                    error.kind(),
                                    io::ErrorKind::BrokenPipe
                                        | io::ErrorKind::ConnectionReset
                                        | io::ErrorKind::UnexpectedEof
                                ),
                                "hosted run route failed: {error}"
                            );
                        }
                    } else {
                        native.serve_connection(stream).await.assert_value();
                    }
                });
            }
        });
        Self { origin, task }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum LiveLane {
    CodexOpenAi,
    CodexOpenRouter,
    ClaudeAnthropic,
    ClaudeOpenRouter,
}

impl LiveLane {
    pub(crate) fn from_environment() -> Self {
        match std::env::var("ZEROSHOT_NATIVE_V2_LIVE_LANE").as_deref() {
            Ok("codex-openai") => Self::CodexOpenAi,
            Ok("codex-openrouter") => Self::CodexOpenRouter,
            Ok("claude-anthropic") => Self::ClaudeAnthropic,
            Ok("claude-openrouter") => Self::ClaudeOpenRouter,
            _ => None::<Self>.assert_value_with(
                "ZEROSHOT_NATIVE_V2_LIVE_LANE must be codex-openai, codex-openrouter, \
                 claude-anthropic, or claude-openrouter",
            ),
        }
    }

    pub(crate) const fn harness(self) -> &'static str {
        match self {
            Self::CodexOpenAi | Self::CodexOpenRouter => "codex",
            Self::ClaudeAnthropic | Self::ClaudeOpenRouter => "claude",
        }
    }

    pub(crate) const fn provider(self) -> &'static str {
        match self {
            Self::CodexOpenAi => "openai",
            Self::CodexOpenRouter | Self::ClaudeOpenRouter => "openrouter",
            Self::ClaudeAnthropic => "anthropic",
        }
    }

    pub(crate) const fn model(self) -> &'static str {
        match self {
            Self::CodexOpenAi | Self::CodexOpenRouter => "gpt-5.6-sol",
            Self::ClaudeAnthropic | Self::ClaudeOpenRouter => "claude-sonnet-5",
        }
    }

    pub(crate) const fn credential_name(self) -> &'static str {
        match self {
            Self::CodexOpenAi => "OPENAI_API_KEY",
            Self::CodexOpenRouter | Self::ClaudeOpenRouter => "OPENROUTER_API_KEY",
            Self::ClaudeAnthropic => "ANTHROPIC_API_KEY",
        }
    }

    pub(crate) const fn sentinel(self) -> &'static str {
        match self {
            Self::CodexOpenAi => "native-v2-codex-openai-ok",
            Self::CodexOpenRouter => "native-v2-codex-openrouter-ok",
            Self::ClaudeAnthropic => "native-v2-claude-anthropic-ok",
            Self::ClaudeOpenRouter => "native-v2-claude-openrouter-ok",
        }
    }

    pub(crate) const fn uses_codex(self) -> bool {
        matches!(self, Self::CodexOpenAi | Self::CodexOpenRouter)
    }
}

impl Drop for LoopbackHost {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn is_hosted_auth_path(path: &str) -> bool {
    matches!(
        path,
        HOSTED_DISCOVERY_PATH
            | "/oauth/metadata"
            | "/oauth/device"
            | "/oauth/token"
            | "/oauth/revoke"
            | "/session"
    )
}

async fn peek_path(stream: &TcpStream) -> io::Result<String> {
    let mut bytes = [0_u8; 8192];
    let count = stream.peek(&mut bytes).await?;
    let line_end = bytes
        .get(..count)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid read length"))?
        .windows(2)
        .position(|window| window == b"\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "incomplete request line"))?;
    let line = std::str::from_utf8(
        bytes
            .get(..line_end)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid line length"))?,
    )
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request line is not UTF-8"))?;
    line.split_ascii_whitespace()
        .nth(1)
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "request path is missing"))
}

async fn serve_hosted_auth(mut stream: TcpStream, origin: &str) -> io::Result<()> {
    let request = read_request(&mut stream).await?;
    let body = match (request.method.as_str(), request.path.as_str()) {
        ("GET", HOSTED_DISCOVERY_PATH) => json!({
            "kind":"zeroshot.native-v2-target/v2",
            "authentication":"hosted_oauth",
            "runPath":"/native-v2/run",
            "sessionPath":"/native-v2/oecp-session",
            "oecpPath":"/native-v2/oecp",
            "audience":"controller",
            "oauth":{
                "metadataUrl":format!("{origin}/oauth/metadata"),
                "deviceAuthorizationEndpoint":format!("{origin}/oauth/device"),
                "tokenEndpoint":format!("{origin}/oauth/token"),
                "revocationEndpoint":format!("{origin}/oauth/revoke"),
                "clientId":"zeroshot-cli",
                "deviceGrantType":"urn:ietf:params:oauth:grant-type:device_code",
                "deviceExchangeFields":["device_token","device_label"]
            },
            "loginSession":{
                "routeTemplate":"/session",
                "method":"GET",
                "cachePolicy":"no-store"
            },
            "extensions":{
                "hosted_runs":{
                    "kind":"zeroshot.hosted-runs/v1",
                    "base_url":origin,
                    "route_templates":{
                        "list":"/native-v2/runs",
                        "status":"/native-v2/runs/{run_id}",
                        "watch":"/native-v2/runs/{run_id}/watch{?from_cursor}",
                        "logs":"/native-v2/runs/{run_id}/logs{?from_cursor,execution}",
                        "force":"/native-v2/runs/{run_id}/force"
                    }
                }
            }
        }),
        ("GET", "/oauth/metadata") => json!({
            "device_authorization_endpoint":format!("{origin}/oauth/device"),
            "token_endpoint":format!("{origin}/oauth/token"),
            "revocation_endpoint":format!("{origin}/oauth/revoke")
        }),
        ("POST", "/oauth/device") => json!({
            "device_code":"acceptance-device-code",
            "user_code":"ABCD-EFGH",
            "verification_uri":format!("{origin}/activate"),
            "expires_in":60,
            "interval":0
        }),
        ("POST", "/oauth/token") => {
            assert!(request.body.contains("audience=controller"));
            json!({
                "access_token":"control-token",
                "refresh_token":"refresh-token",
                "token_type":"Bearer",
                "expires_in":3600,
                "refresh_expires_in":86400,
                "scope":"controller"
            })
        }
        ("GET", "/session") => {
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer control-token")
            );
            json!({
                "kind":"openengine.target-session/v1",
                "organization_id":"acceptance-organization"
            })
        }
        unexpected => None::<serde_json::Value>
            .assert_value_with(&format!("unexpected hosted auth request: {unexpected:?}")),
    };
    write_json_response(&mut stream, &body).await
}

struct HttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

struct HttpRequestHead {
    method: String,
    path: String,
    authorization: Option<String>,
    content_length: usize,
}

async fn read_more(
    stream: &mut TcpStream,
    bytes: &mut Vec<u8>,
    eof_message: &'static str,
) -> io::Result<()> {
    let mut chunk = [0_u8; 4096];
    let count = stream.read(&mut chunk).await?;
    if count == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, eof_message));
    }
    bytes.extend_from_slice(
        chunk
            .get(..count)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid read length"))?,
    );
    Ok(())
}

async fn read_headers(stream: &mut TcpStream) -> io::Result<(Vec<u8>, usize)> {
    let mut bytes = Vec::new();
    let header_end = loop {
        read_more(stream, &mut bytes, "request headers ended early").await?;
        if bytes.len() > 128 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    Ok((bytes, header_end))
}

fn request_header<'a>(headers: &'a [httparse::Header<'a>], name: &str) -> Option<&'a [u8]> {
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value)
}

fn parse_request_head(bytes: &[u8], header_end: usize) -> io::Result<HttpRequestHead> {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut parsed = httparse::Request::new(&mut headers);
    parsed
        .parse(
            bytes.get(..header_end).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid header length")
            })?,
        )
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request is malformed"))?;
    let content_length = request_header(parsed.headers, "content-length")
        .map(|header| {
            std::str::from_utf8(header)
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "content length is malformed")
                })
        })
        .transpose()?
        .unwrap_or(0);
    let authorization = request_header(parsed.headers, "authorization")
        .and_then(|header| std::str::from_utf8(header).ok())
        .map(str::to_owned);

    Ok(HttpRequestHead {
        method: parsed.method.unwrap_or_default().to_owned(),
        path: parsed.path.unwrap_or_default().to_owned(),
        authorization,
        content_length,
    })
}

async fn read_request(stream: &mut TcpStream) -> io::Result<HttpRequest> {
    let (mut bytes, header_end) = read_headers(stream).await?;
    let head = parse_request_head(&bytes, header_end)?;
    while bytes.len() < header_end + head.content_length {
        read_more(stream, &mut bytes, "request body ended early").await?;
    }
    Ok(HttpRequest {
        method: head.method,
        path: head.path,
        authorization: head.authorization,
        body: String::from_utf8(
            bytes
                .get(header_end..header_end + head.content_length)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid body length"))?
                .to_vec(),
        )
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request body is not UTF-8"))?,
    })
}

async fn write_json_response(stream: &mut TcpStream, body: &serde_json::Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(body).assert_value();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&bytes).await?;
    stream.shutdown().await
}

use openengine_cluster_testkit::assertions::{AssertValue};
