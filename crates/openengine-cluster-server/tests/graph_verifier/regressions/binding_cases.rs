#[derive(Clone, Copy)]
enum PayloadSite {
    Worker,
    Verifier,
    Terminal,
}

fn unconstructible_payloads() -> [Value; 6] {
    [
        json!({"kind":"boolean"}),
        json!({"kind":"integer"}),
        json!({"kind":"number"}),
        json!({"kind":"string"}),
        json!({"kind":"enum","values":["one"]}),
        json!({"kind":"array","items":{"kind":"integer"}}),
    ]
}

async fn assert_unconstructible_payload(payload: Value, site: PayloadSite) {
    let mut value = valid_graph();
    let node = match site {
        PayloadSite::Worker => value
            .assert_at_mut("root")
            .assert_at_mut("children")
            .assert_at_mut(0),
        PayloadSite::Verifier => value
            .assert_at_mut("root")
            .assert_at_mut("children")
            .assert_at_mut(1),
        PayloadSite::Terminal => value
            .assert_at_mut("root")
            .assert_at_mut("children")
            .assert_at_mut(2)
            .assert_at_mut("branches")
            .assert_at_mut(0)
            .assert_at_mut("node"),
    };
    let (payload_field, bindings_field) = match site {
        PayloadSite::Worker | PayloadSite::Verifier => ("input", "inputBindings"),
        PayloadSite::Terminal => ("output", "bindings"),
    };
    *node.assert_at_mut(payload_field) = payload;
    *node.assert_at_mut(bindings_field) = json!([]);

    let graph: GraphSpec = serde_json::from_value(value).assert_value();
    let registry = registry();
    let resolutions = Arc::clone(&registry.resolutions);
    let error = ProductionGraphVerifier::new(registry)
        .verify(&graph)
        .await
        .assert_error();
    assert_eq!(resolutions.load(Ordering::Relaxed), 0);
    assert!(has_schema_diagnostic_at_field(&error, payload_field));
}

#[tokio::test]
async fn field_bindings_reject_unconstructible_root_payloads_before_registry_resolution() {
    for payload in unconstructible_payloads() {
        for site in [
            PayloadSite::Worker,
            PayloadSite::Verifier,
            PayloadSite::Terminal,
        ] {
            assert_unconstructible_payload(payload.clone(), site).await;
        }
    }
}

fn has_schema_diagnostic_at_field(error: &VerificationError, field: &str) -> bool {
    let VerificationError::Rejected { diagnostics } = error else {
        return false;
    };
    diagnostics.iter().any(|diagnostic| {
        diagnostic.code == GraphDiagnosticCode::SchemaSafety
            && serde_json::to_value(&diagnostic.path).is_ok_and(|path| {
                path.as_array().is_some_and(|segments| {
                    segments
                        .last()
                        .is_some_and(|segment| segment == &json!({"kind":"field","name":field}))
                })
            })
    })
}
use super::*;
