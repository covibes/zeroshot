use std::sync::Arc;

use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
    PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
};
use openengine_cluster_server::stdio::serve_stdio;
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, InMemoryAdmissionStore, ScriptedOutcome,
    ScriptedVerifier,
};
use serde_json::json;

#[tokio::main]
async fn main() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let outcomes = (0..128)
        .map(|_| ScriptedOutcome::approve(compiled.clone(), vec![]))
        .collect();
    let backend = AdmissionCoordinator::new(
        ScriptedVerifier::new(outcomes),
        InMemoryAdmissionStore::default(),
    );
    let identity = ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("stdio-fixture"),
        tenant: TenantId::new("stdio-fixture"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    });
    let binding = ConnectionBinding::new(
        Arc::new(backend),
        StaticConnectionIdentityResolver::new(identity),
        SystemConnectionTime,
        Default::default(),
    );
    if let Err(error) = serve_stdio(binding).await {
        eprintln!("cluster protocol stdio server failed: {error}");
        std::process::exit(1);
    }
}
