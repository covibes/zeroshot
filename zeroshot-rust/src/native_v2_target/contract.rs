use tokio_tungstenite::tungstenite::http::Uri;
use zeroshot_engine::native_v2_cli::{TargetAdd, TargetSetup};
use openengine_cluster_protocol::SourceRepositoryId;

use super::{TargetAccess, TargetConnectorError, TargetRecord};

const MAX_BEARER_TOKEN_BYTES: usize = 16 * 1024;

pub(super) fn prepare_target(request: TargetAdd) -> Result<TargetRecord, TargetConnectorError> {
    validate_target_name(&request.name)?;
    let access = if request.direct {
        TargetAccess::Direct
    } else {
        TargetAccess::Hosted {
            device_token: fresh_uuid()?,
        }
    };
    Ok(TargetRecord {
        id: fresh_uuid()?,
        name: request.name,
        origin: normalize_origin(&request.url)?,
        access,
        repository: None,
        default_branch: None,
    })
}

fn fresh_uuid() -> Result<String, TargetConnectorError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| TargetConnectorError::Randomness)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{}-{}-{}-{}-{}",
        encode_hex(&bytes[..4]),
        encode_hex(&bytes[4..6]),
        encode_hex(&bytes[6..8]),
        encode_hex(&bytes[8..10]),
        encode_hex(&bytes[10..])
    ))
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct PreparedTargetSetup {
    pub repository: String,
    pub default_branch: Option<String>,
}

pub(super) fn prepare_setup(
    request: &TargetSetup,
) -> Result<PreparedTargetSetup, TargetConnectorError> {
    if SourceRepositoryId::new(&request.repository).is_err() {
        return Err(TargetConnectorError::InvalidRepository);
    }
    Ok(PreparedTargetSetup {
        repository: request.repository.clone(),
        default_branch: request
            .default_branch
            .as_ref()
            .map(|branch| branch.as_str().to_owned()),
    })
}

pub(super) fn validate_target_name(name: &str) -> Result<(), TargetConnectorError> {
    let bytes = name.as_bytes();
    if bytes.len() > 64
        || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    {
        return Err(TargetConnectorError::InvalidName);
    }
    Ok(())
}

pub(super) fn normalize_origin(raw: &str) -> Result<String, TargetConnectorError> {
    if uri_text_is_invalid(raw) {
        return Err(TargetConnectorError::InvalidOrigin);
    }
    let parsed: Uri = raw
        .parse()
        .map_err(|_| TargetConnectorError::InvalidOrigin)?;
    let authority = parsed
        .authority()
        .ok_or(TargetConnectorError::InvalidOrigin)?;
    let host = canonical_host(authority.host());
    let scheme = parsed
        .scheme_str()
        .ok_or(TargetConnectorError::InvalidOrigin)?;
    if !valid_origin_shape(&parsed, authority.as_str(), scheme, &host) {
        return Err(TargetConnectorError::InvalidOrigin);
    }
    let port = authority.port_u16();
    let rendered_host = render_host(&host);
    match port.filter(|port| Some(*port) != default_port(scheme)) {
        Some(port) => Ok(format!("{scheme}://{rendered_host}:{port}")),
        None => Ok(format!("{scheme}://{rendered_host}")),
    }
}

pub(super) fn validate_bearer_token(token: &str) -> Result<(), TargetConnectorError> {
    if token.is_empty()
        || token.len() > MAX_BEARER_TOKEN_BYTES
        || token.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(TargetConnectorError::InvalidBearerToken);
    }
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut value, "{byte:02x}");
    }
    value
}

pub(super) fn uri_text_is_invalid(value: &str) -> bool {
    value.contains('#')
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
}

fn valid_origin_shape(parsed: &Uri, authority: &str, scheme: &str, host: &str) -> bool {
    let loopback = matches!(host, "127.0.0.1" | "::1");
    let allowed_scheme = scheme == "https" || (scheme == "http" && loopback);
    allowed_scheme && !authority.contains('@') && parsed.query().is_none() && parsed.path() == "/"
}

pub(super) fn canonical_host(host: &str) -> String {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

fn render_host(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

pub(super) const fn default_port(scheme: &str) -> Option<u16> {
    match scheme.as_bytes() {
        b"https" | b"wss" => Some(443),
        b"http" | b"ws" => Some(80),
        _ => None,
    }
}
