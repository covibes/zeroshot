//! Shared "pull `schema.json` out of a generated artifact set and parse it" helper for tests that
//! validate golden/fixture payloads against the published schema. Used by `tests/artifacts.rs`,
//! `tests/logs.rs`, and `tests/agent_attach.rs`.

use openengine_cluster_testkit::artifacts::Artifact;

pub fn find_schema(artifacts: &[Artifact]) -> serde_json::Value {
    let schema = artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("/schema.json"))
        .unwrap();
    serde_json::from_slice(&schema.bytes).unwrap()
}
