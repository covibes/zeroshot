use std::io;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::super::{TargetAuthorityError, TargetAuthorityErrorKind};
use super::{MAX_HEADER_BYTES, MAX_PRIVATE_REQUEST_BYTES, valid_issued_bearer};

#[derive(Clone)]
pub(super) struct RequestHead {
    pub(super) method: String,
    pub(super) path: String,
    headers: Vec<(String, String)>,
    encoded_len: usize,
}

impl RequestHead {
    pub(super) fn is_websocket_upgrade(&self) -> bool {
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

    pub(super) fn bearer(&self) -> Result<&str, ()> {
        let value = self.header_exact("authorization").ok_or(())?;
        let token = value.strip_prefix("Bearer ").ok_or(())?;
        if valid_issued_bearer(token) {
            Ok(token)
        } else {
            Err(())
        }
    }
}

pub(super) struct HttpRequest {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) head: RequestHead,
    pub(super) body: Vec<u8>,
}

pub(super) async fn peek_request_head(stream: &TcpStream) -> io::Result<RequestHead> {
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

pub(super) async fn read_http_request(
    stream: &mut TcpStream,
    head: RequestHead,
) -> io::Result<HttpRequest> {
    if head.header_exact("transfer-encoding").is_some() {
        return Err(invalid_http("transfer encoding is unsupported"));
    }
    let content_length = match head.header_exact("content-length") {
        Some(value) => value.parse::<usize>().map_err(invalid_http)?,
        None => 0,
    };
    if content_length > MAX_PRIVATE_REQUEST_BYTES {
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

pub(super) struct HttpResponse {
    status: u16,
    content_type: Option<&'static str>,
    no_store: bool,
    body: Vec<u8>,
}

impl HttpResponse {
    pub(super) fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: None,
            no_store: false,
            body: Vec::new(),
        }
    }

    pub(super) fn json(status: u16, value: &impl Serialize) -> Self {
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

    pub(super) fn private_json(status: u16, value: &impl Serialize) -> Self {
        let mut response = Self::json(status, value);
        response.no_store = true;
        response
    }
}

pub(super) fn authority_error_response(error: TargetAuthorityError) -> HttpResponse {
    match error.kind() {
        TargetAuthorityErrorKind::Invalid => HttpResponse::empty(400),
        TargetAuthorityErrorKind::Unauthorized => HttpResponse::empty(401),
        TargetAuthorityErrorKind::Conflict => HttpResponse::empty(409),
        TargetAuthorityErrorKind::Unavailable => HttpResponse::empty(503),
    }
}

pub(super) fn run_error_response(error: TargetAuthorityError) -> HttpResponse {
    if error.kind() != TargetAuthorityErrorKind::Invalid {
        return authority_error_response(error);
    }
    match super::super::TargetRunRejection::new(error.message()) {
        Ok(rejection) => HttpResponse::private_json(400, &rejection),
        Err(_) => HttpResponse::empty(400),
    }
}

pub(super) async fn write_and_close(
    mut stream: TcpStream,
    response: HttpResponse,
) -> io::Result<()> {
    write_http_response(&mut stream, response).await
}

pub(super) async fn write_http_response(
    stream: &mut TcpStream,
    response: HttpResponse,
) -> io::Result<()> {
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
