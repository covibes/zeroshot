use super::*;

#[tokio::test]
async fn strict_freshness_advances_the_exact_head_before_merge() {
    assert_head_updates(Script::StrictBehind, 1, 2, 4).await;
}

#[tokio::test]
async fn repeated_base_advances_form_an_authorized_head_chain() {
    assert_head_updates(Script::RepeatedBehind, 2, 3, 5).await;
}

async fn assert_head_updates(
    script: Script,
    expected_updates: usize,
    expected_merge_requests: usize,
    attempts: usize,
) {
    let (repo, authority) = delivery_harness(script);

    let outcome = run_delivery(&repo, authority.clone(), attempts, DeliveryMode::Merge).await;

    let output = assert_delivery_signal(&outcome, DELIVERY_MERGED_LABEL);
    assert_receipt_match(output, DeliveryMode::Merge, &repo, true);
    assert_eq!(
        authority.head_updates.load(Ordering::SeqCst),
        expected_updates
    );
    assert_eq!(
        authority.merge_requests.load(Ordering::SeqCst),
        expected_merge_requests
    );
    let local_head = std::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(&repo.workspace)
        .args(["rev-parse", "HEAD"])
        .output()
        .assert_value();
    assert_eq!(
        output
            .pointer("/headRevision")
            .and_then(Value::as_str)
            .assert_value(),
        String::from_utf8(local_head.stdout).assert_value().trim()
    );
}
