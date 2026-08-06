use std::io;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::{timeout, Duration};

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
            return write_response(&mut stream, error.status, error_response(error.code)).await;
        }
        Err(_) => {
            return write_response(&mut stream, 408, error_response("request_timeout")).await;
        }
    };
    let (status, body) = dispatch_request(executor.as_ref(), request).await;
    write_response(&mut stream, status, body).await
}

struct HttpRequest {
    method: HttpMethod,
    identity: RunIntentIdentity,
    body: Vec<u8>,
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
    validate_body(head.method, head.content_length, &body)?;
    Ok(HttpRequest {
        method: head.method,
        identity: head.identity,
        body,
    })
}

struct RequestHead {
    method: HttpMethod,
    identity: RunIntentIdentity,
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
    let method = match request.method {
        Some("GET") => HttpMethod::Get,
        Some("PUT") => HttpMethod::Put,
        _ => {
            return Err(HttpError {
                status: 405,
                code: "method_not_allowed",
            });
        }
    };
    let identity = request_identity(request.path, request.headers, capability)?;
    let content_length = content_length(request.headers)?;
    if has_header(request.headers, "transfer-encoding") {
        return Err(bad_request("invalid_body_framing"));
    }
    Ok(RequestHead {
        method,
        identity,
        content_length,
        expect_continue: has_expect_continue(request.headers),
        header_end,
    })
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
    content_length: Option<usize>,
    body: &[u8],
) -> Result<(), HttpError> {
    match method {
        HttpMethod::Get if body.is_empty() => {}
        HttpMethod::Get => return Err(bad_request("invalid_body")),
        HttpMethod::Put if content_length.is_some() && !body.is_empty() => {}
        HttpMethod::Put => return Err(bad_request("invalid_body")),
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

fn request_identity(
    path: Option<&str>,
    headers: &[httparse::Header<'_>],
    capability: &TransportCapability,
) -> Result<RunIntentIdentity, HttpError> {
    let presented = one_header(headers, RUNTIME_CAPABILITY_HEADER)?
        .ok_or_else(|| bad_request("invalid_runtime_capability"))?;
    if !capability.matches(presented.as_bytes()) {
        return Err(HttpError {
            status: 401,
            code: "invalid_runtime_capability",
        });
    }
    let intent_id = path
        .and_then(|path| path.strip_prefix("/internal/run-intents/"))
        .filter(|value| !value.contains('/'))
        .filter(|value| canonical_intent_id(value))
        .ok_or_else(|| bad_request("invalid_intent_id"))?;
    let digest = one_header(headers, RUN_INTENT_DIGEST_HEADER)?
        .filter(|value| valid_digest(value))
        .ok_or_else(|| bad_request("invalid_digest"))?;
    Ok(RunIntentIdentity::new(
        intent_id.to_owned(),
        digest.to_owned(),
    ))
}

fn content_length(headers: &[httparse::Header<'_>]) -> Result<Option<usize>, HttpError> {
    let Some(value) = one_header(headers, "content-length")? else {
        return Ok(None);
    };
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(bad_request("invalid_content_length"));
    }
    let length = value
        .parse::<usize>()
        .map_err(|_| bad_request("invalid_content_length"))?;
    if length > MAX_RUN_INTENT_BYTES {
        return Err(HttpError {
            status: 413,
            code: "intent_too_large",
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

async fn dispatch_request(executor: &dyn RunIntentExecutor, request: HttpRequest) -> (u16, Value) {
    match request.method {
        HttpMethod::Put => dispatch_put(executor, request).await,
        HttpMethod::Get => match executor.lookup(&request.identity).await {
            RunIntentLookup::Found(status) => status_response(status, false),
            RunIntentLookup::NotFound => (404, error_response("intent_not_found")),
            RunIntentLookup::Conflict => (409, error_response("intent_conflict")),
        },
    }
}

async fn dispatch_put(executor: &dyn RunIntentExecutor, request: HttpRequest) -> (u16, Value) {
    let submission = match decode_submission(request.identity, &request.body) {
        Ok(submission) => submission,
        Err("digest_mismatch") => return (409, error_response("digest_mismatch")),
        Err(_) => return (400, error_response("invalid_run_intent")),
    };
    match executor.submit(submission).await {
        Ok(status) => status_response(status, true),
        Err(RunIntentSubmitError::Rejected) => (400, error_response("invalid_run_intent")),
        Err(RunIntentSubmitError::Conflict) => (409, error_response("intent_conflict")),
        Err(RunIntentSubmitError::Unavailable) => (503, error_response("runtime_unavailable")),
    }
}

fn status_response(status: RunIntentStatus, submitted: bool) -> (u16, Value) {
    match status {
        RunIntentStatus::Running => (
            if submitted { 202 } else { 200 },
            json!({ "state": "running" }),
        ),
        RunIntentStatus::Succeeded(result) => {
            (200, json!({ "state": "succeeded", "result": result }))
        }
        RunIntentStatus::Failed(error_code) => (422, error_response(error_code)),
    }
}

fn error_response(error_code: &'static str) -> Value {
    json!({ "state": "failed", "error_code": error_code })
}

async fn write_response<S>(stream: &mut S, status: u16, body: Value) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(&body)
        .map_err(|_| io::Error::other("run-intent response serialization failed"))?;
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
