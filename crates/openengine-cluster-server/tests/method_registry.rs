use std::fs;
use std::path::PathBuf;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, RequestId,
    ServerCapabilities,
};
use openengine_cluster_server::method_registry::{
    methods_requiring, MethodKind, SubscriptionKind, TransportRequirements, METHOD_REGISTRY,
};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::Value;

struct EmptyBackend;

#[async_trait]
impl ClusterBackend for EmptyBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: None,
        })
    }
}

#[test]
fn registry_is_the_exact_protocol_method_surface() {
    let names = METHOD_REGISTRY
        .iter()
        .map(|descriptor| descriptor.name)
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "initialize",
            "plan",
            "apply",
            "update",
            "stop",
            "retry",
            "resubmit",
            "delete",
            "get",
            "watch",
            "logs",
            "agent/attach",
        ]
    );

    let subscriptions = METHOD_REGISTRY
        .iter()
        .filter_map(|descriptor| match descriptor.kind {
            MethodKind::Unary => None,
            MethodKind::Subscription(kind) => Some((descriptor.name, kind)),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        subscriptions,
        [
            ("watch", SubscriptionKind::Watch),
            ("logs", SubscriptionKind::Logs),
            ("agent/attach", SubscriptionKind::AgentAttach),
        ]
    );

    for descriptor in METHOD_REGISTRY {
        let is_subscription = matches!(descriptor.kind, MethodKind::Subscription(_));
        assert_eq!(
            descriptor.transport_requirements,
            TransportRequirements {
                server_push: is_subscription,
                inbound_notifications: is_subscription,
            },
            "wrong transport requirements for {}",
            descriptor.name
        );
    }

    let request_response = methods_requiring(TransportRequirements::default())
        .map(|descriptor| descriptor.name)
        .collect::<Vec<_>>();
    assert_eq!(request_response, &names[..9]);
    let subscription_transport = methods_requiring(TransportRequirements {
        server_push: true,
        inbound_notifications: true,
    })
    .map(|descriptor| descriptor.name)
    .collect::<Vec<_>>();
    assert_eq!(subscription_transport, &names[9..]);
}

#[test]
fn bindings_do_not_classify_subscriptions_with_method_name_literals() {
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    for relative in ["stdio.rs", "connection/frame.rs"] {
        let source = fs::read_to_string(source_root.join(relative)).unwrap();
        for method in ["watch", "logs", "agent/attach"] {
            assert!(
                !source.contains(&format!("\"{method}\"")),
                "{relative} hardcodes subscription method {method}"
            );
        }
    }
}

#[tokio::test]
async fn subscription_methods_remain_unavailable_to_unary_dispatch() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());

    for (index, method) in ["watch", "logs", "agent/attach"].into_iter().enumerate() {
        let id = RequestId::String(format!("subscription-{index}"));
        let response = dispatcher
            .dispatch_decoded(id.clone(), method, Value::Array(Vec::new()))
            .await;
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], serde_json::to_value(id).unwrap());
        assert_eq!(response["error"]["code"], -32601);
        assert_eq!(response["error"]["message"], "Method not found");
    }
}
