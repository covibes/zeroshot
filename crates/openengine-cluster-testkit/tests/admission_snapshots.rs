use openengine_cluster_protocol::{Cursor, Generation, GetParams, Phase, RunId, INTERNAL_ERROR_CODE};
use openengine_cluster_server::admission::{AdmissionSnapshot, ControlSnapshot, VerifiedSeed};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, ScriptedOutcome,
};
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
use admission_support::{client, committed, rpc_code};

fn valid_running_snapshot() -> AdmissionSnapshot {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let run_id = RunId::new("run-fixture");
    let cursor = Cursor::new("cursor-fixture");
    AdmissionSnapshot {
        control: ControlSnapshot {
            spec: Some(graph.clone()),
            compiled_ir: Some(compiled_from_graph_fixture(&graph)),
            generation: Some(Generation::new(1).assert_value()),
            run_id: Some(run_id.clone()),
            phase: Phase::Running,
            cursor: Some(cursor.clone()),
        },
        seed: Some(VerifiedSeed {
            run_id,
            input: json!(null),
            cursor,
        }),
    }
}

#[tokio::test]
async fn admission_get_rejects_a_running_snapshot_without_a_verified_seed() {
    let graph = graph_fixture("worker", json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let (client, _, store) = client(vec![ScriptedOutcome::approve(compiled, vec![])]);
    client
        .apply(committed(graph, json!(null), 0, "create"))
        .await
        .assert_value();
    store.remove_active_seed_for_test().await;

    let error = client.get(GetParams::default()).await.assert_error();
    assert_eq!(rpc_code(error), INTERNAL_ERROR_CODE);
}

#[tokio::test]
async fn admission_initialize_and_get_reject_every_malformed_phase_snapshot() {
    type Corrupt = fn(&mut AdmissionSnapshot);
    let running_corruptions: [(&str, Corrupt); 10] = [
        ("missing spec", |snapshot| snapshot.control.spec = None),
        ("missing compiled IR", |snapshot| {
            snapshot.control.compiled_ir = None;
        }),
        ("missing generation", |snapshot| {
            snapshot.control.generation = None;
        }),
        ("zero committed generation", |snapshot| {
            snapshot.control.generation = Some(Generation::new(0).assert_value());
        }),
        ("missing run", |snapshot| snapshot.control.run_id = None),
        ("missing cursor", |snapshot| snapshot.control.cursor = None),
        ("missing seed", |snapshot| snapshot.seed = None),
        ("seed run mismatch", |snapshot| {
            snapshot.seed.as_mut().assert_value().run_id = RunId::new("other-run");
        }),
        ("seed cursor mismatch", |snapshot| {
            snapshot.seed.as_mut().assert_value().cursor = Cursor::new("other-cursor");
        }),
        ("seed input mismatch", |snapshot| {
            snapshot.seed.as_mut().assert_value().input = json!(true);
        }),
    ];
    let committed = valid_running_snapshot();
    let mut malformed = Vec::new();
    for (name, corrupt) in running_corruptions {
        let mut snapshot = committed.clone();
        corrupt(&mut snapshot);
        malformed.push((format!("running {name}"), snapshot));
    }

    for field in ["spec", "compiled IR", "generation", "run", "cursor"] {
        let mut snapshot = AdmissionSnapshot::default();
        match field {
            "spec" => snapshot.control.spec = committed.control.spec.clone(),
            "compiled IR" => {
                snapshot.control.compiled_ir = committed.control.compiled_ir.clone();
            }
            "generation" => snapshot.control.generation = committed.control.generation,
            "run" => snapshot.control.run_id = committed.control.run_id.clone(),
            "cursor" => snapshot.control.cursor = committed.control.cursor.clone(),
            other => assert!(
                matches!(other, "graph" | "ir" | "generation" | "run" | "cursor"),
                "unknown committed field {other}"
            ),
        }
        malformed.push((format!("empty with {field}"), snapshot));
    }

    let mut partial_admitting = AdmissionSnapshot::default();
    partial_admitting.control.phase = Phase::Admitting;
    partial_admitting.control.spec = committed.control.spec.clone();
    malformed.push(("partial admitting".into(), partial_admitting));

    for (name, snapshot) in malformed {
        let (client, _, store) = client(vec![]);
        store.replace_snapshot_for_test(snapshot).await;
        assert_eq!(
            rpc_code(client.initialize().await.assert_error()),
            INTERNAL_ERROR_CODE,
            "initialize accepted {name}"
        );
        assert_eq!(
            rpc_code(client.get(GetParams::default()).await.assert_error()),
            INTERNAL_ERROR_CODE,
            "get accepted {name}"
        );
    }
}

#[tokio::test]
async fn admission_admitting_snapshot_preserves_complete_empty_or_committed_state() {
    let mut empty = AdmissionSnapshot::default();
    empty.control.phase = Phase::Admitting;
    let mut committed = valid_running_snapshot();
    committed.control.phase = Phase::Admitting;

    for snapshot in [empty, committed] {
        let (client, _, store) = client(vec![]);
        store.replace_snapshot_for_test(snapshot).await;
        assert_eq!(
            client.initialize().await.assert_value().status.phase,
            Phase::Admitting
        );
        assert_eq!(
            client
                .get(GetParams::default())
                .await
                .assert_value()
                .status
                .phase,
            Phase::Admitting
        );
    }
}

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
