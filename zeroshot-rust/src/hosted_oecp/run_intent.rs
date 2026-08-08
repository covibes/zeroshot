use async_trait::async_trait;
use openengine_cluster_protocol::{
    ArtifactRef, GraphSpec, LegacyShipRequest, LegacyShipSourceKind, RegistryProfileRef,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::config::HostedAuthority;
use super::ports::{ISOLATION_PROFILE, PROVIDER_PROFILE};

pub(super) const MAX_RUN_INTENT_BYTES: usize = 10 * 1_024 * 1_024 + 64 * 1_024;
pub(super) const RUN_INTENT_DIGEST_HEADER: &str = "x-zero-run-intent-digest";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunIntentEnvelope {
    version: RunIntentVersion,
    graph: GraphSpec,
    input: RunIntentJobInput,
}

#[derive(Deserialize)]
enum RunIntentVersion {
    #[serde(rename = "zeroshot.run-intent/v2")]
    V2,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct RunIntentJobInput {
    source: LegacyShipSourceKind,
    issue: Option<String>,
    prompt: Option<String>,
    artifacts: Vec<ArtifactRef>,
}

impl RunIntentJobInput {
    pub(super) fn hosted_request(
        &self,
        authority: &HostedAuthority,
    ) -> Result<LegacyShipRequest, ()> {
        let request = LegacyShipRequest {
            source: self.source,
            issue: self.issue.clone(),
            prompt: self.prompt.clone(),
            artifacts: self.artifacts.clone(),
            isolation_profile: RegistryProfileRef::new(ISOLATION_PROFILE).map_err(|_| ())?,
            provider_profile: RegistryProfileRef::new(PROVIDER_PROFILE).map_err(|_| ())?,
            repository: authority.repository().to_owned(),
            provider: authority.provider().to_owned(),
            model_level: "level1".to_owned(),
        };
        request.validate().map_err(|_| ())?;
        Ok(request)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RunIntentIdentity {
    intent_id: String,
    digest: String,
}

impl RunIntentIdentity {
    pub(super) fn new(intent_id: String, digest: String) -> Self {
        Self { intent_id, digest }
    }

    pub(super) fn intent_id(&self) -> &str {
        &self.intent_id
    }

    pub(super) fn digest(&self) -> &str {
        &self.digest
    }
}

pub(super) struct RunIntentSubmission {
    pub(super) identity: RunIntentIdentity,
    pub(super) graph: GraphSpec,
    pub(super) input: RunIntentJobInput,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum RunIntentStatus {
    Running,
    Succeeded(Value),
    Failed(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum RunIntentLookup {
    Found(RunIntentStatus),
    NotFound,
    Conflict,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RunIntentSubmitError {
    Rejected,
    Conflict,
    Unavailable,
}

#[async_trait]
pub(super) trait RunIntentExecutor: Send + Sync {
    async fn submit(
        &self,
        submission: RunIntentSubmission,
    ) -> Result<RunIntentStatus, RunIntentSubmitError>;

    async fn lookup(&self, identity: &RunIntentIdentity) -> RunIntentLookup;
}

pub(super) fn decode_submission(
    identity: RunIntentIdentity,
    body: &[u8],
) -> Result<RunIntentSubmission, &'static str> {
    if digest_bytes(body) != identity.digest() {
        return Err("digest_mismatch");
    }
    let envelope: RunIntentEnvelope =
        serde_json::from_slice(body).map_err(|_| "invalid_run_intent")?;
    let RunIntentEnvelope {
        version: RunIntentVersion::V2,
        graph,
        input,
    } = envelope;
    Ok(RunIntentSubmission {
        identity,
        graph,
        input,
    })
}

pub(super) fn digest_bytes(body: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(body))
}

pub(super) fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

pub(super) fn canonical_intent_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
}
