use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::DEVICE_GRANT;
use crate::native_v2_target::{TargetAuthorityError, TargetRecord};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
pub(super) struct HostedDiscoveryWire {
    pub(super) kind: String,
    pub(super) oauth: OAuthDiscoveryWire,
    pub(super) session: SessionDiscoveryWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OAuthDiscoveryWire {
    pub(super) metadata_url: String,
    pub(super) device_authorization_endpoint: String,
    pub(super) token_endpoint: String,
    pub(super) revocation_endpoint: String,
    pub(super) client_id: String,
    pub(super) device_grant_type: String,
    pub(super) device_exchange_fields: Vec<String>,
    pub(super) audience: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SessionDiscoveryWire {
    pub(super) route_template: String,
    pub(super) method: String,
    pub(super) cache_policy: String,
}

#[derive(Deserialize)]
pub(super) struct OAuthMetadataWire {
    pub(super) device_authorization_endpoint: String,
    pub(super) token_endpoint: String,
    pub(super) revocation_endpoint: String,
}

pub(super) struct HostedAuthDescriptor {
    pub(super) metadata_url: Url,
    pub(super) device_authorization_endpoint: Url,
    pub(super) token_endpoint: Url,
    pub(super) revocation_endpoint: Url,
    pub(super) client_id: String,
    pub(super) device_grant_type: String,
    pub(super) session_endpoint: Url,
}

pub(super) struct ControllerDescriptor {
    pub(super) setup_url: Url,
    pub(super) session_url: Url,
    pub(super) audience: String,
}

pub(super) struct DevicePoll<'a> {
    pub(super) target: &'a TargetRecord,
    pub(super) auth: &'a HostedAuthDescriptor,
    pub(super) audience: &'a str,
    pub(super) code: &'a DeviceCodeWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DeviceCodeWire {
    pub(super) device_code: String,
    pub(super) user_code: String,
    pub(super) verification_uri: String,
    pub(super) verification_uri_complete: Option<String>,
    pub(super) expires_in: u64,
    pub(super) interval: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TokenWire {
    pub(super) access_token: String,
    pub(super) refresh_token: String,
    pub(super) token_type: String,
    pub(super) expires_in: u64,
    pub(super) refresh_expires_in: u64,
    pub(super) scope: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OAuthErrorWire {
    pub(super) error: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TargetSessionWire {
    pub(super) kind: String,
    pub(super) organization_id: String,
}

pub(super) fn parse_origin(origin: &str) -> Result<Url, TargetAuthorityError> {
    Url::parse(origin).map_err(|_| authority_error("stored target origin is invalid"))
}

pub(super) fn same_origin_url(origin: &Url, value: &str) -> Result<Url, TargetAuthorityError> {
    if value
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(authority_error("target route is invalid"));
    }
    let url = Url::parse(value).map_err(|_| authority_error("target route is invalid"))?;
    if url.origin() != origin.origin()
        || url.as_str() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(authority_error("target route changed authority"));
    }
    Ok(url)
}

pub(super) fn same_origin_path(origin: &Url, path: &str) -> Result<Url, TargetAuthorityError> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('?')
        || path.contains('#')
        || path.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(authority_error("target route path is invalid"));
    }
    let url = origin
        .join(path)
        .map_err(|_| authority_error("target route path is invalid"))?;
    same_origin_url(origin, url.as_str())
}

pub(super) fn require_response_route(
    response: &reqwest::Response,
    expected: &Url,
) -> Result<(), TargetAuthorityError> {
    if response.url() != expected {
        return Err(authority_error(
            "target response changed route or authority",
        ));
    }
    Ok(())
}

pub(super) async fn read_json<T: DeserializeOwned>(
    mut response: reqwest::Response,
    operation: &'static str,
) -> Result<T, TargetAuthorityError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(authority_error(format!(
            "{operation} response is too large"
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| authority_error(format!("{operation} response read failed")))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(authority_error(format!(
                "{operation} response is too large"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| authority_error(format!("{operation} response is malformed")))
}

pub(super) fn validate_hosted_discovery(
    wire: &HostedDiscoveryWire,
) -> Result<(), TargetAuthorityError> {
    let valid = wire.kind == "openengine.hosted-target/v1"
        && wire.oauth.device_grant_type == DEVICE_GRANT
        && valid_device_exchange_fields(&wire.oauth.device_exchange_fields)
        && wire.oauth.audience == "capsule"
        && valid_session_discovery(&wire.session);
    if !valid {
        return Err(authority_error("hosted target discovery is incompatible"));
    }
    Ok(())
}

pub(super) fn build_auth_descriptor(
    origin: &Url,
    wire: HostedDiscoveryWire,
) -> Result<HostedAuthDescriptor, TargetAuthorityError> {
    Ok(HostedAuthDescriptor {
        metadata_url: same_origin_url(origin, &wire.oauth.metadata_url)?,
        device_authorization_endpoint: same_origin_url(
            origin,
            &wire.oauth.device_authorization_endpoint,
        )?,
        token_endpoint: same_origin_url(origin, &wire.oauth.token_endpoint)?,
        revocation_endpoint: same_origin_url(origin, &wire.oauth.revocation_endpoint)?,
        client_id: bounded_value(&wire.oauth.client_id, 256, "OAuth client ID")?,
        device_grant_type: wire.oauth.device_grant_type,
        session_endpoint: same_origin_path(origin, &wire.session.route_template)?,
    })
}

pub(super) fn validate_metadata_routes(
    origin: &Url,
    descriptor: &HostedAuthDescriptor,
    metadata: &OAuthMetadataWire,
) -> Result<(), TargetAuthorityError> {
    let routes = [
        same_origin_url(origin, &metadata.device_authorization_endpoint)?,
        same_origin_url(origin, &metadata.token_endpoint)?,
        same_origin_url(origin, &metadata.revocation_endpoint)?,
    ];
    let expected = [
        descriptor.device_authorization_endpoint.clone(),
        descriptor.token_endpoint.clone(),
        descriptor.revocation_endpoint.clone(),
    ];
    if routes != expected {
        return Err(authority_error(
            "OAuth metadata does not match hosted target discovery",
        ));
    }
    Ok(())
}

fn valid_device_exchange_fields(fields: &[String]) -> bool {
    fields.len() == 2
        && fields.iter().any(|field| field == "device_token")
        && fields.iter().any(|field| field == "device_label")
}

fn valid_session_discovery(session: &SessionDiscoveryWire) -> bool {
    session.method == "GET" && session.cache_policy == "no-store"
}

pub(super) fn validate_device_code(code: &DeviceCodeWire) -> Result<(), TargetAuthorityError> {
    bounded_value(&code.device_code, MAX_TOKEN_BYTES, "device code")?;
    bounded_value(&code.user_code, 256, "device user code")?;
    if !valid_device_code_metadata(code) || !valid_complete_verification_url(code) {
        return Err(authority_error(
            "device authorization response is malformed",
        ));
    }
    Ok(())
}

fn valid_device_code_metadata(code: &DeviceCodeWire) -> bool {
    code.expires_in > 0
        && code.expires_in <= 86_400
        && code.interval <= 300
        && safe_verification_url(&code.verification_uri, false)
}

fn valid_complete_verification_url(code: &DeviceCodeWire) -> bool {
    code.verification_uri_complete
        .as_deref()
        .is_none_or(|complete| {
            safe_verification_url(complete, true)
                && Url::parse(complete).ok().map(|url| url.origin())
                    == Url::parse(&code.verification_uri)
                        .ok()
                        .map(|url| url.origin())
        })
}

fn safe_verification_url(value: &str, allow_query: bool) -> bool {
    if value.len() > 4096
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    valid_verification_url_shape(&url, allow_query)
}

fn valid_verification_url_shape(url: &Url, allow_query: bool) -> bool {
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "::1"));
    (url.scheme() == "https" || (url.scheme() == "http" && loopback))
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (allow_query || url.query().is_none())
}

pub(super) fn validate_token(token: &TokenWire) -> Result<(), TargetAuthorityError> {
    validate_secret(&token.access_token, "access token")?;
    validate_secret(&token.refresh_token, "refresh token")?;
    if !valid_token_metadata(token) {
        return Err(authority_error("OAuth token response is malformed"));
    }
    Ok(())
}

fn valid_token_metadata(token: &TokenWire) -> bool {
    token.token_type == "Bearer"
        && token.expires_in > 0
        && token.expires_in <= 86_400
        && token.refresh_expires_in > 0
        && token.refresh_expires_in <= 31_536_000
        && !token.scope.is_empty()
        && token.scope.len() <= 512
        && !token.scope.bytes().any(|byte| byte.is_ascii_control())
}

pub(super) fn validate_secret(
    value: &str,
    field: &'static str,
) -> Result<(), TargetAuthorityError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_TOKEN_BYTES
        && !value.bytes().any(|byte| byte.is_ascii_control());
    if valid {
        Ok(())
    } else {
        Err(authority_error(format!("{field} is malformed")))
    }
}

pub(super) fn bounded_value(
    value: &str,
    max_bytes: usize,
    field: &'static str,
) -> Result<String, TargetAuthorityError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(authority_error(format!("{field} is malformed")));
    }
    Ok(value.to_owned())
}

pub(super) fn valid_audience(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub(super) fn authority_error(message: impl Into<String>) -> TargetAuthorityError {
    TargetAuthorityError::new(message)
}
