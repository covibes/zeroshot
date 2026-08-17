use super::*;

#[tokio::test]
async fn canonical_goldens_prove_equivalence_digest_and_semantic_order_sensitivity() {
    let artifacts = generate_artifacts().await;
    let compiled_schema = json_artifact(&artifacts, "/compiled-ir.schema.json");
    let compiled_validator = jsonschema::validator_for(&compiled_schema).assert_value();
    let base_value = json_artifact(&artifacts, "/canonical/base.json");
    let reordered_value = json_artifact(&artifacts, "/canonical/reordered.json");
    let mutated_value = json_artifact(&artifacts, "/canonical/sequence-mutated.json");
    for (name, value) in [
        ("base", &base_value),
        ("reordered", &reordered_value),
        ("sequence-mutated", &mutated_value),
    ] {
        assert!(
            compiled_validator.is_valid(value),
            "compiled IR schema rejected canonical fixture {name}: {:?}",
            compiled_validator
                .iter_errors(value)
                .map(|error| error.to_string())
                .collect::<Vec<_>>()
        );
    }
    let base: CompiledGraphIr = serde_json::from_value(base_value).assert_value();
    let reordered: CompiledGraphIr = serde_json::from_value(reordered_value).assert_value();
    let mutated: CompiledGraphIr = serde_json::from_value(mutated_value).assert_value();
    let bytes = &artifacts
        .iter()
        .find(|artifact| {
            artifact
                .relative_path
                .ends_with("/canonical/base.canonical.json")
        })
        .assert_value()
        .bytes;
    let digest = std::str::from_utf8(
        artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("/canonical/base.sha256"))
            .assert_value()
            .bytes
            .strip_suffix(b"\n")
            .assert_value(),
    )
    .assert_value();

    assert_eq!(base.canonical_bytes().assert_value(), bytes.as_slice());
    let raw_digest = Sha256::digest(bytes);
    assert_eq!(format!("{raw_digest:x}"), digest);
    assert_eq!(base.identity().assert_value().as_str(), digest);
    assert_eq!(
        base.identity().assert_value(),
        reordered.identity().assert_value()
    );
    assert_ne!(
        base.identity().assert_value(),
        mutated.identity().assert_value()
    );
    println!("{digest}");
}
