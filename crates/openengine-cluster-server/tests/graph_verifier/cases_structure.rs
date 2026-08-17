#[derive(Clone, Copy)]
enum EmptyRecordSite {
    WorkerInput,
    TerminalOutput,
}

#[tokio::test]
async fn required_empty_record_inputs_and_outputs_must_be_bound() {
    for site in [
        EmptyRecordSite::WorkerInput,
        EmptyRecordSite::TerminalOutput,
    ] {
        let mut value = valid_graph();
        let node = match site {
            EmptyRecordSite::WorkerInput => value
                .assert_at_mut("root")
                .assert_at_mut("children")
                .assert_at_mut(0),
            EmptyRecordSite::TerminalOutput => value
                .assert_at_mut("root")
                .assert_at_mut("children")
                .assert_at_mut(2)
                .assert_at_mut("branches")
                .assert_at_mut(0)
                .assert_at_mut("node"),
        };
        let (payload_field, bindings_field) = match site {
            EmptyRecordSite::WorkerInput => ("input", "inputBindings"),
            EmptyRecordSite::TerminalOutput => ("output", "bindings"),
        };
        *node.assert_at_mut(payload_field) = required_empty_record_payload();
        *node.assert_at_mut(bindings_field) = json!([]);
        let graph: GraphSpec = serde_json::from_value(value).assert_value();
        assert_graph_rejected_with(&graph, GraphDiagnosticCode::UndefinedRead).await;
    }
}

#[tokio::test]
async fn negative_semantic_matrix_rejects_undefined_reads_and_types() {
    let mut undefined = valid_graph();
    *undefined
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("inputBindings")
        .assert_at_mut(0)
        .assert_at_mut("value")
        .assert_at_mut("path") = json!(["result"]);
    let undefined: GraphSpec = serde_json::from_value(undefined).assert_value();
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&undefined)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::UndefinedRead)
    );

    let mut mismatch = valid_graph();
    *mismatch
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(0)
        .assert_at_mut("input")
        .assert_at_mut("fields")
        .assert_at_mut("value")
        .assert_at_mut("type") = json!({"kind":"string"});
    let mismatch: GraphSpec = serde_json::from_value(mismatch).assert_value();
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&mismatch)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::SchemaSafety)
    );
}

#[tokio::test]
async fn negative_semantic_matrix_rejects_choices_and_quorum() {
    let mut non_exhaustive = valid_graph();
    *non_exhaustive
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2)
        .assert_at_mut("otherwise") = Value::Null;
    let non_exhaustive: GraphSpec = serde_json::from_value(non_exhaustive).assert_value();
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&non_exhaustive)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::ChoiceExhaustiveness)
    );

    let mut dead = valid_graph();
    let first = dead
        .assert_at("root")
        .assert_at("children")
        .assert_at(2)
        .assert_at("branches")
        .assert_at(0)
        .clone();
    let mut second = first.clone();
    *second.assert_at_mut("node").assert_at_mut("name") = json!("deadBranch");
    *dead
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2)
        .assert_at_mut("branches") = json!([first, second]);
    let dead: GraphSpec = serde_json::from_value(dead).assert_value();
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&dead)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::ChoiceExhaustiveness)
    );

    let mut invalid_quorum = valid_graph();
    let branch = invalid_quorum
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    let mut other = branch.clone();
    *other.assert_at_mut("name") = json!("otherWork");
    *invalid_quorum
        .assert_at_mut("root")
        .assert_at_mut("children")
        .assert_at_mut(2) = json!({
        "kind":"seq","name":"tail","state":record(),
        "children":[
            {"kind":"par","name":"parallel","state":record(),"branches":[branch,other],
             "promotedStatePaths":[],"join":{"kind":"quorum","count":3}},
            {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        ],
        "promotedStatePaths":[]
    });
    let invalid_quorum: GraphSpec = serde_json::from_value(invalid_quorum).assert_value();
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&invalid_quorum)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::InvalidGraphShape)
    );
}

#[tokio::test]
async fn unsatisfiable_loop_exit_fails_closed() {
    let verifier = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(1)
        .clone();
    let contradictory = json!({
        "kind":"all","guards":[
            {"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
            {"kind":"not","guard":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]}}
        ]
    });
    let loop_graph = graph_with_root_child(json!({
        "kind":"seq","name":"loopTail","state":record(),"children":[
            {"kind":"loop","name":"loop","state":record(),"body":verifier,
             "until":contradictory,"maxIterations":2,"promotedStatePaths":[]},
            {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        ],"promotedStatePaths":[]
    }));
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&loop_graph)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::LoopExitSatisfiability)
    );
}

#[tokio::test]
async fn conflicting_parallel_writes_fail_closed() {
    let left = work_node("left", "left");
    let right = work_node("right", "right");
    let conflict = graph_with_root_child(json!({
        "kind":"seq","name":"parallelTail","state":record(),"children":[
            {"kind":"par","name":"parallel","state":record(),"branches":[left,right],
             "promotedStatePaths":[],"join":{"kind":"all"}},
            {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        ],"promotedStatePaths":[]
    }));
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&conflict)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::WriteConflict)
    );
}

#[tokio::test]
async fn unsafe_choice_promotion_fails_closed() {
    let work = valid_graph()
        .assert_at("root")
        .assert_at("children")
        .assert_at(0)
        .clone();
    let unsafe_promotion = graph_with_root_child(json!({
        "kind":"seq","name":"choiceTail","state":record(),"children":[
            {"kind":"verifier","name":"verify","worker":"worker.verify@1",
             "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
             "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
             "signals":{"verdict":["accepted","rejected"]},"diagnostic":{"kind":"record","fields":{}}},
            {"kind":"choice","name":"promote","state":record(),"branches":[{
                "when":{"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
                "node":work
             }],"otherwise":{"kind":"fail","name":"failed","reason":"failed"},
             "promotedStatePaths":[["result"]]},
            {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        ],"promotedStatePaths":[]
    }));
    assert!(
        rejection_codes(
            ProductionGraphVerifier::new(registry())
                .verify(&unsafe_promotion)
                .await
                .assert_error()
        )
        .contains(&GraphDiagnosticCode::UndefinedRead)
    );
}

#[tokio::test]
async fn cyclic_node_output_references_are_rejected() {
    let left = work_node("left", "right");
    let right = work_node("right", "left");
    let graph = graph_with_root_child(json!({
        "kind":"seq","name":"root","state":record(),
        "children":[left,right,{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}],
        "promotedStatePaths":[]
    }));
    let codes = rejection_codes(
        ProductionGraphVerifier::new(registry())
            .verify(&graph)
            .await
            .assert_error(),
    );
    assert!(codes.contains(&GraphDiagnosticCode::CyclicReference));
    assert!(codes.contains(&GraphDiagnosticCode::UndefinedRead));
}

use super::*;
