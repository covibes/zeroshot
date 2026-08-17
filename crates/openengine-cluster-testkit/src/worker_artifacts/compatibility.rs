use super::*;

pub(super) fn compatibility_artifacts(acp: &Value) -> Vec<Artifact> {
    let mut step = acp.clone();
    *step.assert_key_mut("contract").assert_key_mut("input") = json!({ "kind": "number" });
    *step.assert_key_mut("contract").assert_key_mut("output") = json!({ "kind": "integer" });
    let mut verifier = step.clone();
    *verifier.assert_key_mut("worker") = json!("mock.verifier@1");
    *verifier
        .assert_key_mut("contract")
        .assert_key_mut("verifier") = json!({
        "signals": { "verdict": ["accepted"] },
        "diagnostic": { "kind": "integer" }
    });

    compatibility_cases(&step, &verifier)
        .into_iter()
        .map(|(name, expected_code, graph, descriptor)| {
            let requested_worker = graph.assert_key("root").assert_key("worker").clone();
            json_artifact(
                &format!("negative/{name}.json"),
                json!({
                    "fixtureKind": "compatibility",
                    "expectedCode": expected_code,
                    "graph": graph,
                    "registry": [{
                        "requestedWorker": requested_worker,
                        "descriptor": descriptor
                    }]
                }),
            )
        })
        .collect()
}

fn compatibility_cases(
    step: &Value,
    verifier: &Value,
) -> [(&'static str, &'static str, Value, Value); 6] {
    let step_graph = compatibility_graph(false);
    let verifier_graph = compatibility_graph(true);
    [
        (
            "compatibility-input",
            "INPUT",
            step_graph.clone(),
            mutate(step, "/contract/input", json!({ "kind": "string" })),
        ),
        (
            "compatibility-output",
            "OUTPUT",
            step_graph.clone(),
            mutate(step, "/contract/output", json!({ "kind": "string" })),
        ),
        (
            "compatibility-step-verifier",
            "VERIFIER_CONTRACT",
            step_graph,
            mutate(
                step,
                "/contract/verifier",
                json!({
                    "signals": { "verdict": ["accepted"] },
                    "diagnostic": { "kind": "integer" }
                }),
            ),
        ),
        (
            "compatibility-signal-field",
            "SIGNAL_FIELD",
            verifier_graph.clone(),
            mutate(
                verifier,
                "/contract/verifier/signals",
                json!({ "missing": ["accepted"] }),
            ),
        ),
        (
            "compatibility-signal-labels",
            "SIGNAL_LABELS",
            verifier_graph.clone(),
            mutate(
                verifier,
                "/contract/verifier/signals",
                json!({ "verdict": ["undeclared"] }),
            ),
        ),
        (
            "compatibility-diagnostic",
            "DIAGNOSTIC",
            verifier_graph,
            mutate(
                verifier,
                "/contract/verifier/diagnostic",
                json!({ "kind": "string" }),
            ),
        ),
    ]
}

fn compatibility_graph(verifier: bool) -> Value {
    let worker = if verifier {
        "mock.verifier@1"
    } else {
        "mock.acp@1"
    };
    let mut root = json!({
        "kind": if verifier { "verifier" } else { "step" },
        "name": if verifier { "verify" } else { "work" },
        "worker": worker,
        "input": { "kind": "integer" },
        "output": { "kind": "number" },
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": 10,
        "attempts": 1
    });
    if verifier {
        let root = root.as_object_mut().assert_value();
        root.insert(
            "signals".to_owned(),
            json!({ "verdict": ["accepted", "rejected"] }),
        );
        root.insert("diagnostic".to_owned(), json!({ "kind": "number" }));
    }
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": root
    })
}
