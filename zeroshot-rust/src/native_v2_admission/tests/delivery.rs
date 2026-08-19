use super::*;

#[tokio::test]
async fn rejects_invalid_graph_visible_delivery_bindings_and_contracts() {
    let step_graph = graph(vec![
        null_step("deliver", GIT_DELIVERY_PR_WORKER_REF),
        succeed("done"),
    ]);
    let request = submission(
        step_graph,
        BTreeMap::from([(named("deliver"), delivery_binding())]),
    );
    assert!(matches!(
        NativeV2Admission.admit(request).await,
        Err(NativeV2AdmissionError::DeliveryMustBeVerifier { .. })
    ));

    let unsupported_graph = graph(vec![
        null_verifier("deliver", "builtin.git-delivery@1"),
        succeed("done"),
    ]);
    assert!(matches!(
        NativeV2Admission
            .admit(submission(
                unsupported_graph,
                BTreeMap::from([(named("deliver"), delivery_binding())]),
            ))
            .await,
        Err(NativeV2AdmissionError::UnsupportedDeliveryWorker { .. })
    ));

    let wrong_binding_graph = graph(vec![
        delivery_verifier("deliver", DeliveryMode::PullRequest),
        succeed("done"),
    ]);
    assert!(matches!(
        NativeV2Admission
            .admit(submission(
                wrong_binding_graph,
                BTreeMap::from([(named("deliver"), binding("claude-sonnet-5", None))]),
            ))
            .await,
        Err(NativeV2AdmissionError::DeliveryWorkerRequiresBinding { .. })
    ));

    let invalid_contract = graph(vec![
        null_verifier("deliver", GIT_DELIVERY_PR_WORKER_REF),
        succeed("done"),
    ]);
    assert!(matches!(
        NativeV2Admission
            .admit(submission(
                invalid_contract,
                BTreeMap::from([(named("deliver"), delivery_binding())]),
            ))
            .await,
        Err(NativeV2AdmissionError::InvalidDeliveryContract { .. })
    ));
}

#[tokio::test]
async fn enforces_graph_visible_delivery_policy_counts() {
    let no_delivery = submission(graph(vec![succeed("done")]), BTreeMap::new());
    assert_eq!(
        NativeV2Admission
            .admit_with_policy(no_delivery, DeliveryPolicy::Required)
            .await,
        Err(NativeV2AdmissionError::DeliveryNodeCount {
            policy: DeliveryPolicy::Required,
            found: 0,
        })
    );

    let delivery_graph = graph(vec![
        delivery_verifier("deliver", DeliveryMode::Merge),
        succeed("done"),
    ]);
    NativeV2Admission
        .admit_with_policy(
            submission(
                delivery_graph,
                BTreeMap::from([(named("deliver"), delivery_binding())]),
            ),
            DeliveryPolicy::Required,
        )
        .await
        .assert_value_with("required policy accepts one valid delivery node");

    let two_deliveries = graph(vec![
        delivery_verifier("open", DeliveryMode::PullRequest),
        delivery_verifier("merge", DeliveryMode::Merge),
        succeed("done"),
    ]);
    assert_eq!(
        NativeV2Admission
            .admit(submission(
                two_deliveries,
                BTreeMap::from([
                    (named("open"), delivery_binding()),
                    (named("merge"), delivery_binding()),
                ]),
            ))
            .await,
        Err(NativeV2AdmissionError::DeliveryNodeCount {
            policy: DeliveryPolicy::Optional,
            found: 2,
        })
    );
}
