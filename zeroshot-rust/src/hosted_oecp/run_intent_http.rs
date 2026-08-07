use std::io;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::{timeout, Duration};

use super::credentials::{CredentialInstallError, CredentialInstaller, MAX_CREDENTIAL_BYTES};
use super::run_intent::{
    canonical_intent_id, decode_submission, valid_digest, RunIntentExecutor, RunIntentIdentity,
    RunIntentLookup, RunIntentStatus, RunIntentSubmitError, MAX_RUN_INTENT_BYTES,
    RUN_INTENT_DIGEST_HEADER,
};
use super::server_auth::{TransportCapability, RUNTIME_CAPABILITY_HEADER};

const MAX_HTTP_HEADER_BYTES: usize = 16 * 1_024;
const MAX_HTTP_HEADERS: usize = 32;
const REQUEST_READ_DEADLINE: Duration = Duration::from_secs(5);

pub(super) async fn serve_run_intent_http<S>(
    mut stream: S,
    credentials: Arc<dyn CredentialInstaller>,
    executor: Arc<dyn RunIntentExecutor>,
    capability: Arc<TransportCapability>,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let request = match timeout(
        REQUEST_READ_DEADLINE,
        read_request(&mut stream, capability.as_ref()),
    )
    .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            return write_response(&mut stream, error.status, Some(error_response(error.code)))
                .await;
        }
        Err(_) => {
            return write_response(&mut stream, 408, Some(error_response("request_timeout"))).await;
        }
    };
    let (status, body) = dispatch_request(credentials.as_ref(), executor.as_ref(), request).await;
    write_response(&mut stream, status, body).await
}

struct HttpRequest {
    method: HttpMethod,
    target: RequestTarget,
    body: Vec<u8>,
}

enum RequestTarget {
    Credentials,
    RunIntent(RunIntentIdentity),
}

#[derive(Clone, Copy)]
enum HttpMethod {
    Get,
    Put,
}

struct HttpError {
    status: u16,
    code: &'static str,
}

async fn read_request<S>(
    stream: &mut S,
    capability: &TransportCapability,
) -> Result<HttpRequest, HttpError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let bytes = read_headers(stream, Vec::new()).await?;
    let head = parse_request_head(&bytes, capability)?;
    if head.expect_continue {
        write_continue(stream).await?;
    }
    let body = read_body(
        stream,
        bytes[head.header_end..].to_vec(),
        head.content_length,
    )
    .await?;
    validate_body(head.method, &head.target, head.content_length, &body)?;
    Ok(HttpRequest {
        method: head.method,
        target: head.target,
        body,
    })
}

struct RequestHead {
    method: HttpMethod,
    target: RequestTarget,
    content_length: Option<usize>,
    expect_continue: bool,
    header_end: usize,
}

fn parse_request_head(
    bytes: &[u8],
    capability: &TransportCapability,
) -> Result<RequestHead, HttpError> {
    let mut parsed_headers = [httparse::EMPTY_HEADER; MAX_HTTP_HEADERS];
    let mut request = httparse::Request::new(&mut parsed_headers);
    let header_end = match request.parse(bytes) {
        Ok(httparse::Status::Complete(end)) => end,
        _ => return Err(bad_request("invalid_http_request")),
    };
    if request.version != Some(1) {
        return Err(bad_request("invalid_http_version"));
    }
    let method = parse_method(request.method)?;
    let target = request_target(request.path, request.headers, capability)?;
    let content_length = content_length(request.headers, body_limit(&target))?;
    if has_header(request.headers, "transfer-encoding") {
        return Err(bad_request("invalid_body_framing"));
    }
    Ok(RequestHead {
        method,
        target,
        content_length,
        expect_continue: has_expect_continue(request.headers),
        header_end,
    })
}

fn parse_method(method: Option<&str>) -> Result<HttpMethod, HttpError> {
    match method {
        Some("GET") => Ok(HttpMethod::Get),
        Some("PUT") => Ok(HttpMethod::Put),
        _ => Err(HttpError {
            status: 405,
            code: "method_not_allowed",
        }),
    }
}

fn body_limit(target: &RequestTarget) -> usize {
    match target {
        RequestTarget::Credentials => MAX_CREDENTIAL_BYTES,
        RequestTarget::RunIntent(_) => MAX_RUN_INTENT_BYTES,
    }
}

async fn write_continue<S>(stream: &mut S) -> Result<(), HttpError>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
        .await
        .map_err(|_| unavailable())?;
    stream.flush().await.map_err(|_| unavailable())
}

fn validate_body(
    method: HttpMethod,
    target: &RequestTarget,
    content_length: Option<usize>,
    body: &[u8],
) -> Result<(), HttpError> {
    match (method, target) {
        (HttpMethod::Get, RequestTarget::RunIntent(_)) if body.is_empty() => {}
        (HttpMethod::Put, _) if content_length.is_some() && !body.is_empty() => {}
        (HttpMethod::Get, RequestTarget::Credentials) => {
            return Err(HttpError {
                status: 405,
                code: "method_not_allowed",
            });
        }
        _ => return Err(bad_request("invalid_body")),
    }
    Ok(())
}

async fn read_headers<S>(stream: &mut S, mut bytes: Vec<u8>) -> Result<Vec<u8>, HttpError>
where
    S: AsyncRead + Unpin,
{
    loop {
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(bytes);
        }
        if bytes.len() >= MAX_HTTP_HEADER_BYTES {
            return Err(HttpError {
                status: 431,
                code: "headers_too_large",
            });
        }
        let mut chunk = [0; 1_024];
        let available = (MAX_HTTP_HEADER_BYTES - bytes.len()).min(chunk.len());
        let read = stream
            .read(&mut chunk[..available])
            .await
            .map_err(|_| unavailable())?;
        if read == 0 {
            return Err(bad_request("invalid_http_request"));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

fn request_target(
    path: Option<&str>,
    headers: &[httparse::Header<'_>],
    capability: &TransportCapability,
) -> Result<RequestTarget, HttpError> {
    let presented = one_header(headers, RUNTIME_CAPABILITY_HEADER)?
        .ok_or_else(|| bad_request("invalid_runtime_capability"))?;
    if !capability.matches(presented.as_bytes()) {
        return Err(HttpError {
            status: 401,
            code: "invalid_runtime_capability",
        });
    }
    if path == Some("/internal/credentials") {
        return Ok(RequestTarget::Credentials);
    }
    let intent_id = path
        .and_then(|path| path.strip_prefix("/internal/run-intents/"))
        .filter(|value| !value.contains('/'))
        .filter(|value| canonical_intent_id(value))
        .ok_or_else(|| bad_request("invalid_intent_id"))?;
    let digest = one_header(headers, RUN_INTENT_DIGEST_HEADER)?
        .filter(|value| valid_digest(value))
        .ok_or_else(|| bad_request("invalid_digest"))?;
    Ok(RequestTarget::RunIntent(RunIntentIdentity::new(
        intent_id.to_owned(),
        digest.to_owned(),
    )))
}

fn content_length(
    headers: &[httparse::Header<'_>],
    maximum: usize,
) -> Result<Option<usize>, HttpError> {
    let Some(value) = one_header(headers, "content-length")? else {
        return Ok(None);
    };
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(bad_request("invalid_content_length"));
    }
    let length = value
        .parse::<usize>()
        .map_err(|_| bad_request("invalid_content_length"))?;
    if length > maximum {
        return Err(HttpError {
            status: 413,
            code: "payload_too_large",
        });
    }
    Ok(Some(length))
}

fn one_header<'a>(
    headers: &'a [httparse::Header<'a>],
    name: &str,
) -> Result<Option<&'a str>, HttpError> {
    let mut values = headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case(name));
    let first = values.next();
    if values.next().is_some() {
        return Err(bad_request("ambiguous_header"));
    }
    first
        .map(|header| std::str::from_utf8(header.value).map_err(|_| bad_request("invalid_header")))
        .transpose()
}

fn has_header(headers: &[httparse::Header<'_>], name: &str) -> bool {
    headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case(name))
}

fn has_expect_continue(headers: &[httparse::Header<'_>]) -> bool {
    headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("expect")
            && header.value.eq_ignore_ascii_case(b"100-continue")
    })
}

async fn read_body<S>(
    stream: &mut S,
    mut body: Vec<u8>,
    content_length: Option<usize>,
) -> Result<Vec<u8>, HttpError>
where
    S: AsyncRead + Unpin,
{
    let expected = content_length.unwrap_or(0);
    if body.len() > expected {
        return Err(bad_request("invalid_body_framing"));
    }
    while body.len() < expected {
        let mut chunk = [0; 8 * 1_024];
        let remaining = expected - body.len();
        let read_len = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..read_len])
            .await
            .map_err(|_| unavailable())?;
        if read == 0 {
            return Err(bad_request("invalid_body"));
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Ok(body)
}

async fn dispatch_request(
    credentials: &dyn CredentialInstaller,
    executor: &dyn RunIntentExecutor,
    request: HttpRequest,
) -> (u16, Option<Value>) {
    match (request.method, request.target) {
        (HttpMethod::Put, RequestTarget::Credentials) => {
            dispatch_credentials(credentials, request.body).await
        }
        (HttpMethod::Put, RequestTarget::RunIntent(identity)) => {
            dispatch_put(executor, identity, &request.body).await
        }
        (HttpMethod::Get, RequestTarget::RunIntent(identity)) => {
            dispatch_get(executor, &identity).await
        }
        (HttpMethod::Get, RequestTarget::Credentials) => {
            (405, Some(error_response("method_not_allowed")))
        }
    }
}

async fn dispatch_credentials(
    credentials: &dyn CredentialInstaller,
    body: Vec<u8>,
) -> (u16, Option<Value>) {
    match credentials.install_credentials(body).await {
        Ok(()) => (204, None),
        Err(CredentialInstallError::Invalid) => (400, Some(error_response("invalid_credentials"))),
        Err(CredentialInstallError::Missing | CredentialInstallError::Conflict) => {
            (409, Some(error_response("credential_conflict")))
        }
    }
}

async fn dispatch_get(
    executor: &dyn RunIntentExecutor,
    identity: &RunIntentIdentity,
) -> (u16, Option<Value>) {
    match executor.lookup(identity).await {
        RunIntentLookup::Found(status) => status_response(status, false),
        RunIntentLookup::NotFound => (404, Some(error_response("intent_not_found"))),
        RunIntentLookup::Conflict => (409, Some(error_response("intent_conflict"))),
    }
}

async fn dispatch_put(
    executor: &dyn RunIntentExecutor,
    identity: RunIntentIdentity,
    body: &[u8],
) -> (u16, Option<Value>) {
    let submission = match decode_submission(identity, body) {
        Ok(submission) => submission,
        Err("digest_mismatch") => return (409, Some(error_response("digest_mismatch"))),
        Err(_) => return (400, Some(error_response("invalid_run_intent"))),
    };
    match executor.submit(submission).await {
        Ok(status) => status_response(status, true),
        Err(RunIntentSubmitError::Rejected) => (400, Some(error_response("invalid_run_intent"))),
        Err(RunIntentSubmitError::Conflict) => (409, Some(error_response("intent_conflict"))),
        Err(RunIntentSubmitError::Unavailable) => {
            (503, Some(error_response("runtime_unavailable")))
        }
    }
}

fn status_response(status: RunIntentStatus, submitted: bool) -> (u16, Option<Value>) {
    match status {
        RunIntentStatus::Running => (
            if submitted { 202 } else { 200 },
            Some(json!({ "state": "running" })),
        ),
        RunIntentStatus::Succeeded(result) => {
            (200, Some(json!({ "state": "succeeded", "result": result })))
        }
        RunIntentStatus::Failed(error_code) => (422, Some(error_response(error_code))),
    }
}

fn error_response(error_code: &'static str) -> Value {
    json!({ "state": "failed", "error_code": error_code })
}

async fn write_response<S>(stream: &mut S, status: u16, body: Option<Value>) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let body = body
        .map(|body| serde_json::to_vec(&body))
        .transpose()
        .map_err(|_| io::Error::other("task response serialization failed"))?
        .unwrap_or_default();
    let reason = status_reason(status);
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await
}

fn status_reason(status: u16) -> &'static str {
    const REASONS: &[(u16, &str)] = &[
        (200, "OK"),
        (202, "Accepted"),
        (204, "No Content"),
        (400, "Bad Request"),
        (401, "Unauthorized"),
        (404, "Not Found"),
        (405, "Method Not Allowed"),
        (408, "Request Timeout"),
        (409, "Conflict"),
        (413, "Payload Too Large"),
        (422, "Unprocessable Entity"),
        (431, "Request Header Fields Too Large"),
        (503, "Service Unavailable"),
    ];
    REASONS
        .iter()
        .find_map(|(candidate, reason)| (*candidate == status).then_some(*reason))
        .unwrap_or("Internal Server Error")
}

fn bad_request(code: &'static str) -> HttpError {
    HttpError { status: 400, code }
}

fn unavailable() -> HttpError {
    HttpError {
        status: 503,
        code: "runtime_unavailable",
    }
}
