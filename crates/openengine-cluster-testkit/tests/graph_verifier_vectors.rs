use openengine_cluster_protocol::GraphSpec;
use openengine_cluster_testkit::artifacts::generate_artifacts;
use openengine_cluster_testkit::graph_verifier_artifacts::{result_value, verify_fixture_graph};

fn assert_required_paths(paths: &std::collections::BTreeSet<&str>) {
    for required in [
        "/positive/binding-channels.json",
        "/positive/guard-in.json",
        "/positive/guard-all.json",
        "/positive/guard-any.json",
        "/positive/guard-not.json",
        "/positive/guard-k-of-n.json",
        "/positive/map-item-k-of-map.json",
        "/positive/map-signal-and-group.json",
        "/positive/loop-and-group.json",
        "/positive/join-all.json",
        "/positive/join-any.json",
        "/positive/join-quorum.json",
        "/positive/join-first.json",
        "/positive/nested-structural-folds.json",
        "/positive/success-routed-write.json",
        "/positive/map-indexed-promotion.json",
        "/positive/parallel-success-routed-promotion.json",
        "/negative/undefined-read.json",
        "/negative/output-write-error-path.json",
        "/negative/cyclic-read.json",
        "/negative/type-mismatch.json",
        "/negative/dead-choice.json",
        "/negative/dead-otherwise.json",
        "/negative/non-exhaustive-choice.json",
        "/negative/unsatisfiable-loop.json",
        "/negative/invalid-quorum.json",
        "/negative/parallel-write-conflict.json",
        "/negative/unsafe-promotion.json",
        "/negative/impossible-map-outcomes.json",
        "/negative/map-indexed-promotion-element-type.json",
        "/negative/map-promotion-target-not-array.json",
        "/negative/map-promotion-no-body-write.json",
        "/negative/parallel-failure-promotion.json",
        "/negative/unconstructible-worker-input.json",
        "/negative/unconstructible-terminal-output.json",
        "/negative/registry-descriptor-contract.json",
        "/negative/registry-descriptor-identity.json",
        "/negative/registry-graph-profile.json",
        "/negative/registry-input.json",
        "/negative/registry-output.json",
        "/negative/registry-verifier-contract.json",
        "/negative/registry-signal-field.json",
        "/negative/registry-signal-labels.json",
        "/negative/registry-diagnostic.json",
    ] {
        assert!(
            paths.iter().any(|path| path.ends_with(required)),
            "missing verifier conformance class {required}"
        );
    }
}

#[tokio::test]
async fn committed_verifier_vectors_match_exact_repeatable_results() {
    let artifacts = generate_artifacts().await;
    let vectors = artifacts
        .iter()
        .filter(|artifact| artifact.relative_path.contains("/fixtures/verifier/"))
        .collect::<Vec<_>>();
    assert!(!vectors.is_empty());

    let paths = vectors
        .iter()
        .map(|vector| vector.relative_path.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_required_paths(&paths);

    for vector in vectors {
        let envelope: serde_json::Value = serde_json::from_slice(&vector.bytes).assert_value();
        let expected_status = if vector.relative_path.contains("/positive/") {
            "verified"
        } else {
            "rejected"
        };
        assert_eq!(
            envelope.assert_key("expected").assert_key("status"),
            expected_status,
            "{} is in the wrong conformance partition",
            vector.relative_path
        );
        assert_required_diagnostic(&vector.relative_path, &envelope);
        let graph: GraphSpec =
            serde_json::from_value(envelope.assert_key("graph").clone()).assert_value();
        let first = result_value(verify_fixture_graph(&graph).await);
        let second = result_value(verify_fixture_graph(&graph).await);
        assert_eq!(
            first, second,
            "{} is nondeterministic",
            vector.relative_path
        );
        assert_eq!(
            &first,
            envelope.assert_key("expected"),
            "{} drifted from committed semantics",
            vector.relative_path
        );
    }
}

fn assert_required_diagnostic(path: &str, envelope: &serde_json::Value) {
    let required = [
        ("/undefined-read.json", "undefined_read"),
        ("/output-write-error-path.json", "undefined_read"),
        ("/cyclic-read.json", "cyclic_reference"),
        ("/type-mismatch.json", "schema_safety"),
        ("/dead-choice.json", "choice_exhaustiveness"),
        ("/dead-otherwise.json", "choice_exhaustiveness"),
        ("/non-exhaustive-choice.json", "choice_exhaustiveness"),
        ("/unsatisfiable-loop.json", "loop_exit_satisfiability"),
        ("/invalid-quorum.json", "invalid_graph_shape"),
        ("/parallel-write-conflict.json", "write_conflict"),
        ("/unsafe-promotion.json", "undefined_read"),
        ("/impossible-map-outcomes.json", "choice_exhaustiveness"),
        ("/map-indexed-promotion-element-type.json", "schema_safety"),
        ("/map-promotion-target-not-array.json", "schema_safety"),
        ("/map-promotion-no-body-write.json", "undefined_read"),
        ("/parallel-failure-promotion.json", "undefined_read"),
        ("/unconstructible-worker-input.json", "schema_safety"),
        ("/unconstructible-terminal-output.json", "schema_safety"),
        ("/registry-descriptor-contract.json", "invalid_graph_shape"),
        ("/registry-descriptor-identity.json", "invalid_graph_shape"),
        ("/registry-graph-profile.json", "invalid_graph_shape"),
        ("/registry-input.json", "schema_safety"),
        ("/registry-output.json", "schema_safety"),
        ("/registry-verifier-contract.json", "invalid_graph_shape"),
        ("/registry-signal-field.json", "schema_safety"),
        ("/registry-signal-labels.json", "schema_safety"),
        ("/registry-diagnostic.json", "schema_safety"),
    ]
    .into_iter()
    .find_map(|(suffix, code)| path.ends_with(suffix).then_some(code));
    let Some(required) = required else {
        return;
    };
    assert!(
        envelope
            .assert_key("expected")
            .assert_key("diagnostics")
            .as_array()
            .assert_value()
            .iter()
            .any(|diagnostic| diagnostic.assert_key("code") == required),
        "{path} does not prove {required}"
    );
}

use openengine_cluster_testkit::assertions::AssertValue;

use openengine_cluster_testkit::assertions::JsonAt;
