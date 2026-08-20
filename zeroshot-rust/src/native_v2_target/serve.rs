use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use thiserror::Error;
use tokio::net::TcpListener;
use url::Url;
use zeroshot_engine::native_v2_cli::NativeV2CliError;
use zeroshot_engine::native_v2_hosting::{
    ProductionHostingConfig, ProductionHostingError, build_production_target_authority,
};
use zeroshot_engine::native_v2_target_authority::{
    NativeV2TargetServer, OECP_PATH, TargetAuthorityError,
};

use super::contract::normalize_origin;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectTargetServeConfig {
    pub listen: SocketAddr,
    pub public_origin: String,
    pub storage: PathBuf,
}

#[derive(Debug, Error)]
pub enum TargetServeError {
    #[error(transparent)]
    Hosting(#[from] ProductionHostingError),
    #[error(transparent)]
    Authority(#[from] TargetAuthorityError),
    #[error("direct target server I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub fn parse_target_serve(
    arguments: &[OsString],
) -> Result<Option<DirectTargetServeConfig>, NativeV2CliError> {
    if !is_target_serve(arguments) {
        return Ok(None);
    }
    let values = utf8_options(arguments.get(2..).unwrap_or_default())?;
    let options = exact_options(&values)?;
    let listen = required(&options, "--listen")?
        .parse()
        .map_err(|_| usage("--listen must be an IP socket address"))?;
    let public_origin = normalize_origin(required(&options, "--public-origin")?)
        .map_err(|error| usage(error.to_string()))?;
    let storage = PathBuf::from(required(&options, "--storage")?);
    Ok(Some(DirectTargetServeConfig {
        listen,
        public_origin,
        storage,
    }))
}

fn is_target_serve(arguments: &[OsString]) -> bool {
    matches!(
        (
            arguments.first().and_then(|value| value.to_str()),
            arguments.get(1).and_then(|value| value.to_str()),
        ),
        (Some("target"), Some("serve"))
    )
}

fn utf8_options(arguments: &[OsString]) -> Result<Vec<String>, NativeV2CliError> {
    arguments
        .iter()
        .map(|value| {
            value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| usage("target serve arguments must be valid UTF-8"))
        })
        .collect()
}

pub async fn serve_direct_target(config: DirectTargetServeConfig) -> Result<(), TargetServeError> {
    let listener = TcpListener::bind(config.listen).await?;
    let endpoint = oecp_endpoint(&config.public_origin)?;
    let hosting = ProductionHostingConfig {
        storage_root: config.storage,
        ..ProductionHostingConfig::default()
    };
    let target = Arc::new(build_production_target_authority(hosting).await?);
    let server = Arc::new(NativeV2TargetServer::new_direct(
        target,
        direct_identity(),
        endpoint,
    )?);
    eprintln!(
        "zeroshot native-v2 direct target listening on {} as {}",
        config.listen, config.public_origin
    );
    server.serve(listener).await?;
    Ok(())
}

fn exact_options(values: &[String]) -> Result<BTreeMap<String, String>, NativeV2CliError> {
    if values.len() % 2 != 0 {
        return Err(usage("target serve options require values"));
    }
    let mut options = BTreeMap::new();
    for pair in values.chunks_exact(2) {
        let name = pair.first().ok_or_else(|| usage("missing option name"))?;
        let value = pair.get(1).ok_or_else(|| usage("missing option value"))?;
        if !matches!(name.as_str(), "--listen" | "--public-origin" | "--storage") {
            return Err(usage(format!("unknown target serve option {name:?}")));
        }
        if value.is_empty() || options.insert(name.clone(), value.clone()).is_some() {
            return Err(usage(format!("{name} requires one non-empty value")));
        }
    }
    Ok(options)
}

fn required<'a>(
    options: &'a BTreeMap<String, String>,
    name: &str,
) -> Result<&'a str, NativeV2CliError> {
    options
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| usage(format!("{name} is required")))
}

fn usage(message: impl Into<String>) -> NativeV2CliError {
    NativeV2CliError::Usage(message.into())
}

fn oecp_endpoint(origin: &str) -> Result<String, TargetAuthorityError> {
    let mut endpoint = Url::parse(origin)
        .map_err(|_| TargetAuthorityError::invalid("public target origin is invalid"))?;
    let scheme = match endpoint.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => {
            return Err(TargetAuthorityError::invalid(
                "public target origin is invalid",
            ));
        }
    };
    endpoint
        .set_scheme(scheme)
        .map_err(|()| TargetAuthorityError::invalid("public target origin is invalid"))?;
    endpoint.set_path(OECP_PATH);
    Ok(endpoint.into())
}

fn direct_identity() -> ConnectionIdentity {
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("direct-target"),
        tenant: TenantId::new("direct-target"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn target_serve_requires_the_exact_direct_server_contract() {
        let parsed = parse_target_serve(&arguments(&[
            "target",
            "serve",
            "--listen",
            "0.0.0.0:8080",
            "--public-origin",
            "http://127.0.0.1:8080",
            "--storage",
            "/var/lib/zeroshot/native-v2",
        ]))
        .assert_value()
        .assert_value();
        assert_eq!(parsed.listen, "0.0.0.0:8080".parse().assert_value());
        assert_eq!(parsed.public_origin, "http://127.0.0.1:8080");
        assert_eq!(parsed.storage, PathBuf::from("/var/lib/zeroshot/native-v2"));
    }

    #[test]
    fn target_serve_rejects_insecure_remote_http_and_unknown_options() {
        parse_target_serve(&arguments(&[
            "target",
            "serve",
            "--listen",
            "0.0.0.0:8080",
            "--public-origin",
            "http://10.0.0.7:8080",
            "--storage",
            "/tmp/target",
        ]))
        .assert_error();
        parse_target_serve(&arguments(&[
            "target",
            "serve",
            "--listen",
            "127.0.0.1:8080",
            "--public-origin",
            "https://target.example",
            "--storage",
            "/tmp/target",
            "--queue",
            "anything",
        ]))
        .assert_error();
    }

    #[test]
    fn target_serve_derives_only_same_authority_websocket_endpoints() {
        assert_eq!(
            oecp_endpoint("http://127.0.0.1:8080").assert_value(),
            "ws://127.0.0.1:8080/native-v2/oecp"
        );
        assert_eq!(
            oecp_endpoint("https://target.example").assert_value(),
            "wss://target.example/native-v2/oecp"
        );
    }
}
