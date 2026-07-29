//! Product-private required-command proof contracts.
//!
//! This module defines trusted configuration, immutable attempt intent/receipt values, and
//! fail-closed acceptance. It deliberately contains no command runner or persistence adapter.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use async_trait::async_trait;
use openengine_cluster_protocol::{ArtifactRef, Sha256Digest};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::artifact_store::ArtifactStore;
use crate::cluster_ledger::record::{CanonicalDigest, RecordPayload, RunSequence};
use crate::cluster_ledger::store::IdempotencyId;
use crate::cluster_ledger::{
    ClusterLedger, CommitRequest, CommitResult, LedgerError, LedgerErrorKind, MutationIdentity,
    ReceiptExpectation,
};
use crate::fault::FaultContext;

pub const REQUIRED_PROOF_VERSION_V1: u16 = 1;
pub const MAX_GATE_ID_BYTES: usize = 128;
pub const MAX_ARGUMENTS: usize = 64;
pub const MAX_ARGUMENT_BYTES: usize = 1_024;
pub const MAX_CWD_BYTES: usize = 1_024;
pub const MAX_ENVIRONMENT_ENTRIES: usize = 64;
pub const MAX_ENVIRONMENT_NAME_BYTES: usize = 128;
pub const MAX_ENVIRONMENT_VALUE_BYTES: usize = 4_096;
pub const MAX_TOOL_VALUE_BYTES: usize = 256;
pub const MAX_REPOSITORY_BYTES: usize = 512;
pub const MAX_RUN_ATTEMPTS: u32 = 1_024;
pub const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1_000;
pub const MAX_FRESHNESS_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const GATE_DIGEST_DOMAIN: &[u8] = b"zeroshot.required-proof.gate/v1\0";
const INTENT_DIGEST_DOMAIN: &[u8] = b"zeroshot.required-proof.intent/v1\0";
const RECEIPT_DIGEST_DOMAIN: &[u8] = b"zeroshot.required-proof.receipt/v1\0";
const ACCEPTANCE_DIGEST_DOMAIN: &[u8] = b"zeroshot.required-proof.acceptance/v1\0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequiredProofError {
    Decode,
    UnknownVersion,
    NonCanonical,
    Empty(&'static str),
    Oversized(&'static str),
    Invalid(&'static str),
    DigestMismatch(&'static str),
    BindingMismatch(&'static str),
    Incomplete,
    Indeterminate,
    NotPassing,
    Stale,
    FutureTimestamp,
    ArtifactMissing,
    ArtifactMismatch,
    ArtifactUnavailable,
    AuthorityUncertain,
    ConflictingAttempt,
}

impl fmt::Display for RequiredProofError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode => formatter.write_str("required-proof value cannot be decoded"),
            Self::UnknownVersion => formatter.write_str("required-proof version is unsupported"),
            Self::NonCanonical => formatter.write_str("required-proof encoding is not canonical"),
            Self::Empty(field) => write!(formatter, "{field} must not be empty"),
            Self::Oversized(field) => write!(formatter, "{field} exceeds its bound"),
            Self::Invalid(field) => write!(formatter, "{field} is invalid"),
            Self::DigestMismatch(field) => write!(formatter, "{field} digest does not match"),
            Self::BindingMismatch(field) => write!(formatter, "{field} binding does not match"),
            Self::Incomplete => formatter.write_str("proof attempt is incomplete"),
            Self::Indeterminate => formatter.write_str("proof attempt is indeterminate"),
            Self::NotPassing => formatter.write_str("proof attempt did not pass"),
            Self::Stale => formatter.write_str("proof attempt is stale"),
            Self::FutureTimestamp => {
                formatter.write_str("proof attempt timestamp is in the future")
            }
            Self::ArtifactMissing => formatter.write_str("proof output artifact is missing"),
            Self::ArtifactMismatch => formatter.write_str("proof output artifact does not match"),
            Self::ArtifactUnavailable => {
                formatter.write_str("proof output artifact is unavailable")
            }
            Self::AuthorityUncertain => formatter.write_str("proof attempt authority is uncertain"),
            Self::ConflictingAttempt => {
                formatter.write_str("proof attempt conflicts with authority")
            }
        }
    }
}

impl Error for RequiredProofError {}

#[derive(Clone, Debug)]
pub struct TrustedGateRequest {
    pub gate_id: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub inherited_env: BTreeSet<String>,
    pub explicit_env: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub freshness_ms: u64,
    pub tool_identity: String,
    pub tool_version: String,
    pub tool_digest: CanonicalDigest,
    pub repository: String,
    pub base_revision: String,
    pub head_revision: String,
    pub config_digest: CanonicalDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct TrustedGateBody {
    version: u16,
    gate_id: String,
    argv: Vec<String>,
    cwd: String,
    inherited_env: BTreeSet<String>,
    explicit_env: BTreeMap<String, String>,
    timeout_ms: u64,
    freshness_ms: u64,
    tool_identity: String,
    tool_version: String,
    tool_digest: CanonicalDigest,
    repository: String,
    base_revision: String,
    head_revision: String,
    config_digest: CanonicalDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedGate {
    body: TrustedGateBody,
    gate_digest: CanonicalDigest,
}

impl TrustedGate {
    pub fn new(request: TrustedGateRequest) -> Result<Self, RequiredProofError> {
        let body = TrustedGateBody {
            version: REQUIRED_PROOF_VERSION_V1,
            gate_id: request.gate_id,
            argv: request.argv,
            cwd: request.cwd,
            inherited_env: request.inherited_env,
            explicit_env: request.explicit_env,
            timeout_ms: request.timeout_ms,
            freshness_ms: request.freshness_ms,
            tool_identity: request.tool_identity,
            tool_version: request.tool_version,
            tool_digest: request.tool_digest,
            repository: request.repository,
            base_revision: request.base_revision,
            head_revision: request.head_revision,
            config_digest: request.config_digest,
        };
        validate_gate_body(&body)?;
        let gate_digest = domain_digest(GATE_DIGEST_DOMAIN, &canonical_json(&body)?);
        Ok(Self { body, gate_digest })
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RequiredProofError> {
        decode_canonical(bytes, Self::validate)
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, RequiredProofError> {
        self.validate()?;
        canonical_json(self)
    }

    pub fn validate(&self) -> Result<(), RequiredProofError> {
        validate_gate_body(&self.body)?;
        let expected = domain_digest(GATE_DIGEST_DOMAIN, &canonical_json(&self.body)?);
        if self.gate_digest != expected {
            return Err(RequiredProofError::DigestMismatch("gate"));
        }
        Ok(())
    }

    #[must_use]
    pub fn gate_id(&self) -> &str {
        &self.body.gate_id
    }
    #[must_use]
    pub fn argv(&self) -> &[String] {
        &self.body.argv
    }
    #[must_use]
    pub fn cwd(&self) -> &str {
        &self.body.cwd
    }
    #[must_use]
    pub fn inherited_env(&self) -> &BTreeSet<String> {
        &self.body.inherited_env
    }
    #[must_use]
    pub fn explicit_env(&self) -> &BTreeMap<String, String> {
        &self.body.explicit_env
    }
    #[must_use]
    pub const fn timeout_ms(&self) -> u64 {
        self.body.timeout_ms
    }
    #[must_use]
    pub const fn freshness_ms(&self) -> u64 {
        self.body.freshness_ms
    }
    #[must_use]
    pub fn tool_identity(&self) -> &str {
        &self.body.tool_identity
    }
    #[must_use]
    pub fn tool_version(&self) -> &str {
        &self.body.tool_version
    }
    #[must_use]
    pub const fn tool_digest(&self) -> CanonicalDigest {
        self.body.tool_digest
    }
    #[must_use]
    pub fn repository(&self) -> &str {
        &self.body.repository
    }
    #[must_use]
    pub fn base_revision(&self) -> &str {
        &self.body.base_revision
    }
    #[must_use]
    pub fn head_revision(&self) -> &str {
        &self.body.head_revision
    }
    #[must_use]
    pub const fn config_digest(&self) -> CanonicalDigest {
        self.body.config_digest
    }
    #[must_use]
    pub const fn gate_digest(&self) -> CanonicalDigest {
        self.gate_digest
    }
}

fn validate_gate_body(body: &TrustedGateBody) -> Result<(), RequiredProofError> {
    require_version(body.version)?;
    bounded_nonempty(&body.gate_id, MAX_GATE_ID_BYTES, "gate ID")?;
    if body.argv.is_empty() {
        return Err(RequiredProofError::Empty("argv"));
    }
    if body.argv.len() > MAX_ARGUMENTS {
        return Err(RequiredProofError::Oversized("argv"));
    }
    for argument in &body.argv {
        bounded_nonempty(argument, MAX_ARGUMENT_BYTES, "argument")?;
        if argument.contains('\0') {
            return Err(RequiredProofError::Invalid("argument"));
        }
    }
    validate_cwd(&body.cwd)?;
    if body.inherited_env.len() > MAX_ENVIRONMENT_ENTRIES
        || body.explicit_env.len() > MAX_ENVIRONMENT_ENTRIES
    {
        return Err(RequiredProofError::Oversized("environment"));
    }
    for name in &body.inherited_env {
        validate_env_name(name)?;
    }
    for (name, value) in &body.explicit_env {
        validate_env_name(name)?;
        if body.inherited_env.contains(name) {
            return Err(RequiredProofError::Invalid("environment overlap"));
        }
        if value.len() > MAX_ENVIRONMENT_VALUE_BYTES {
            return Err(RequiredProofError::Oversized("environment value"));
        }
        if value.contains('\0') || value.chars().any(char::is_control) {
            return Err(RequiredProofError::Invalid("environment value"));
        }
        validate_explicit_environment(name, value)?;
    }
    if body.timeout_ms == 0 || body.timeout_ms > MAX_TIMEOUT_MS {
        return Err(RequiredProofError::Invalid("timeout"));
    }
    if body.freshness_ms == 0 || body.freshness_ms > MAX_FRESHNESS_MS {
        return Err(RequiredProofError::Invalid("freshness"));
    }
    bounded_nonempty(&body.tool_identity, MAX_TOOL_VALUE_BYTES, "tool identity")?;
    bounded_nonempty(&body.tool_version, MAX_TOOL_VALUE_BYTES, "tool version")?;
    validate_repository(&body.repository)?;
    validate_revision(&body.base_revision)?;
    validate_revision(&body.head_revision)?;
    if body.base_revision == body.head_revision {
        return Err(RequiredProofError::Invalid("revision range"));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofSelection {
    gate_id: String,
    repository: String,
    base_revision: String,
    head_revision: String,
}

impl ProofSelection {
    pub fn admitted(gate: &TrustedGate) -> Self {
        Self {
            gate_id: gate.body.gate_id.clone(),
            repository: gate.body.repository.clone(),
            base_revision: gate.body.base_revision.clone(),
            head_revision: gate.body.head_revision.clone(),
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RequiredProofError> {
        decode_canonical(bytes, Self::validate)
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, RequiredProofError> {
        self.validate()?;
        canonical_json(self)
    }

    pub fn validate(&self) -> Result<(), RequiredProofError> {
        bounded_nonempty(&self.gate_id, MAX_GATE_ID_BYTES, "gate ID")?;
        validate_repository(&self.repository)?;
        validate_revision(&self.base_revision)?;
        validate_revision(&self.head_revision)
    }

    pub fn matches(&self, gate: &TrustedGate) -> Result<(), RequiredProofError> {
        gate.validate()?;
        binding(self.gate_id == gate.gate_id(), "gate")?;
        binding(self.repository == gate.repository(), "repository")?;
        binding(self.base_revision == gate.base_revision(), "base revision")?;
        binding(self.head_revision == gate.head_revision(), "head revision")
    }

    #[must_use]
    pub fn gate_id(&self) -> &str {
        &self.gate_id
    }
    #[must_use]
    pub fn repository(&self) -> &str {
        &self.repository
    }
    #[must_use]
    pub fn base_revision(&self) -> &str {
        &self.base_revision
    }
    #[must_use]
    pub fn head_revision(&self) -> &str {
        &self.head_revision
    }
}

#[derive(Clone, Debug)]
pub struct ProofAttemptIntentRequest {
    pub run: RunSequence,
    pub attempt: u32,
    pub requested_at_ms: u64,
    pub selection: ProofSelection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ProofAttemptIntentBody {
    version: u16,
    run: RunSequence,
    attempt: u32,
    requested_at_ms: u64,
    selection: ProofSelection,
    config_digest: CanonicalDigest,
    gate_digest: CanonicalDigest,
    tool_identity: String,
    tool_version: String,
    tool_digest: CanonicalDigest,
    timeout_ms: u64,
    freshness_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofAttemptIntent {
    body: ProofAttemptIntentBody,
    intent_id: CanonicalDigest,
}

impl ProofAttemptIntent {
    pub fn new(
        gate: &TrustedGate,
        request: ProofAttemptIntentRequest,
    ) -> Result<Self, RequiredProofError> {
        gate.validate()?;
        request.selection.matches(gate)?;
        if request.attempt == 0 || request.attempt > MAX_RUN_ATTEMPTS {
            return Err(RequiredProofError::Invalid("attempt"));
        }
        let body = ProofAttemptIntentBody {
            version: REQUIRED_PROOF_VERSION_V1,
            run: request.run,
            attempt: request.attempt,
            requested_at_ms: request.requested_at_ms,
            selection: request.selection,
            config_digest: gate.config_digest(),
            gate_digest: gate.gate_digest(),
            tool_identity: gate.tool_identity().to_owned(),
            tool_version: gate.tool_version().to_owned(),
            tool_digest: gate.tool_digest(),
            timeout_ms: gate.timeout_ms(),
            freshness_ms: gate.freshness_ms(),
        };
        validate_intent_body(&body)?;
        let intent_id = domain_digest(INTENT_DIGEST_DOMAIN, &canonical_json(&body)?);
        Ok(Self { body, intent_id })
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RequiredProofError> {
        decode_canonical(bytes, Self::validate)
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, RequiredProofError> {
        self.validate()?;
        canonical_json(self)
    }
    pub fn validate(&self) -> Result<(), RequiredProofError> {
        validate_intent_body(&self.body)?;
        let expected = domain_digest(INTENT_DIGEST_DOMAIN, &canonical_json(&self.body)?);
        if self.intent_id != expected {
            return Err(RequiredProofError::DigestMismatch("intent"));
        }
        Ok(())
    }
    pub fn matches_gate(&self, gate: &TrustedGate) -> Result<(), RequiredProofError> {
        self.validate()?;
        self.body.selection.matches(gate)?;
        binding(self.body.config_digest == gate.config_digest(), "config")?;
        binding(self.body.gate_digest == gate.gate_digest(), "gate digest")?;
        binding(
            self.body.tool_identity == gate.tool_identity(),
            "tool identity",
        )?;
        binding(
            self.body.tool_version == gate.tool_version(),
            "tool version",
        )?;
        binding(self.body.tool_digest == gate.tool_digest(), "tool digest")?;
        binding(self.body.timeout_ms == gate.timeout_ms(), "timeout")?;
        binding(self.body.freshness_ms == gate.freshness_ms(), "freshness")
    }
    #[must_use]
    pub const fn intent_id(&self) -> CanonicalDigest {
        self.intent_id
    }
    #[must_use]
    pub const fn run(&self) -> RunSequence {
        self.body.run
    }
    #[must_use]
    pub const fn attempt(&self) -> u32 {
        self.body.attempt
    }
    #[must_use]
    pub const fn requested_at_ms(&self) -> u64 {
        self.body.requested_at_ms
    }
    #[must_use]
    pub fn selection(&self) -> &ProofSelection {
        &self.body.selection
    }
    #[must_use]
    pub const fn config_digest(&self) -> CanonicalDigest {
        self.body.config_digest
    }
    #[must_use]
    pub const fn gate_digest(&self) -> CanonicalDigest {
        self.body.gate_digest
    }
    #[must_use]
    pub const fn tool_digest(&self) -> CanonicalDigest {
        self.body.tool_digest
    }
    #[must_use]
    pub const fn timeout_ms(&self) -> u64 {
        self.body.timeout_ms
    }
    #[must_use]
    pub const fn freshness_ms(&self) -> u64 {
        self.body.freshness_ms
    }
}

fn validate_intent_body(body: &ProofAttemptIntentBody) -> Result<(), RequiredProofError> {
    require_version(body.version)?;
    if body.run.get() == 0 {
        return Err(RequiredProofError::Invalid("run"));
    }
    if body.attempt == 0 || body.attempt > MAX_RUN_ATTEMPTS {
        return Err(RequiredProofError::Invalid("attempt"));
    }
    body.selection.validate()?;
    bounded_nonempty(&body.tool_identity, MAX_TOOL_VALUE_BYTES, "tool identity")?;
    bounded_nonempty(&body.tool_version, MAX_TOOL_VALUE_BYTES, "tool version")?;
    if body.timeout_ms == 0 || body.timeout_ms > MAX_TIMEOUT_MS {
        return Err(RequiredProofError::Invalid("timeout"));
    }
    if body.freshness_ms == 0 || body.freshness_ms > MAX_FRESHNESS_MS {
        return Err(RequiredProofError::Invalid("freshness"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessOutcome {
    Exited { exit_code: i32 },
    Signaled { signal: u8 },
    TimedOut,
    Incomplete,
    Indeterminate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofOutput {
    digest: CanonicalDigest,
    artifact: ArtifactRef,
}

impl ProofOutput {
    pub fn new(artifact: ArtifactRef) -> Result<Self, RequiredProofError> {
        let digest = protocol_digest(&artifact.sha256)?;
        Ok(Self { digest, artifact })
    }
    fn validate(&self) -> Result<(), RequiredProofError> {
        if self.digest != protocol_digest(&self.artifact.sha256)? {
            return Err(RequiredProofError::DigestMismatch("artifact"));
        }
        Ok(())
    }
    #[must_use]
    pub const fn digest(&self) -> CanonicalDigest {
        self.digest
    }
    #[must_use]
    pub fn artifact(&self) -> &ArtifactRef {
        &self.artifact
    }
}

#[derive(Clone, Debug)]
pub struct ProofAttemptReceiptRequest {
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub outcome: ProcessOutcome,
    pub stdout: Option<ProofOutput>,
    pub stderr: Option<ProofOutput>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ProofAttemptReceiptBody {
    version: u16,
    intent_id: CanonicalDigest,
    run: RunSequence,
    attempt: u32,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    outcome: ProcessOutcome,
    stdout: Option<ProofOutput>,
    stderr: Option<ProofOutput>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofAttemptReceipt {
    body: ProofAttemptReceiptBody,
    receipt_digest: CanonicalDigest,
}

impl ProofAttemptReceipt {
    pub fn new(
        intent: &ProofAttemptIntent,
        request: ProofAttemptReceiptRequest,
    ) -> Result<Self, RequiredProofError> {
        intent.validate()?;
        let body = ProofAttemptReceiptBody {
            version: REQUIRED_PROOF_VERSION_V1,
            intent_id: intent.intent_id(),
            run: intent.run(),
            attempt: intent.attempt(),
            started_at_ms: request.started_at_ms,
            finished_at_ms: request.finished_at_ms,
            outcome: request.outcome,
            stdout: request.stdout,
            stderr: request.stderr,
        };
        validate_receipt_body(&body)?;
        let receipt_digest = domain_digest(RECEIPT_DIGEST_DOMAIN, &canonical_json(&body)?);
        Ok(Self {
            body,
            receipt_digest,
        })
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, RequiredProofError> {
        decode_canonical(bytes, Self::validate)
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, RequiredProofError> {
        self.validate()?;
        canonical_json(self)
    }
    pub fn validate(&self) -> Result<(), RequiredProofError> {
        validate_receipt_body(&self.body)?;
        let expected = domain_digest(RECEIPT_DIGEST_DOMAIN, &canonical_json(&self.body)?);
        if self.receipt_digest != expected {
            return Err(RequiredProofError::DigestMismatch("receipt"));
        }
        Ok(())
    }
    pub fn matches_intent(&self, intent: &ProofAttemptIntent) -> Result<(), RequiredProofError> {
        self.validate()?;
        intent.validate()?;
        binding(self.body.intent_id == intent.intent_id(), "intent")?;
        binding(self.body.run == intent.run(), "run")?;
        binding(self.body.attempt == intent.attempt(), "attempt")
    }
    #[must_use]
    pub const fn receipt_digest(&self) -> CanonicalDigest {
        self.receipt_digest
    }
    #[must_use]
    pub const fn intent_id(&self) -> CanonicalDigest {
        self.body.intent_id
    }
    #[must_use]
    pub const fn run(&self) -> RunSequence {
        self.body.run
    }
    #[must_use]
    pub const fn attempt(&self) -> u32 {
        self.body.attempt
    }
    #[must_use]
    pub const fn started_at_ms(&self) -> u64 {
        self.body.started_at_ms
    }
    #[must_use]
    pub const fn finished_at_ms(&self) -> Option<u64> {
        self.body.finished_at_ms
    }
    #[must_use]
    pub const fn outcome(&self) -> ProcessOutcome {
        self.body.outcome
    }
    #[must_use]
    pub fn stdout(&self) -> Option<&ProofOutput> {
        self.body.stdout.as_ref()
    }
    #[must_use]
    pub fn stderr(&self) -> Option<&ProofOutput> {
        self.body.stderr.as_ref()
    }
}

fn validate_receipt_body(body: &ProofAttemptReceiptBody) -> Result<(), RequiredProofError> {
    require_version(body.version)?;
    if body.run.get() == 0 || body.attempt == 0 || body.attempt > MAX_RUN_ATTEMPTS {
        return Err(RequiredProofError::Invalid("attempt identity"));
    }
    if let Some(finished) = body.finished_at_ms {
        if finished < body.started_at_ms {
            return Err(RequiredProofError::Invalid("timestamps"));
        }
    }
    if matches!(body.outcome, ProcessOutcome::Signaled { signal: 0 }) {
        return Err(RequiredProofError::Invalid("signal"));
    }
    if matches!(body.outcome, ProcessOutcome::Incomplete) {
        if body.finished_at_ms.is_some() {
            return Err(RequiredProofError::Invalid("incomplete timestamp"));
        }
    } else if body.finished_at_ms.is_none() {
        return Err(RequiredProofError::Incomplete);
    }
    if matches!(body.outcome, ProcessOutcome::Indeterminate)
        && (body.stdout.is_some() || body.stderr.is_some())
    {
        return Err(RequiredProofError::Invalid("indeterminate output"));
    }
    if let Some(output) = &body.stdout {
        output.validate()?;
        validate_output_lineage(output, body.run, body.attempt)?;
    }
    if let Some(output) = &body.stderr {
        output.validate()?;
        validate_output_lineage(output, body.run, body.attempt)?;
    }
    Ok(())
}

fn validate_output_lineage(
    output: &ProofOutput,
    run: RunSequence,
    attempt: u32,
) -> Result<(), RequiredProofError> {
    let expected_run = format!("run:{}", run.get());
    binding(
        output.artifact.lineage.run_id.as_str() == expected_run,
        "artifact run",
    )?;
    binding(
        output.artifact.lineage.attempt.get() == u64::from(attempt),
        "artifact attempt",
    )
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedProofRef {
    version: u16,
    gate_id: String,
    repository: String,
    base_revision: String,
    head_revision: String,
    run: RunSequence,
    attempt: u32,
    intent_id: CanonicalDigest,
    receipt_digest: CanonicalDigest,
    accepted_at_ms: u64,
    acceptance_digest: CanonicalDigest,
}

#[derive(Serialize)]
struct AcceptanceBody<'a> {
    version: u16,
    gate_id: &'a str,
    repository: &'a str,
    base_revision: &'a str,
    head_revision: &'a str,
    run: RunSequence,
    attempt: u32,
    intent_id: CanonicalDigest,
    receipt_digest: CanonicalDigest,
    accepted_at_ms: u64,
}

pub struct AcceptProofRequest<'a> {
    pub gate: &'a TrustedGate,
    pub intent: &'a ProofAttemptIntent,
    pub receipt: &'a ProofAttemptReceipt,
    pub accepted_at_ms: u64,
    pub artifacts: &'a dyn ArtifactReverification,
}

impl AcceptedProofRef {
    pub async fn accept(request: AcceptProofRequest<'_>) -> Result<Self, RequiredProofError> {
        let AcceptProofRequest {
            gate,
            intent,
            receipt,
            accepted_at_ms,
            artifacts,
        } = request;
        validate_passing_attempt(gate, intent, receipt, accepted_at_ms)?;
        let stdout = receipt
            .stdout()
            .ok_or(RequiredProofError::ArtifactMissing)?;
        let stderr = receipt
            .stderr()
            .ok_or(RequiredProofError::ArtifactMissing)?;
        artifacts.reverify(stdout.artifact()).await?;
        artifacts.reverify(stderr.artifact()).await?;
        let selection = intent.selection();
        let body = AcceptanceBody {
            version: REQUIRED_PROOF_VERSION_V1,
            gate_id: selection.gate_id(),
            repository: selection.repository(),
            base_revision: selection.base_revision(),
            head_revision: selection.head_revision(),
            run: intent.run(),
            attempt: intent.attempt(),
            intent_id: intent.intent_id(),
            receipt_digest: receipt.receipt_digest(),
            accepted_at_ms,
        };
        let acceptance_digest = domain_digest(ACCEPTANCE_DIGEST_DOMAIN, &canonical_json(&body)?);
        Ok(Self {
            version: body.version,
            gate_id: body.gate_id.to_owned(),
            repository: body.repository.to_owned(),
            base_revision: body.base_revision.to_owned(),
            head_revision: body.head_revision.to_owned(),
            run: body.run,
            attempt: body.attempt,
            intent_id: body.intent_id,
            receipt_digest: body.receipt_digest,
            accepted_at_ms: body.accepted_at_ms,
            acceptance_digest,
        })
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RequiredProofError> {
        decode_canonical(bytes, Self::validate_self)
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, RequiredProofError> {
        self.validate_self()?;
        canonical_json(self)
    }
    fn validate_self(&self) -> Result<(), RequiredProofError> {
        require_version(self.version)?;
        bounded_nonempty(&self.gate_id, MAX_GATE_ID_BYTES, "gate ID")?;
        validate_repository(&self.repository)?;
        validate_revision(&self.base_revision)?;
        validate_revision(&self.head_revision)?;
        if self.run.get() == 0 || self.attempt == 0 || self.attempt > MAX_RUN_ATTEMPTS {
            return Err(RequiredProofError::Invalid("attempt identity"));
        }
        let body = AcceptanceBody {
            version: self.version,
            gate_id: &self.gate_id,
            repository: &self.repository,
            base_revision: &self.base_revision,
            head_revision: &self.head_revision,
            run: self.run,
            attempt: self.attempt,
            intent_id: self.intent_id,
            receipt_digest: self.receipt_digest,
            accepted_at_ms: self.accepted_at_ms,
        };
        let expected = domain_digest(ACCEPTANCE_DIGEST_DOMAIN, &canonical_json(&body)?);
        if self.acceptance_digest != expected {
            return Err(RequiredProofError::DigestMismatch("acceptance"));
        }
        Ok(())
    }
    pub fn matches(
        &self,
        intent: &ProofAttemptIntent,
        receipt: &ProofAttemptReceipt,
    ) -> Result<(), RequiredProofError> {
        self.validate_self()?;
        receipt.matches_intent(intent)?;
        binding(self.gate_id == intent.selection().gate_id(), "gate")?;
        binding(
            self.repository == intent.selection().repository(),
            "repository",
        )?;
        binding(
            self.base_revision == intent.selection().base_revision(),
            "base revision",
        )?;
        binding(
            self.head_revision == intent.selection().head_revision(),
            "head revision",
        )?;
        binding(self.run == intent.run(), "run")?;
        binding(self.attempt == intent.attempt(), "attempt")?;
        binding(self.intent_id == intent.intent_id(), "intent")?;
        binding(self.receipt_digest == receipt.receipt_digest(), "receipt")?;
        validate_bound_passing_attempt(intent, receipt, self.accepted_at_ms)
    }
    #[must_use]
    pub const fn run(&self) -> RunSequence {
        self.run
    }
    #[must_use]
    pub const fn attempt(&self) -> u32 {
        self.attempt
    }
    #[must_use]
    pub const fn intent_id(&self) -> CanonicalDigest {
        self.intent_id
    }
    #[must_use]
    pub const fn receipt_digest(&self) -> CanonicalDigest {
        self.receipt_digest
    }
    #[must_use]
    pub const fn acceptance_digest(&self) -> CanonicalDigest {
        self.acceptance_digest
    }
}

fn validate_passing_attempt(
    gate: &TrustedGate,
    intent: &ProofAttemptIntent,
    receipt: &ProofAttemptReceipt,
    now_ms: u64,
) -> Result<(), RequiredProofError> {
    intent.matches_gate(gate)?;
    validate_bound_passing_attempt(intent, receipt, now_ms)
}

fn validate_bound_passing_attempt(
    intent: &ProofAttemptIntent,
    receipt: &ProofAttemptReceipt,
    now_ms: u64,
) -> Result<(), RequiredProofError> {
    receipt.matches_intent(intent)?;
    match receipt.outcome() {
        ProcessOutcome::Exited { exit_code: 0 } => {}
        ProcessOutcome::Incomplete => return Err(RequiredProofError::Incomplete),
        ProcessOutcome::Indeterminate => return Err(RequiredProofError::Indeterminate),
        _ => return Err(RequiredProofError::NotPassing),
    }
    let finished = receipt
        .finished_at_ms()
        .ok_or(RequiredProofError::Incomplete)?;
    if finished > now_ms {
        return Err(RequiredProofError::FutureTimestamp);
    }
    if now_ms.saturating_sub(finished) > intent.freshness_ms() {
        return Err(RequiredProofError::Stale);
    }
    if receipt.started_at_ms() < intent.requested_at_ms() {
        return Err(RequiredProofError::BindingMismatch("attempt timestamp"));
    }
    if finished.saturating_sub(receipt.started_at_ms()) > intent.timeout_ms() {
        return Err(RequiredProofError::BindingMismatch("timeout"));
    }
    if receipt.stdout().is_none() || receipt.stderr().is_none() {
        return Err(RequiredProofError::ArtifactMissing);
    }
    Ok(())
}

#[async_trait]
pub trait ArtifactReverification: Send + Sync {
    async fn reverify(&self, expected: &ArtifactRef) -> Result<(), RequiredProofError>;
}

#[async_trait]
impl<T> ArtifactReverification for T
where
    T: ArtifactStore + Send + Sync + ?Sized,
{
    async fn reverify(&self, expected: &ArtifactRef) -> Result<(), RequiredProofError> {
        let inspected = self
            .inspect(&expected.artifact_id)
            .await
            .map_err(|_| RequiredProofError::ArtifactUnavailable)?;
        if inspected.as_ref() != Some(expected) {
            return Err(inspected.map_or(RequiredProofError::ArtifactMissing, |_| {
                RequiredProofError::ArtifactMismatch
            }));
        }
        let mut stream = self
            .open(&expected.artifact_id)
            .await
            .map_err(|_| RequiredProofError::ArtifactUnavailable)?;
        let mut hasher = Sha256::new();
        let mut length = 0_u64;
        let mut buffer = [0_u8; 8 * 1_024];
        loop {
            let read = stream
                .read(&mut buffer)
                .await
                .map_err(|_| RequiredProofError::ArtifactUnavailable)?;
            if read == 0 {
                break;
            }
            length = length
                .checked_add(read as u64)
                .ok_or(RequiredProofError::ArtifactMismatch)?;
            if length > expected.byte_length.get() {
                return Err(RequiredProofError::ArtifactMismatch);
            }
            hasher.update(&buffer[..read]);
        }
        let actual_digest = CanonicalDigest::new(hasher.finalize().into());
        if length != expected.byte_length.get()
            || actual_digest != protocol_digest(&expected.sha256)?
        {
            return Err(RequiredProofError::ArtifactMismatch);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PerformProofAttempt {
    intent: ProofAttemptIntent,
}

impl PerformProofAttempt {
    #[must_use]
    pub fn new(intent: ProofAttemptIntent) -> Self {
        Self { intent }
    }
    #[must_use]
    pub fn idempotency_identity(&self) -> CanonicalDigest {
        self.intent.intent_id()
    }
    #[must_use]
    pub fn intent(&self) -> &ProofAttemptIntent {
        &self.intent
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InspectProofAttempt {
    run: RunSequence,
    attempt: u32,
    intent_id: CanonicalDigest,
}

impl InspectProofAttempt {
    #[must_use]
    pub fn for_intent(intent: &ProofAttemptIntent) -> Self {
        Self {
            run: intent.run(),
            attempt: intent.attempt(),
            intent_id: intent.intent_id(),
        }
    }

    #[must_use]
    pub const fn run(self) -> RunSequence {
        self.run
    }

    #[must_use]
    pub const fn attempt(self) -> u32 {
        self.attempt
    }

    #[must_use]
    pub const fn idempotency_identity(self) -> CanonicalDigest {
        self.intent_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthoritativeAttempt {
    Missing,
    IntentOnly(Box<ProofAttemptIntent>),
    Receipt {
        intent: Box<ProofAttemptIntent>,
        receipt: Box<ProofAttemptReceipt>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconcileProofAttempt {
    intent: ProofAttemptIntent,
    authority: AuthoritativeAttempt,
}

impl ReconcileProofAttempt {
    #[must_use]
    pub fn new(intent: ProofAttemptIntent, authority: AuthoritativeAttempt) -> Self {
        Self { intent, authority }
    }

    pub fn resolve(self) -> Result<ProofAttemptReceipt, RequiredProofError> {
        reconcile_after_uncertainty(&self.intent, self.authority)
    }
}

pub fn reconcile_after_uncertainty(
    intent: &ProofAttemptIntent,
    authority: AuthoritativeAttempt,
) -> Result<ProofAttemptReceipt, RequiredProofError> {
    intent.validate()?;
    match authority {
        AuthoritativeAttempt::Receipt {
            intent: authoritative_intent,
            receipt,
        } => {
            if authoritative_intent.as_ref() != intent {
                return Err(RequiredProofError::ConflictingAttempt);
            }
            receipt.matches_intent(intent)?;
            Ok(*receipt)
        }
        AuthoritativeAttempt::IntentOnly(authoritative) if authoritative.as_ref() != intent => {
            Err(RequiredProofError::ConflictingAttempt)
        }
        AuthoritativeAttempt::Missing | AuthoritativeAttempt::IntentOnly(_) => {
            Err(RequiredProofError::AuthorityUncertain)
        }
    }
}

impl ProofAttemptIntent {
    pub fn ledger_record(&self) -> Result<RecordPayload, RequiredProofError> {
        Ok(RecordPayload::RequiredProofIntent {
            run: self.run(),
            attempt: self.attempt(),
            digest: self.intent_id(),
            canonical_bytes: self.canonical_bytes()?,
        })
    }
}

impl ProofAttemptReceipt {
    pub fn ledger_record(&self) -> Result<RecordPayload, RequiredProofError> {
        Ok(RecordPayload::RequiredProofReceipt {
            run: self.run(),
            attempt: self.attempt(),
            digest: self.receipt_digest(),
            canonical_bytes: self.canonical_bytes()?,
        })
    }
}

impl AcceptedProofRef {
    pub fn ledger_record(&self) -> Result<RecordPayload, RequiredProofError> {
        Ok(RecordPayload::RequiredProofAcceptance {
            run: self.run(),
            attempt: self.attempt(),
            digest: self.acceptance_digest(),
            canonical_bytes: self.canonical_bytes()?,
        })
    }
}
struct RequiredProofCommit<F> {
    key: IdempotencyId,
    method: &'static str,
    response: CanonicalDigest,
    payload: Result<RecordPayload, RequiredProofError>,
    is_legal: F,
}

impl ClusterLedger {
    pub async fn record_required_proof_intent(
        &self,
        key: IdempotencyId,
        intent: ProofAttemptIntent,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError> {
        self.commit_required_proof(RequiredProofCommit {
            key,
            method: "required_proof_intent",
            response: intent.intent_id(),
            payload: intent.ledger_record(),
            is_legal: |state: &crate::cluster_ledger::ReplayState| {
                state
                    .admission
                    .as_ref()
                    .is_some_and(|admission| admission.run == intent.run())
                    && !state.required_proofs.iter().any(|proof| {
                        proof.intent.run() == intent.run()
                            && proof.intent.attempt() == intent.attempt()
                    })
            },
        })
        .await
    }

    pub async fn record_required_proof_receipt(
        &self,
        key: IdempotencyId,
        receipt: ProofAttemptReceipt,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError> {
        self.commit_required_proof(RequiredProofCommit {
            key,
            method: "required_proof_receipt",
            response: receipt.receipt_digest(),
            payload: receipt.ledger_record(),
            is_legal: |state: &crate::cluster_ledger::ReplayState| {
                state.required_proofs.iter().any(|proof| {
                    proof.intent.run() == receipt.run()
                        && proof.intent.attempt() == receipt.attempt()
                        && proof.receipt.is_none()
                        && receipt.matches_intent(&proof.intent).is_ok()
                })
            },
        })
        .await
    }

    pub async fn record_required_proof_acceptance(
        &self,
        key: IdempotencyId,
        accepted: AcceptedProofRef,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError> {
        self.commit_required_proof(RequiredProofCommit {
            key,
            method: "required_proof_acceptance",
            response: accepted.acceptance_digest(),
            payload: accepted.ledger_record(),
            is_legal: |state: &crate::cluster_ledger::ReplayState| {
                state.required_proofs.iter().any(|proof| {
                    proof.intent.run() == accepted.run()
                        && proof.intent.attempt() == accepted.attempt()
                        && proof.accepted.is_none()
                        && proof
                            .receipt
                            .as_ref()
                            .is_some_and(|receipt| accepted.matches(&proof.intent, receipt).is_ok())
                })
            },
        })
        .await
    }

    async fn commit_required_proof<F>(
        &self,
        request: RequiredProofCommit<F>,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError>
    where
        F: FnOnce(&crate::cluster_ledger::ReplayState) -> bool,
    {
        let RequiredProofCommit {
            key,
            method,
            response,
            payload,
            is_legal,
        } = request;
        let state = self.validated_state(FaultContext::Settlement).await?;
        let fingerprint = response.as_bytes();
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Settlement, method, fingerprint),
        )? {
            return Ok(receipt);
        }
        let payload = payload
            .map_err(|_| self.domain_error(FaultContext::Settlement, LedgerErrorKind::Encoding))?;
        if state.terminal_outcome.is_some() || !is_legal(&state) {
            return Err(
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            );
        }
        self.commit(
            CommitRequest::new(
                FaultContext::Settlement,
                &state,
                MutationIdentity::new(key, method, fingerprint),
                &response,
            )
            .with_payloads(vec![payload]),
        )
        .await
    }
}

fn decode_canonical<T>(
    bytes: &[u8],
    validate: fn(&T) -> Result<(), RequiredProofError>,
) -> Result<T, RequiredProofError>
where
    T: DeserializeOwned + Serialize,
{
    if bytes.len() > crate::cluster_ledger::record::MAX_RECORD_PAYLOAD_BYTES {
        return Err(RequiredProofError::Oversized("encoding"));
    }
    let value: T = serde_json::from_slice(bytes).map_err(|_| RequiredProofError::Decode)?;
    validate(&value)?;
    if canonical_json(&value)? != bytes {
        return Err(RequiredProofError::NonCanonical);
    }
    Ok(value)
}

fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, RequiredProofError> {
    serde_json::to_vec(value).map_err(|_| RequiredProofError::Decode)
}

fn domain_digest(domain: &[u8], bytes: &[u8]) -> CanonicalDigest {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
    CanonicalDigest::new(hasher.finalize().into())
}

fn protocol_digest(value: &Sha256Digest) -> Result<CanonicalDigest, RequiredProofError> {
    let bytes = value.as_str().as_bytes();
    let mut decoded = [0_u8; 32];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        decoded[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(CanonicalDigest::new(decoded))
}

fn hex_nibble(value: u8) -> Result<u8, RequiredProofError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(RequiredProofError::Invalid("digest")),
    }
}

fn require_version(version: u16) -> Result<(), RequiredProofError> {
    if version == REQUIRED_PROOF_VERSION_V1 {
        Ok(())
    } else {
        Err(RequiredProofError::UnknownVersion)
    }
}

fn bounded_nonempty(
    value: &str,
    maximum: usize,
    field: &'static str,
) -> Result<(), RequiredProofError> {
    if value.is_empty() {
        return Err(RequiredProofError::Empty(field));
    }
    if value.len() > maximum {
        return Err(RequiredProofError::Oversized(field));
    }
    if value.contains('\0') || value.chars().any(|character| character.is_control()) {
        return Err(RequiredProofError::Invalid(field));
    }
    Ok(())
}

fn validate_cwd(cwd: &str) -> Result<(), RequiredProofError> {
    bounded_nonempty(cwd, MAX_CWD_BYTES, "cwd")?;
    if cwd == "." {
        return Ok(());
    }
    if cwd.starts_with('/')
        || cwd.ends_with('/')
        || cwd.contains('\\')
        || cwd
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(RequiredProofError::Invalid("cwd"));
    }
    Ok(())
}

fn validate_env_name(name: &str) -> Result<(), RequiredProofError> {
    bounded_nonempty(name, MAX_ENVIRONMENT_NAME_BYTES, "environment name")?;
    let mut characters = name.bytes();
    let first = characters
        .next()
        .ok_or(RequiredProofError::Empty("environment name"))?;
    if !(first.is_ascii_alphabetic() || first == b'_')
        || !characters.all(|value| value.is_ascii_alphanumeric() || value == b'_')
    {
        return Err(RequiredProofError::Invalid("environment name"));
    }
    Ok(())
}

fn validate_explicit_environment(name: &str, value: &str) -> Result<(), RequiredProofError> {
    let allowed = match name {
        "CARGO_TERM_COLOR" => matches!(value, "auto" | "always" | "never"),
        "CLICOLOR" | "CLICOLOR_FORCE" => matches!(value, "0" | "1"),
        "NO_COLOR" => matches!(value, "" | "1"),
        "RUST_BACKTRACE" => matches!(value, "0" | "1" | "full"),
        "LANG" | "LC_ALL" => matches!(value, "C" | "C.UTF-8" | "en_US.UTF-8"),
        "TERM" => matches!(value, "dumb" | "xterm" | "xterm-256color"),
        "TZ" => value == "UTC",
        _ => return Err(RequiredProofError::Invalid("explicit environment")),
    };
    if !allowed {
        return Err(RequiredProofError::Invalid("explicit environment value"));
    }
    Ok(())
}

fn validate_repository(repository: &str) -> Result<(), RequiredProofError> {
    bounded_nonempty(repository, MAX_REPOSITORY_BYTES, "repository")?;
    let mut components = repository.split('/');
    let valid_component = |component: &str| {
        !component.is_empty()
            && component != "."
            && component != ".."
            && component
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'))
    };
    let owner = components.next().unwrap_or_default();
    let name = components.next().unwrap_or_default();
    if !valid_component(owner) || !valid_component(name) || components.next().is_some() {
        return Err(RequiredProofError::Invalid("repository"));
    }
    Ok(())
}

fn validate_revision(revision: &str) -> Result<(), RequiredProofError> {
    if !matches!(revision.len(), 40 | 64)
        || !revision
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        return Err(RequiredProofError::Invalid("revision"));
    }
    Ok(())
}

fn binding(matches: bool, field: &'static str) -> Result<(), RequiredProofError> {
    if matches {
        Ok(())
    } else {
        Err(RequiredProofError::BindingMismatch(field))
    }
}
