use std::sync::Arc;

use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use thiserror::Error;
use tokio::net::TcpListener;
use url::Url;
use zeroshot_engine::native_v2_cli::TargetServe;
use zeroshot_engine::native_v2_hosting::{
    ProductionHostingConfig, ProductionHostingError, build_production_target_authority,
};
use zeroshot_engine::native_v2_target_authority::{
    NativeV2TargetServer, OECP_PATH, TargetAuthorityError, TargetBootstrapKey,
};

use super::contract::normalize_origin;

#[derive(Debug, Error)]
pub enum TargetServeError {
    #[error(transparent)]
    Hosting(#[from] ProductionHostingError),
    #[error(transparent)]
    Authority(#[from] TargetAuthorityError),
    #[error("direct target server I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid direct target public origin: {0}")]
    InvalidOrigin(String),
}

pub async fn serve_direct_target(config: TargetServe) -> Result<(), TargetServeError> {
    let public_origin = normalize_origin(&config.public_origin)
        .map_err(|error| TargetServeError::InvalidOrigin(error.to_string()))?;
    let (server, listener) = prepare_server(&config, &public_origin).await?;
    eprintln!(
        "Zeroshot Rust direct target listening on {} as {}",
        config.listen, public_origin
    );
    server.serve(listener).await?;
    Ok(())
}

async fn prepare_server(
    config: &TargetServe,
    public_origin: &str,
) -> Result<(Arc<NativeV2TargetServer>, TcpListener), TargetServeError> {
    let bootstrap_key = config
        .bootstrap_key_file
        .as_deref()
        .map(TargetBootstrapKey::load_and_unlink)
        .transpose()?;
    let listener = TcpListener::bind(config.listen).await?;
    let endpoint = oecp_endpoint(public_origin)?;
    let hosting = ProductionHostingConfig {
        storage_root: config.storage.clone(),
        ..ProductionHostingConfig::default()
    };
    let target = Arc::new(build_production_target_authority(hosting).await?);
    let server = Arc::new(match bootstrap_key {
        Some(key) => NativeV2TargetServer::new_private(target, direct_identity(), endpoint, key)?,
        None => NativeV2TargetServer::new_direct(target, direct_identity(), endpoint)?,
    });
    Ok((server, listener))
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
    use openengine_cluster_testkit::assertions::AssertValue;

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
