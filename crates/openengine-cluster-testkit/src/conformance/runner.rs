//! Portable conformance execution and response validation.

use std::error::Error;
use std::fmt;
use std::sync::Arc;

use openengine_cluster_protocol::{
    AgentAttachParams, ExecutionRef, GetResult, InitializeResult, LogsParams, WatchParams,
    NOT_FOUND,
};
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use openengine_cluster_server::{ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::Value;

use super::catalog::{
    BackendFactory, BackendRegistration, CaseDefinition, ConformanceRequirement, Expected,
    OptionalCapability, RegisteredOptionalCapabilities, CATALOG,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaseDisposition {
    Passed,
    Skipped(OptionalCapability),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CaseResult {
    id: &'static str,
    disposition: CaseDisposition,
}

impl CaseResult {
    #[must_use]
    pub const fn id(&self) -> &'static str {
        self.id
    }

    #[must_use]
    pub const fn disposition(&self) -> CaseDisposition {
        self.disposition
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConformanceReport {
    cases: Vec<CaseResult>,
}

impl ConformanceReport {
    #[must_use]
    pub fn cases(&self) -> &[CaseResult] {
        &self.cases
    }

    #[must_use]
    pub fn passed(&self) -> usize {
        count_passed(&self.cases)
    }

    #[must_use]
    pub fn skipped(&self) -> usize {
        count_skipped(&self.cases)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CaseFailure {
    id: &'static str,
    message: String,
}

impl CaseFailure {
    #[must_use]
    pub const fn id(&self) -> &'static str {
        self.id
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConformanceFailures {
    cases: Vec<CaseResult>,
    failures: Vec<CaseFailure>,
}

impl ConformanceFailures {
    #[must_use]
    pub fn cases(&self) -> &[CaseResult] {
        &self.cases
    }

    #[must_use]
    pub fn failures(&self) -> &[CaseFailure] {
        &self.failures
    }

    #[must_use]
    pub fn passed(&self) -> usize {
        count_passed(&self.cases)
    }

    #[must_use]
    pub fn skipped(&self) -> usize {
        count_skipped(&self.cases)
    }
}

impl fmt::Display for ConformanceFailures {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            formatter,
            "{} portable backend conformance case(s) failed",
            self.failures.len()
        )?;
        for failure in &self.failures {
            writeln!(formatter, "{}: {}", failure.id, failure.message)?;
        }
        Ok(())
    }
}

impl Error for ConformanceFailures {}

fn count_passed(cases: &[CaseResult]) -> usize {
    cases
        .iter()
        .filter(|case| case.disposition == CaseDisposition::Passed)
        .count()
}

fn count_skipped(cases: &[CaseResult]) -> usize {
    cases.len() - count_passed(cases)
}

pub async fn run_backend_conformance<F>(
    factory: &F,
) -> Result<ConformanceReport, ConformanceFailures>
where
    F: BackendFactory,
{
    let registration = factory.registration();
    let mut results = Vec::with_capacity(CATALOG.len());
    let mut failures = Vec::new();

    for (ordinal, case) in CATALOG.iter().enumerate() {
        if let Some(capability) = skipped(case.requirement, registration.optional) {
            results.push(CaseResult {
                id: case.id,
                disposition: CaseDisposition::Skipped(capability),
            });
            continue;
        }
        match run_case(factory, registration, case, ordinal).await {
            Ok(()) => results.push(CaseResult {
                id: case.id,
                disposition: CaseDisposition::Passed,
            }),
            Err(message) => failures.push(CaseFailure {
                id: case.id,
                message,
            }),
        }
    }

    if failures.is_empty() {
        Ok(ConformanceReport { cases: results })
    } else {
        Err(ConformanceFailures {
            cases: results,
            failures,
        })
    }
}

fn skipped(
    requirement: ConformanceRequirement,
    optional: RegisteredOptionalCapabilities,
) -> Option<OptionalCapability> {
    match requirement {
        ConformanceRequirement::Required => None,
        ConformanceRequirement::Optional(OptionalCapability::Logs) if !optional.logs => {
            Some(OptionalCapability::Logs)
        }
        ConformanceRequirement::Optional(OptionalCapability::AgentAttach)
            if !optional.agent_attach =>
        {
            Some(OptionalCapability::AgentAttach)
        }
        ConformanceRequirement::Optional(_) => None,
    }
}

async fn run_case<F>(
    factory: &F,
    registration: BackendRegistration<'_>,
    case: &CaseDefinition,
    ordinal: usize,
) -> Result<(), String>
where
    F: BackendFactory,
{
    let backend = factory
        .create()
        .await
        .map_err(|error| format!("create failed: {error}"))?;
    let backend = Arc::new(backend);
    let context = ConnectionContext::new(
        ConnectionIdentity::new(ConnectionIdentityConfig {
            principal: PrincipalId::new(format!("portable-conformance:{ordinal}")),
            tenant: TenantId::new(format!("portable-conformance:{ordinal}")),
            issued_at_ms: None,
            expires_at_ms: u64::MAX,
            binding_attributes: BindingAttributes::default(),
        }),
        Default::default(),
    );
    let dispatcher = Dispatcher::from_shared(Arc::clone(&backend), context);
    let exercise = exercise(&dispatcher, registration, case).await;
    drop(dispatcher);
    let reset = factory
        .reset(backend.as_ref())
        .await
        .map_err(|error| format!("reset failed: {error}"));

    let mut errors = Vec::new();
    if let Err(message) = exercise {
        errors.push(message);
    }
    if let Err(message) = reset {
        errors.push(message);
    }
    match Arc::try_unwrap(backend) {
        Ok(backend) => {
            if let Err(error) = factory.cleanup(backend).await {
                errors.push(format!("cleanup failed: {error}"));
            }
        }
        Err(backend) => {
            errors.push(format!(
                "runner retained {} backend references; cleanup was impossible",
                Arc::strong_count(&backend)
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

async fn exercise<B>(
    dispatcher: &Dispatcher<B>,
    registration: BackendRegistration<'_>,
    case: &CaseDefinition,
) -> Result<(), String>
where
    B: ClusterBackend,
{
    match case.expected {
        Expected::WatchEstablished => exercise_watch(dispatcher).await,
        Expected::LogsEstablished => exercise_logs(dispatcher).await,
        Expected::AgentAttachNotFound => exercise_agent_attach(dispatcher).await,
        expected => exercise_dispatch(dispatcher, registration, case.input, expected).await,
    }
}

async fn exercise_watch<B: ClusterBackend>(dispatcher: &Dispatcher<B>) -> Result<(), String> {
    let (_result, stream, handle) = dispatcher
        .watch(WatchParams::default())
        .await
        .map_err(|error| format!("watch establishment failed: {error}"))?;
    drop(handle);
    drop(stream);
    Ok(())
}

async fn exercise_logs<B: ClusterBackend>(dispatcher: &Dispatcher<B>) -> Result<(), String> {
    let (_result, stream, handle) = dispatcher
        .logs(LogsParams::default())
        .await
        .map_err(|error| format!("advertised logs failed: {error}"))?;
    drop(handle);
    drop(stream);
    Ok(())
}

async fn exercise_agent_attach<B: ClusterBackend>(
    dispatcher: &Dispatcher<B>,
) -> Result<(), String> {
    let execution = ExecutionRef::new("portable-conformance-unknown")
        .map_err(|error| format!("invalid catalog execution ref: {error}"))?;
    match dispatcher
        .agent_attach(AgentAttachParams { execution })
        .await
    {
        Err(error) if error.code == NOT_FOUND => Ok(()),
        Err(error) => Err(format!(
            "agent attach returned {}, expected {NOT_FOUND}",
            error.code
        )),
        Ok((_result, stream, handle)) => {
            drop(handle);
            drop(stream);
            Err("unknown execution unexpectedly attached".to_owned())
        }
    }
}

async fn exercise_dispatch<B: ClusterBackend>(
    dispatcher: &Dispatcher<B>,
    registration: BackendRegistration<'_>,
    input: &str,
    expected: Expected,
) -> Result<(), String> {
    let raw = dispatcher.dispatch(input).await;
    let response: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid JSON-RPC response: {error}"))?;
    validate_response(expected, &response, registration)
}

fn validate_response(
    expected: Expected,
    response: &Value,
    registration: BackendRegistration<'_>,
) -> Result<(), String> {
    if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("response jsonrpc was not 2.0".to_owned());
    }
    match expected {
        Expected::Initialize => validate_initialize(response, registration),
        Expected::EmptyGet => validate_empty_get(response),
        Expected::Error { code, domain, id } => validate_error_response(response, code, domain, id),
        Expected::WatchEstablished | Expected::LogsEstablished | Expected::AgentAttachNotFound => {
            Err("direct expectation reached JSON-RPC validator".to_owned())
        }
    }
}

fn validate_initialize(
    response: &Value,
    registration: BackendRegistration<'_>,
) -> Result<(), String> {
    let result = response
        .get("result")
        .cloned()
        .ok_or_else(|| format!("initialize failed: {response}"))?;
    let initialized: InitializeResult = serde_json::from_value(result)
        .map_err(|error| format!("invalid initialize result: {error}"))?;
    let advertised_profiles = initialized.capabilities.graph_profiles.values();
    let registered_profiles = registration.graph_profiles;
    if advertised_profiles.len() != registered_profiles.len()
        || !advertised_profiles
            .iter()
            .all(|profile| registered_profiles.contains(profile))
        || !registered_profiles
            .iter()
            .all(|profile| advertised_profiles.contains(profile))
    {
        return Err(format!(
            "advertised graph profiles {advertised_profiles:?} did not match registration {registered_profiles:?}"
        ));
    }
    if initialized.capabilities.logs != registration.optional.logs
        || initialized.capabilities.agent_attach != registration.optional.agent_attach
    {
        return Err(
            "advertised optional capabilities did not match factory registration".to_owned(),
        );
    }
    Ok(())
}

fn validate_empty_get(response: &Value) -> Result<(), String> {
    let result = response
        .get("result")
        .cloned()
        .ok_or_else(|| format!("get failed: {response}"))?;
    let get: GetResult =
        serde_json::from_value(result).map_err(|error| format!("invalid get result: {error}"))?;
    if get != GetResult::empty() {
        return Err(format!("fresh get was not canonical empty: {get:?}"));
    }
    Ok(())
}

fn validate_error_response(
    response: &Value,
    code: i64,
    domain: Option<&str>,
    id: Option<i64>,
) -> Result<(), String> {
    if response.pointer("/error/code").and_then(Value::as_i64) != Some(code) {
        return Err(format!("expected error code {code}, received {response}"));
    }
    let expected_id = id.map_or(Value::Null, Value::from);
    if response.get("id") != Some(&expected_id) {
        return Err(format!(
            "expected response id {expected_id}, received {response}"
        ));
    }
    if domain.is_some_and(|domain| {
        response.pointer("/error/data/code").and_then(Value::as_str) != Some(domain)
    }) {
        return Err(format!(
            "expected domain code {}, received {response}",
            domain.unwrap_or_default()
        ));
    }
    Ok(())
}
