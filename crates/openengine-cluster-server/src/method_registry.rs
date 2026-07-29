//! Authoritative protocol method inventory shared by dispatch, connection bindings, and artifacts.

/// The routing shape of a protocol method.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MethodKind {
    Unary,
    Subscription(SubscriptionKind),
}

/// Subscription establishment routes owned by the transport-neutral connection core.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubscriptionKind {
    Watch,
    Logs,
    AgentAttach,
}

/// Transport capabilities a method requires in addition to request/response exchange.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TransportRequirements {
    pub server_push: bool,
    pub inbound_notifications: bool,
}

/// One public method and the transport behavior needed to serve it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MethodDescriptor {
    pub name: &'static str,
    pub kind: MethodKind,
    pub transport_requirements: TransportRequirements,
}

const REQUEST_RESPONSE: TransportRequirements = TransportRequirements {
    server_push: false,
    inbound_notifications: false,
};
const SUBSCRIPTION_TRANSPORT: TransportRequirements = TransportRequirements {
    server_push: true,
    inbound_notifications: true,
};

/// The complete Open Engine Cluster Protocol server method surface, in advertised order.
pub static METHOD_REGISTRY: &[MethodDescriptor] = &[
    unary("initialize"),
    unary("plan"),
    unary("apply"),
    unary("update"),
    unary("stop"),
    unary("retry"),
    unary("resubmit"),
    unary("delete"),
    unary("get"),
    subscription("watch", SubscriptionKind::Watch),
    subscription("logs", SubscriptionKind::Logs),
    subscription("agent/attach", SubscriptionKind::AgentAttach),
];

const fn unary(name: &'static str) -> MethodDescriptor {
    MethodDescriptor {
        name,
        kind: MethodKind::Unary,
        transport_requirements: REQUEST_RESPONSE,
    }
}

const fn subscription(name: &'static str, kind: SubscriptionKind) -> MethodDescriptor {
    MethodDescriptor {
        name,
        kind: MethodKind::Subscription(kind),
        transport_requirements: SUBSCRIPTION_TRANSPORT,
    }
}

/// Resolves a wire method name through the authoritative registry.
#[must_use]
pub fn method_descriptor(name: &str) -> Option<&'static MethodDescriptor> {
    METHOD_REGISTRY
        .iter()
        .find(|descriptor| descriptor.name == name)
}

/// Enumerates methods with exactly the supplied transport requirements.
pub fn methods_requiring(
    requirements: TransportRequirements,
) -> impl Iterator<Item = &'static MethodDescriptor> {
    METHOD_REGISTRY
        .iter()
        .filter(move |descriptor| descriptor.transport_requirements == requirements)
}
