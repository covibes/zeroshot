#[path = "support/hosted_oecp.rs"]
mod fixtures;

use openengine_cluster_protocol::{
    ApplyParams, GetParams, GraphNode, GraphProfile, IdempotencyKey, InitializeParams, Phase,
    PlanParams, PROTOCOL_VERSION,
};
use openengine_cluster_server::{ClusterBackend, ConnectionContext};

#[tokio::test]
async fn initialize_advertises_only_the_private_single_worker_profile() {
    let result = fixtures::backend()
        .initialize(
            &ConnectionContext::default(),
            InitializeParams {
                protocol_version: PROTOCOL_VERSION.to_owned(),
            },
        )
        .await
        .expect("initialize must succeed");

    assert_eq!(
        result.capabilities.graph_profiles.values(),
        &[GraphProfile::SingleWorker]
    );
    assert!(!result.capabilities.logs);
    assert!(!result.capabilities.agent_attach);
    assert_eq!(result.status.phase, Phase::Empty);
}

#[tokio::test]
async fn plan_accepts_only_the_exact_legacy_step_contract() {
    let backend = fixtures::backend();
    let graph = fixtures::graph();
    let accepted = backend
        .plan(
            &ConnectionContext::default(),
            PlanParams {
                graph: graph.clone(),
            },
        )
        .await
        .expect("plan must return diagnostics");
    assert!(accepted.ok);
    let bounds = accepted.bounds.expect("accepted graph has fixed bounds");
    assert_eq!(bounds.max_node_executions.get(), 1);
    assert_eq!(bounds.peak_concurrency.get(), 1);

    let mut broader = graph.clone();
    broader.profile = GraphProfile::Full;
    assert!(
        !backend
            .plan(&ConnectionContext::default(), PlanParams { graph: broader })
            .await
            .expect("invalid plan returns diagnostics")
            .ok
    );

    let mut retried = graph;
    let GraphNode::Step(step) = &mut retried.root else {
        panic!("fixture root must be a step")
    };
    step.attempts = openengine_cluster_protocol::PositiveInteger::new(2).unwrap();
    assert!(
        !backend
            .plan(&ConnectionContext::default(), PlanParams { graph: retried })
            .await
            .expect("invalid plan returns diagnostics")
            .ok
    );
}

#[tokio::test]
async fn dry_run_is_side_effect_free_and_get_remains_empty() {
    let backend = fixtures::backend();
    let result = backend
        .apply(
            &ConnectionContext::default(),
            ApplyParams {
                graph: fixtures::graph(),
                input: None,
                dry_run: true,
                if_generation: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("valid dry-run apply must succeed");
    assert_eq!(result.phase, Phase::Empty);
    assert!(result.run_id.is_none());

    let current = backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("get must succeed");
    assert!(current.spec.is_none());
    assert_eq!(current.status.phase, Phase::Empty);
}

#[tokio::test]
async fn worker_start_defects_never_echo_input_canaries() {
    let backend = fixtures::backend();
    let canary = "OPENROUTER_SECRET_CANARY";
    let error = backend
        .apply(
            &ConnectionContext::default(),
            ApplyParams {
                graph: fixtures::graph(),
                input: Some(fixtures::request(canary)),
                dry_run: false,
                if_generation: None,
                idempotency_key: Some(IdempotencyKey::new("hosted-apply-1").unwrap()),
            },
        )
        .await
        .expect_err("missing fixed image worker must fail closed");

    assert_eq!(error.code, "WORKER_START");
    assert!(!error.message.contains(canary));
    assert!(!format!("{error:?}").contains(canary));
}
