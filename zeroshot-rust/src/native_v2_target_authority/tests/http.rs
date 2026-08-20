use std::net::SocketAddr;

use openengine_cluster_testkit::assertions::AssertValue;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub(super) struct TestHttpResponse {
    pub(super) status: u16,
    pub(super) body: Vec<u8>,
}

pub(super) struct TestHttpRequest<'a> {
    method: &'a str,
    path: &'a str,
    bearer: Option<&'a str>,
    body: &'a [u8],
}

impl<'a> TestHttpRequest<'a> {
    pub(super) fn empty(method: &'a str, path: &'a str, bearer: Option<&'a str>) -> Self {
        Self {
            method,
            path,
            bearer,
            body: &[],
        }
    }

    pub(super) fn body(
        method: &'a str,
        path: &'a str,
        bearer: Option<&'a str>,
        body: &'a [u8],
    ) -> Self {
        Self {
            method,
            path,
            bearer,
            body,
        }
    }
}

pub(super) async fn http(address: SocketAddr, request: TestHttpRequest<'_>) -> TestHttpResponse {
    let mut stream = TcpStream::connect(address).await.assert_value();
    let authorization = request
        .bearer
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let encoded = format!(
        "{} {} HTTP/1.1\r\nHost: {address}\r\n{authorization}Content-Length: {}\r\nConnection: close\r\n\r\n",
        request.method,
        request.path,
        request.body.len()
    );
    stream.write_all(encoded.as_bytes()).await.assert_value();
    stream.write_all(request.body).await.assert_value();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.assert_value();
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .assert_value();
    let head = std::str::from_utf8(response.get(..split).assert_value()).assert_value();
    let status = head
        .split_ascii_whitespace()
        .nth(1)
        .assert_value()
        .parse()
        .assert_value();
    let body_start = split.checked_add(4).assert_value();
    TestHttpResponse {
        status,
        body: response.get(body_start..).assert_value().to_vec(),
    }
}
