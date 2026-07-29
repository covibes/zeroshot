//! Binding-injected connection identity and acceptance-time resolution.

use std::collections::BTreeMap;
use std::io;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use thiserror::Error;

use crate::admission::CancellationSignal;
use crate::{ClusterBackend, ConnectionContext, Dispatcher};

/// Opaque authenticated principal identifier supplied by a transport binding.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PrincipalId(Box<str>);

impl PrincipalId {
    #[must_use]
    pub fn new(value: impl Into<Box<str>>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Opaque tenant identifier supplied by a transport binding.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TenantId(Box<str>);

impl TenantId {
    #[must_use]
    pub fn new(value: impl Into<Box<str>>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Binding-specific attributes that are carried to a backend without interpretation by the
/// dispatcher or protocol layer.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BindingAttributes(BTreeMap<String, String>);

impl BindingAttributes {
    #[must_use]
    pub fn new(values: BTreeMap<String, String>) -> Self {
        Self(values)
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }
}

/// Construction payload for an immutable [`ConnectionIdentity`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionIdentityConfig {
    pub principal: PrincipalId,
    pub tenant: TenantId,
    pub issued_at_ms: Option<u64>,
    pub expires_at_ms: u64,
    pub binding_attributes: BindingAttributes,
}

/// Authenticated identity fixed for the lifetime of one accepted connection.
///
/// This type deliberately has no serde implementation: it is injected by a binding and cannot be
/// carried by a protocol request, response, or event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionIdentity {
    principal: PrincipalId,
    tenant: TenantId,
    issued_at_ms: Option<u64>,
    expires_at_ms: u64,
    binding_attributes: BindingAttributes,
}

impl ConnectionIdentity {
    #[must_use]
    pub fn new(config: ConnectionIdentityConfig) -> Self {
        Self {
            principal: config.principal,
            tenant: config.tenant,
            issued_at_ms: config.issued_at_ms,
            expires_at_ms: config.expires_at_ms,
            binding_attributes: config.binding_attributes,
        }
    }

    #[must_use]
    pub fn principal(&self) -> &PrincipalId {
        &self.principal
    }

    #[must_use]
    pub fn tenant(&self) -> &TenantId {
        &self.tenant
    }

    #[must_use]
    pub fn issued_at_ms(&self) -> Option<u64> {
        self.issued_at_ms
    }

    #[must_use]
    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    #[must_use]
    pub fn binding_attributes(&self) -> &BindingAttributes {
        &self.binding_attributes
    }

    #[must_use]
    pub fn is_expired_at(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }

    pub(crate) fn local_default() -> Self {
        Self::new(ConnectionIdentityConfig {
            principal: PrincipalId::new("local"),
            tenant: TenantId::new("local"),
            issued_at_ms: None,
            expires_at_ms: u64::MAX,
            binding_attributes: BindingAttributes::default(),
        })
    }
}

/// Failure to resolve a connection identity before the binding reads its first frame.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct IdentityResolutionError {
    message: String,
}

impl IdentityResolutionError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Acceptance-time hook owned by a transport binding.
#[async_trait]
pub trait ConnectionIdentityResolver: Send + Sync + 'static {
    async fn resolve(&self) -> Result<ConnectionIdentity, IdentityResolutionError>;
}

/// Resolver for hosts that already resolved identity synchronously while accepting the transport.
#[derive(Clone, Debug)]
pub struct StaticConnectionIdentityResolver {
    identity: ConnectionIdentity,
}

impl StaticConnectionIdentityResolver {
    #[must_use]
    pub fn new(identity: ConnectionIdentity) -> Self {
        Self { identity }
    }
}

#[async_trait]
impl ConnectionIdentityResolver for StaticConnectionIdentityResolver {
    async fn resolve(&self) -> Result<ConnectionIdentity, IdentityResolutionError> {
        Ok(self.identity.clone())
    }
}

/// Millisecond clock observed at each inbound request decode boundary.
pub trait ConnectionTimeSource: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

/// Wall-clock time source used by production bindings.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemConnectionTime;

impl ConnectionTimeSource for SystemConnectionTime {
    fn now_ms(&self) -> u64 {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
    }
}

/// Backend and host-owned connection services consumed once by an accepted binding.
pub struct ConnectionBinding<B, R, T> {
    backend: Arc<B>,
    identity_resolver: R,
    time_source: T,
    cancellation: CancellationSignal,
}

impl<B, R, T> ConnectionBinding<B, R, T> {
    #[must_use]
    pub fn new(
        backend: Arc<B>,
        identity_resolver: R,
        time_source: T,
        cancellation: CancellationSignal,
    ) -> Self {
        Self {
            backend,
            identity_resolver,
            time_source,
            cancellation,
        }
    }
}

pub(crate) struct ResolvedConnection<B, T> {
    pub(crate) dispatcher: Dispatcher<B>,
    pub(crate) time_source: T,
}

impl<B, R, T> ConnectionBinding<B, R, T>
where
    B: ClusterBackend,
    R: ConnectionIdentityResolver,
    T: ConnectionTimeSource,
{
    /// Resolves the binding-owned identity before exposing a dispatcher to a specialized host.
    ///
    /// General-purpose transports should use their `serve_*` entry point so per-request identity
    /// expiry is enforced by the binding. This escape hatch is for bounded host handshakes whose
    /// injected identity cannot expire during the transaction.
    pub async fn into_dispatcher(self) -> io::Result<Dispatcher<B>> {
        Ok(self.resolve().await?.dispatcher)
    }

    pub(crate) async fn resolve(self) -> io::Result<ResolvedConnection<B, T>> {
        let identity = self
            .identity_resolver
            .resolve()
            .await
            .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
        let context = ConnectionContext::new(identity, self.cancellation);
        Ok(ResolvedConnection {
            dispatcher: Dispatcher::from_shared(self.backend, context),
            time_source: self.time_source,
        })
    }
}
