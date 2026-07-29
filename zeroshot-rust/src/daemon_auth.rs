//! Fail-closed authorization for the native daemon WebSocket upgrade.
//!
//! Every rejected route or credential receives the same response. Authorization completes in the
//! HTTP upgrade callback, before a backend is constructed or any Cluster Protocol bytes are read.

use tokio_tungstenite::tungstenite::handshake::server::{
    Callback, ErrorResponse, Request, Response,
};
use tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

use crate::daemon_discovery::{DaemonLocator, DiscoveryError, random_hex};

pub const DAEMON_ROUTE: &str = "/daemon/initialize";
pub const AUTHORIZATION_HEADER: &str = "authorization";
pub const PROFILE_DIGEST_HEADER: &str = "x-zeroshot-profile-digest";
pub const DAEMON_NONCE_HEADER: &str = "x-zeroshot-daemon-nonce";
const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaemonCredentials {
    pub profile_digest: String,
    pub daemon_nonce: String,
    pub capability: String,
}

impl DaemonCredentials {
    pub fn generate(profile_digest: impl Into<String>) -> Result<Self, DiscoveryError> {
        Ok(Self {
            profile_digest: profile_digest.into(),
            daemon_nonce: random_hex()?,
            capability: random_hex()?,
        })
    }

    #[must_use]
    pub fn from_locator(locator: &DaemonLocator) -> Self {
        Self {
            profile_digest: locator.profile_digest.clone(),
            daemon_nonce: locator.daemon_nonce.clone(),
            capability: locator.capability.clone(),
        }
    }

    pub fn apply_to_request(&self, request: &mut Request) -> Result<(), InvalidHeaderValue> {
        let authorization = HeaderValue::from_str(&format!("{BEARER_PREFIX}{}", self.capability))?;
        let profile = HeaderValue::from_str(&self.profile_digest)?;
        let nonce = HeaderValue::from_str(&self.daemon_nonce)?;
        request
            .headers_mut()
            .insert(AUTHORIZATION_HEADER, authorization);
        request
            .headers_mut()
            .insert(PROFILE_DIGEST_HEADER, profile);
        request.headers_mut().insert(DAEMON_NONCE_HEADER, nonce);
        Ok(())
    }
}

/// Exact request authorization. Query strings, alternate paths, duplicate/comma-joined headers,
/// malformed header text, and stale values all fail the same predicate.
#[must_use]
pub fn authorize_request(request: &Request, expected: &DaemonCredentials) -> bool {
    if request.uri().path() != DAEMON_ROUTE || request.uri().query().is_some() {
        return false;
    }
    let expected_bearer = format!("{BEARER_PREFIX}{}", expected.capability);
    exact_header(request, AUTHORIZATION_HEADER, expected_bearer.as_bytes())
        && exact_header(
            request,
            PROFILE_DIGEST_HEADER,
            expected.profile_digest.as_bytes(),
        )
        && exact_header(
            request,
            DAEMON_NONCE_HEADER,
            expected.daemon_nonce.as_bytes(),
        )
}

pub(crate) struct AuthorizationCallback(pub DaemonCredentials);

impl Callback for AuthorizationCallback {
    fn on_request(
        self,
        request: &Request,
        response: Response,
    ) -> Result<Response, ErrorResponse> {
        if authorize_request(request, &self.0) {
            Ok(response)
        } else {
            Err(uniform_rejection())
        }
    }
}

fn exact_header(request: &Request, name: &'static str, expected: &[u8]) -> bool {
    let mut values = request.headers().get_all(name).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    constant_time_eq(value.as_bytes(), expected)
}

fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    let mut difference = actual.len() ^ expected.len();
    let compared_len = actual.len().max(expected.len());
    for index in 0..compared_len {
        let left = actual.get(index).copied().unwrap_or(0);
        let right = expected.get(index).copied().unwrap_or(0);
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

fn uniform_rejection() -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}
