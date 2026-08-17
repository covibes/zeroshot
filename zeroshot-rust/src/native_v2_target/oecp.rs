use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::SubscriptionTransport;
use openengine_cluster_client::websocket::{DialedWebSocketTransport, WebSocketTransport};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Uri;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, HeaderValue};

use super::contract::{canonical_host, default_port, uri_text_is_invalid};
use super::{AuthenticatedTargetOecp, TargetConnectorError, TargetRecord};

#[async_trait]
pub trait TargetOecpDialer: Send + Sync {
    type Transport: SubscriptionTransport + Send + Sync + 'static;

    async fn dial(
        &self,
        target: &TargetRecord,
        session: AuthenticatedTargetOecp,
    ) -> Result<Arc<Self::Transport>, TargetConnectorError>;
}

/// Concrete authenticated WebSocket binding. Session discovery and token refresh stay in the
/// control authority; this type performs only one bounded-authority WebSocket handshake.
#[derive(Clone, Copy, Debug, Default)]
pub struct AuthenticatedOecpWebSocketDialer;

#[async_trait]
impl TargetOecpDialer for AuthenticatedOecpWebSocketDialer {
    type Transport = DialedWebSocketTransport;

    async fn dial(
        &self,
        target: &TargetRecord,
        session: AuthenticatedTargetOecp,
    ) -> Result<Arc<Self::Transport>, TargetConnectorError> {
        validate_oecp_endpoint(&target.origin, session.endpoint())?;
        let mut request = session
            .endpoint()
            .into_client_request()
            .map_err(|_| TargetConnectorError::InvalidOecpEndpoint)?;
        let mut value = HeaderValue::from_str(&format!("Bearer {}", session.bearer_token()))
            .map_err(|_| TargetConnectorError::InvalidBearerToken)?;
        value.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, value);
        let (stream, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|error| TargetConnectorError::OecpConnection(error.to_string()))?;
        Ok(Arc::new(WebSocketTransport::new(stream)))
    }
}

fn validate_oecp_endpoint(origin: &str, endpoint: &str) -> Result<(), TargetConnectorError> {
    if uri_text_is_invalid(endpoint) {
        return Err(TargetConnectorError::InvalidOecpEndpoint);
    }
    let origin: Uri = origin
        .parse()
        .map_err(|_| TargetConnectorError::InvalidOecpEndpoint)?;
    let endpoint: Uri = endpoint
        .parse()
        .map_err(|_| TargetConnectorError::InvalidOecpEndpoint)?;
    if !same_oecp_authority(&origin, &endpoint) {
        return Err(TargetConnectorError::InvalidOecpEndpoint);
    }
    Ok(())
}

fn same_oecp_authority(origin: &Uri, endpoint: &Uri) -> bool {
    let Some(origin_authority) = origin.authority() else {
        return false;
    };
    let Some(endpoint_authority) = endpoint.authority() else {
        return false;
    };
    let Some(origin_scheme) = origin.scheme_str() else {
        return false;
    };
    let Some(endpoint_scheme) = endpoint.scheme_str() else {
        return false;
    };
    let expected_scheme = if origin_scheme == "https" {
        "wss"
    } else {
        "ws"
    };
    endpoint_scheme == expected_scheme
        && canonical_host(endpoint_authority.host()) == canonical_host(origin_authority.host())
        && effective_port(endpoint_scheme, endpoint_authority.port_u16())
            == effective_port(origin_scheme, origin_authority.port_u16())
        && !endpoint_authority.as_str().contains('@')
        && endpoint.query().is_none()
}

fn effective_port(scheme: &str, port: Option<u16>) -> Option<u16> {
    port.or_else(|| default_port(scheme))
}
