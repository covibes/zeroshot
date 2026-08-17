use std::fs::File;
use std::io::Read;
use std::path::Path;

use tokio_tungstenite::tungstenite::http::Uri;
use zeroshot_engine::native_v2_cli::{TargetAdd, TargetSetup};
use zeroshot_engine::native_v2_contract::RuntimePlan;

use super::{TargetBase, TargetConnectorError, TargetRecord, TargetSetupDocument};

const MAX_RUNTIME_PLAN_BYTES: u64 = 1024 * 1024;
#[cfg(test)]
const MAX_BEARER_TOKEN_BYTES: usize = 16 * 1024;

pub(super) fn prepare_target(request: TargetAdd) -> Result<TargetRecord, TargetConnectorError> {
    validate_target_name(&request.name)?;
    Ok(TargetRecord {
        name: request.name,
        origin: normalize_origin(&request.url)?,
    })
}

pub(super) fn prepare_setup(
    request: &TargetSetup,
) -> Result<TargetSetupDocument, TargetConnectorError> {
    if !valid_repository(&request.repository) {
        return Err(TargetConnectorError::InvalidRepository);
    }
    let base = normalize_base(request.base.as_deref(), request.target_branch.as_deref())?;
    let runtime = read_runtime_plan(&request.runtime_config)?;
    Ok(TargetSetupDocument {
        repository: request.repository.clone(),
        base,
        runtime,
    })
}

fn read_runtime_plan(path: &Path) -> Result<RuntimePlan, TargetConnectorError> {
    let mut file = File::open(path).map_err(|source| TargetConnectorError::RuntimeRead {
        path: path.to_owned(),
        source,
    })?;
    let metadata = file
        .metadata()
        .map_err(|source| TargetConnectorError::RuntimeRead {
            path: path.to_owned(),
            source,
        })?;
    if !metadata.is_file() {
        return Err(TargetConnectorError::RuntimeRead {
            path: path.to_owned(),
            source: std::io::Error::other("not a regular file"),
        });
    }
    if metadata.len() > MAX_RUNTIME_PLAN_BYTES {
        return Err(TargetConnectorError::RuntimeTooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|source| TargetConnectorError::RuntimeRead {
            path: path.to_owned(),
            source,
        })?;
    serde_json::from_slice(&bytes).map_err(|source| TargetConnectorError::RuntimeJson {
        path: path.to_owned(),
        source,
    })
}

pub(super) fn validate_target_name(name: &str) -> Result<(), TargetConnectorError> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[bytes.len() - 1].is_ascii_alphanumeric()
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

pub(super) fn normalize_base(
    base: Option<&str>,
    target_branch: Option<&str>,
) -> Result<TargetBase, TargetConnectorError> {
    match base {
        None if target_branch.is_none() => Ok(TargetBase::Default),
        None => Err(TargetConnectorError::TargetBranchMismatch),
        Some(revision) if valid_revision(revision) => {
            normalize_revision_base(revision, target_branch)
        }
        Some(branch) => normalize_branch_base(branch, target_branch),
    }
}

fn normalize_revision_base(
    revision: &str,
    target_branch: Option<&str>,
) -> Result<TargetBase, TargetConnectorError> {
    let branch = target_branch.ok_or(TargetConnectorError::TargetBranchMismatch)?;
    if !valid_branch(branch) {
        return Err(TargetConnectorError::TargetBranchMismatch);
    }
    Ok(TargetBase::Revision {
        revision: revision.to_owned(),
        target_branch: branch.to_owned(),
    })
}

fn normalize_branch_base(
    branch: &str,
    target_branch: Option<&str>,
) -> Result<TargetBase, TargetConnectorError> {
    if target_branch.is_some() {
        return Err(TargetConnectorError::TargetBranchMismatch);
    }
    if !valid_branch(branch) {
        return Err(TargetConnectorError::InvalidBase);
    }
    Ok(TargetBase::Branch {
        branch: branch.to_owned(),
    })
}

fn valid_repository(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !name.is_empty()
        && !name.contains('/')
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && !value.contains("..")
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
pub(super) fn validate_bearer_token(token: &str) -> Result<(), TargetConnectorError> {
    if token.is_empty()
        || token.len() > MAX_BEARER_TOKEN_BYTES
        || token.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(TargetConnectorError::InvalidBearerToken);
    }
    Ok(())
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
