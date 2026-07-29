//! Fail-closed mutual authorization for the native daemon WebSocket upgrade.
//!
//! The client proves possession of the locator capability without transmitting it, and the daemon
//! returns a domain-separated proof before the client sends Cluster Protocol bytes. Every rejected
//! route or credential receives the same response, before backend construction.

use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio_tungstenite::tungstenite::handshake::server::{Callback, ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::header::{InvalidHeaderValue, SEC_WEBSOCKET_KEY};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

use crate::daemon_discovery::{DaemonLocator, DiscoveryError, random_hex};

pub const DAEMON_ROUTE: &str = "/daemon/initialize";
pub const AUTHORIZATION_HEADER: &str = "authorization";
pub const PROFILE_DIGEST_HEADER: &str = "x-zeroshot-profile-digest";
pub const CLIENT_CHALLENGE_HEADER: &str = "x-zeroshot-client-challenge";
pub const CONNECTION_PURPOSE_HEADER: &str = "x-zeroshot-connection-purpose";
pub const SERVER_PROOF_HEADER: &str = "x-zeroshot-server-proof";
const AUTHORIZATION_PREFIX: &str = "Zeroshot-HMAC ";
const CLIENT_DOMAIN: &[u8] = b"zeroshot.daemon/v1/client-auth";
const SERVER_DOMAIN: &[u8] = b"zeroshot.daemon/v1/server-auth";
const HEX_256_LEN: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionPurpose {
    Session,
    Liveness,
}

impl ConnectionPurpose {
    fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Liveness => "liveness",
        }
    }

    fn parse(value: &[u8]) -> Option<Self> {
        match value {
            b"session" => Some(Self::Session),
            b"liveness" => Some(Self::Liveness),
            _ => None,
        }
    }
}

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

    pub fn apply_to_request(
        &self,
        request: &mut Request,
    ) -> Result<ServerProofExpectation, AuthBuildError> {
        self.prepare_request(request, ConnectionPurpose::Session)
    }

    pub fn prepare_request(
        &self,
        request: &mut Request,
        purpose: ConnectionPurpose,
    ) -> Result<ServerProofExpectation, AuthBuildError> {
        let websocket_key = request
            .headers()
            .get(SEC_WEBSOCKET_KEY)
            .ok_or(AuthBuildError::MissingWebSocketKey)?
            .as_bytes()
            .to_vec();
        let challenge = random_hex()?;
        let proof_context = ProofContext {
            challenge: &challenge,
            websocket_key: &websocket_key,
            purpose,
        };
        let request_proof = proof(CLIENT_DOMAIN, self, &proof_context);
        let server_proof = proof(SERVER_DOMAIN, self, &proof_context);
        request.headers_mut().insert(
            AUTHORIZATION_HEADER,
            HeaderValue::from_str(&format!("{AUTHORIZATION_PREFIX}{request_proof}"))?,
        );
        request.headers_mut().insert(
            PROFILE_DIGEST_HEADER,
            HeaderValue::from_str(&self.profile_digest)?,
        );
        request
            .headers_mut()
            .insert(CLIENT_CHALLENGE_HEADER, HeaderValue::from_str(&challenge)?);
        request.headers_mut().insert(
            CONNECTION_PURPOSE_HEADER,
            HeaderValue::from_static(purpose.as_str()),
        );
        Ok(ServerProofExpectation {
            expected: server_proof,
        })
    }
}

#[derive(Debug, Error)]
pub enum AuthBuildError {
    #[error("WebSocket request has no client handshake key")]
    MissingWebSocketKey,
    #[error("daemon authentication header is invalid")]
    InvalidHeader(#[from] InvalidHeaderValue),
    #[error("daemon authentication randomness failed: {0}")]
    Discovery(#[from] DiscoveryError),
}

#[derive(Debug)]
pub struct ServerProofExpectation {
    expected: String,
}

impl ServerProofExpectation {
    #[must_use]
    pub fn verify<B>(&self, response: &tokio_tungstenite::tungstenite::http::Response<B>) -> bool {
        exact_response_header(response, SERVER_PROOF_HEADER, self.expected.as_bytes())
    }
}

/// Exact request authorization. Query strings, alternate paths, duplicate/comma-joined headers,
/// malformed header text, and stale credentials all fail the same predicate.
#[must_use]
pub fn authorize_request(request: &Request, expected: &DaemonCredentials) -> bool {
    authorized_request(request, expected).is_some()
}

/// Server-side WebSocket upgrade callback plus its one-shot authenticated-purpose receipt.
pub struct AuthorizationCallback {
    expected: DaemonCredentials,
    receipt: AuthorizationReceipt,
}

#[derive(Clone)]
pub struct AuthorizationReceipt(Arc<Mutex<Option<ConnectionPurpose>>>);

impl AuthorizationCallback {
    pub fn new(expected: DaemonCredentials) -> (Self, AuthorizationReceipt) {
        let receipt = AuthorizationReceipt(Arc::new(Mutex::new(None)));
        (
            Self {
                expected,
                receipt: receipt.clone(),
            },
            receipt,
        )
    }
}

impl AuthorizationReceipt {
    pub fn take(&self) -> Option<ConnectionPurpose> {
        self.0.lock().ok()?.take()
    }
}

impl Callback for AuthorizationCallback {
    fn on_request(
        self,
        request: &Request,
        mut response: Response,
    ) -> Result<Response, ErrorResponse> {
        let Some(authorization) = authorized_request(request, &self.expected) else {
            return Err(uniform_rejection());
        };
        let proof = proof(SERVER_DOMAIN, &self.expected, &authorization);
        let Ok(proof) = HeaderValue::from_str(&proof) else {
            return Err(uniform_rejection());
        };
        response.headers_mut().insert(SERVER_PROOF_HEADER, proof);
        let Ok(mut accepted) = self.receipt.0.lock() else {
            return Err(uniform_rejection());
        };
        *accepted = Some(authorization.purpose);
        drop(accepted);
        Ok(response)
    }
}

struct ProofContext<'a> {
    challenge: &'a str,
    websocket_key: &'a [u8],
    purpose: ConnectionPurpose,
}

fn authorized_request<'a>(
    request: &'a Request,
    expected: &DaemonCredentials,
) -> Option<ProofContext<'a>> {
    if request.uri().path() != DAEMON_ROUTE || request.uri().query().is_some() {
        return None;
    }
    let profile = single_header(request, PROFILE_DIGEST_HEADER)?;
    if !constant_time_eq(profile, expected.profile_digest.as_bytes()) {
        return None;
    }
    let challenge = std::str::from_utf8(single_header(request, CLIENT_CHALLENGE_HEADER)?).ok()?;
    if !is_lower_hex(challenge, HEX_256_LEN) {
        return None;
    }
    let purpose = ConnectionPurpose::parse(single_header(request, CONNECTION_PURPOSE_HEADER)?)?;
    let websocket_key = single_header(request, SEC_WEBSOCKET_KEY.as_str())?;
    let presented = single_header(request, AUTHORIZATION_HEADER)?;
    let proof_context = ProofContext {
        challenge,
        websocket_key,
        purpose,
    };
    let request_proof = proof(CLIENT_DOMAIN, expected, &proof_context);
    let expected_authorization = format!("{AUTHORIZATION_PREFIX}{request_proof}");
    if !constant_time_eq(presented, expected_authorization.as_bytes()) {
        return None;
    }
    Some(proof_context)
}

fn proof(domain: &[u8], credentials: &DaemonCredentials, context: &ProofContext<'_>) -> String {
    let parts: [&[u8]; 6] = [
        DAEMON_ROUTE.as_bytes(),
        credentials.profile_digest.as_bytes(),
        credentials.daemon_nonce.as_bytes(),
        context.challenge.as_bytes(),
        context.websocket_key,
        context.purpose.as_str().as_bytes(),
    ];
    hex(&hmac_sha256(
        credentials.capability.as_bytes(),
        domain,
        &parts,
    ))
}

fn hmac_sha256(key: &[u8], domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    const BLOCK_BYTES: usize = 64;
    let mut key_block = [0_u8; BLOCK_BYTES];
    if key.len() > BLOCK_BYTES {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    update_proof_message(&mut inner, domain, parts);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn update_proof_message(hasher: &mut Sha256, domain: &[u8], parts: &[&[u8]]) {
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
}

fn single_header<'a>(request: &'a Request, name: &str) -> Option<&'a [u8]> {
    let mut values = request.headers().get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    Some(value.as_bytes())
}

fn exact_response_header<B>(
    response: &tokio_tungstenite::tungstenite::http::Response<B>,
    name: &str,
    expected: &[u8],
) -> bool {
    let mut values = response.headers().get_all(name).iter();
    let Some(value) = values.next() else {
        return false;
    };
    values.next().is_none() && constant_time_eq(value.as_bytes(), expected)
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

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn uniform_rejection() -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}
