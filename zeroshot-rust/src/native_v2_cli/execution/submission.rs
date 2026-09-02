use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io::Write;
use std::path::Path;

use openengine_cluster_protocol::{
    ClaudeProvider, CodexProvider, DeclaredConnections, DeclaredEnvironment,
    EnvironmentVariableName, GraphProfile, GraphSpec, IdempotencyKey, ModelId, NodeName,
    NodeRuntimeBinding, ReasoningEffort, RunConnectionValues, RunSize, RunSubmitResult,
    RuntimePlan, SessionScope, StaticConnectionValues,
};
use serde::Deserialize;

use super::super::{
    BuiltinGraphTemplate, CliOutcome, NativeV2CliBackend, NativeV2CliCommand, NativeV2CliError,
    PreparedRunRequest, RunCommand, RunGraph, RunRuntime, TargetRunIntent, TemplateDelivery,
};
use super::{CliExecutionContext, write_json};
use crate::native_v2_admission::{DeliveryPolicy, NativeV2Admission, executable_runtime_roles};
use crate::native_v2_delivery::GITHUB_TOKEN_ENV;

/// Executes commands that need no target registry, credentials, or controller state.
pub async fn try_execute_native_v2_preflight(
    command: &NativeV2CliCommand,
    output: &mut impl Write,
) -> Result<Option<CliOutcome>, NativeV2CliError> {
    let environment = |name: &str| std::env::var_os(name);
    try_execute_native_v2_preflight_with_environment(command, output, &environment).await
}

pub(crate) async fn try_execute_native_v2_preflight_with_environment<F>(
    command: &NativeV2CliCommand,
    output: &mut impl Write,
    environment: F,
) -> Result<Option<CliOutcome>, NativeV2CliError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let NativeV2CliCommand::Run(run) = command else {
        return Ok(None);
    };
    if !run.validate_only {
        return Ok(None);
    }
    prepare_validated_submission_with_environment(run, environment).await?;
    write_json(output, &serde_json::json!({ "valid": true }))?;
    Ok(Some(CliOutcome::Completed))
}

pub fn try_execute_native_v2_static(
    command: &NativeV2CliCommand,
    output: &mut impl Write,
) -> Result<Option<CliOutcome>, NativeV2CliError> {
    if let Some(text) = command.product_info() {
        output.write_all(text.as_bytes())?;
        output.flush()?;
        return Ok(Some(CliOutcome::Completed));
    }
    let outcome = match command {
        NativeV2CliCommand::TemplateList => execute_template_list(output)?,
        NativeV2CliCommand::TemplateShow { template, delivery } => {
            execute_template_show(*template, *delivery, output)?
        }
        _ => return Ok(None),
    };
    Ok(Some(outcome))
}

fn execute_template_list(output: &mut impl Write) -> Result<CliOutcome, NativeV2CliError> {
    let names = BuiltinGraphTemplate::all()
        .iter()
        .map(|template| template.name())
        .collect::<Vec<_>>();
    write_json(output, &names)?;
    Ok(CliOutcome::Completed)
}

fn execute_template_show(
    template: BuiltinGraphTemplate,
    delivery: TemplateDelivery,
    output: &mut impl Write,
) -> Result<CliOutcome, NativeV2CliError> {
    let graph = template
        .materialize(delivery)
        .map_err(|error| NativeV2CliError::Usage(error.to_string()))?;
    write_json(output, &graph)?;
    Ok(CliOutcome::Completed)
}

pub(super) fn prepare_submission_with_environment<F>(
    run: &RunCommand,
    available: F,
) -> Result<PreparedRunRequest, NativeV2CliError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let intent = prepare_intent(run)?;
    let connections = select_connections(&intent.runtime, &available)?;
    let github_token = run
        .target
        .as_ref()
        .and_then(|_| available("GH_TOKEN"))
        .map(|value| {
            value
                .into_string()
                .map_err(|_| NativeV2CliError::GitHubToken)
        })
        .transpose()?
        .map(validate_github_token)
        .transpose()?;
    Ok(PreparedRunRequest {
        run_id: openengine_cluster_protocol::RunId::new(uuid::Uuid::now_v7().to_string()),
        intent,
        connections,
        github_token,
    })
}

pub(super) async fn prepare_validated_submission_with_environment<F>(
    run: &RunCommand,
    available: F,
) -> Result<PreparedRunRequest, NativeV2CliError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let params = prepare_submission_with_environment(run, available)?;
    NativeV2Admission
        .validate_intent(&params.intent, DeliveryPolicy::Optional)
        .await
        .map_err(NativeV2CliError::InvalidRun)?;
    Ok(params)
}

pub(super) async fn submit_run<B>(
    run: &RunCommand,
    context: &CliExecutionContext<'_, B>,
) -> Result<Option<RunSubmitResult>, NativeV2CliError>
where
    B: NativeV2CliBackend,
{
    let params = prepare_validated_submission_with_environment(run, context.environment).await?;
    if run.validate_only {
        return Ok(None);
    }
    context
        .backend
        .run_submit(run.target.as_deref(), params)
        .await
        .map(Some)
}

fn validate_github_token(value: String) -> Result<String, NativeV2CliError> {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') {
        Err(NativeV2CliError::GitHubToken)
    } else {
        Ok(value)
    }
}

fn prepare_intent(run: &RunCommand) -> Result<TargetRunIntent, NativeV2CliError> {
    let graph = materialize_graph(&run.graph)?;
    validate_graph_profile(&graph)?;
    let initial_input = read_json::<serde_json::Value>("input", &run.input)?;
    let initial_input = materialize_initial_input(&run.graph, initial_input)?;
    let runtime = materialize_runtime(&run.graph, &graph, &run.runtime)?;
    graph
        .initial_input
        .validate_value(&initial_input)
        .map_err(|error| NativeV2CliError::InitialInput(error.to_string()))?;
    let submission_key = run
        .submission_key
        .clone()
        .map_or_else(fresh_submission_key, Ok)?;
    Ok(TargetRunIntent {
        title: run.title.clone(),
        graph,
        initial_input,
        runtime,
        branch: run.branch.clone(),
        submission_key,
    })
}

fn select_connections<F>(
    runtime: &RuntimePlan,
    available: F,
) -> Result<RunConnectionValues, NativeV2CliError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut selected = BTreeMap::new();
    for (key, fields) in runtime.connection_requirements() {
        let mut values = BTreeMap::new();
        for name in fields {
            let Some(value) = available(name.as_str()) else {
                continue;
            };
            let value = value
                .into_string()
                .map_err(|_| NativeV2CliError::Environment(name.clone()))?;
            values.insert(name, value);
        }
        if !values.is_empty() {
            selected.insert(
                key,
                StaticConnectionValues::new(values)
                    .map_err(|error| NativeV2CliError::Usage(error.to_string()))?,
            );
        }
    }
    Ok(selected)
}

fn materialize_initial_input(
    selection: &RunGraph,
    input: serde_json::Value,
) -> Result<serde_json::Value, NativeV2CliError> {
    match selection {
        RunGraph::File(_) => Ok(input),
        RunGraph::Template { template, .. } => template
            .materialize_input(input)
            .map_err(|error| NativeV2CliError::InitialInput(error.to_string())),
    }
}

fn materialize_graph(selection: &RunGraph) -> Result<GraphSpec, NativeV2CliError> {
    match selection {
        RunGraph::File(path) => read_json("graph", path),
        RunGraph::Template { template, delivery } => {
            template.materialize(*delivery).map_err(template_error)
        }
    }
}

fn materialize_runtime(
    selection: &RunGraph,
    graph: &GraphSpec,
    source: &RunRuntime,
) -> Result<RuntimePlan, NativeV2CliError> {
    let path = match source {
        RunRuntime::Exact(path) => path,
        RunRuntime::Uniform(path) => {
            let uniform = read_json::<UniformRuntimePlan>("uniform runtime config", path)?;
            return uniform.materialize(graph);
        }
    };
    let mut runtime = read_json::<RuntimePlan>("runtime config", path)?;
    let RunGraph::Template { template, delivery } = selection else {
        return Ok(runtime);
    };
    let Some((name, binding)) = template
        .delivery_runtime_binding(*delivery)
        .map_err(template_error)?
    else {
        return Ok(runtime);
    };
    insert_template_binding(&mut runtime, name, binding)?;
    Ok(runtime)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum UniformHarness {
    Codex,
    Claude,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum UniformProvider {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "openrouter")]
    OpenRouter,
    Anthropic,
}

const KNOWN_INCOMPATIBLE_HARNESS_PROVIDER_PAIRS: &[(UniformHarness, UniformProvider)] = &[
    (UniformHarness::Codex, UniformProvider::Anthropic),
    (UniformHarness::Claude, UniformProvider::OpenAi),
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UniformRuntimePlan {
    harness: UniformHarness,
    provider: UniformProvider,
    #[serde(default = "medium_size")]
    size: RunSize,
    model: ModelId,
    #[serde(default)]
    effort: Option<ReasoningEffort>,
    #[serde(default)]
    session_scope: SessionScope,
    #[serde(default)]
    connections: Option<DeclaredConnections>,
}

const fn medium_size() -> RunSize {
    RunSize::Medium
}

impl UniformRuntimePlan {
    fn materialize(self, graph: &GraphSpec) -> Result<RuntimePlan, NativeV2CliError> {
        let harness = self.harness;
        let connections = self
            .connections
            .clone()
            .map_or_else(|| default_uniform_connections(self.provider), Ok)?;
        let mut nodes = BTreeMap::new();
        for (name, delivery) in executable_runtime_roles(&graph.root) {
            nodes.insert(name, self.binding(delivery, &connections)?);
        }
        self.into_runtime_plan(harness, nodes)
    }

    fn binding(
        &self,
        delivery: bool,
        connections: &DeclaredConnections,
    ) -> Result<NodeRuntimeBinding, NativeV2CliError> {
        if delivery {
            return git_delivery_binding();
        }
        Ok(NodeRuntimeBinding::Agent {
            model: self.model.clone(),
            effort: self.effort,
            session_scope: self.session_scope,
            connections: connections.clone(),
        })
    }

    fn into_runtime_plan(
        self,
        harness: UniformHarness,
        nodes: BTreeMap<NodeName, NodeRuntimeBinding>,
    ) -> Result<RuntimePlan, NativeV2CliError> {
        if KNOWN_INCOMPATIBLE_HARNESS_PROVIDER_PAIRS.contains(&(harness, self.provider)) {
            return Err(NativeV2CliError::Usage(format!(
                "provider {:?} is incompatible with harness {:?}",
                self.provider, harness
            )));
        }
        match (harness, self.provider) {
            (UniformHarness::Codex, UniformProvider::OpenAi) => Ok(RuntimePlan::Codex {
                provider: CodexProvider::OpenAi,
                size: self.size,
                nodes,
            }),
            (UniformHarness::Codex, UniformProvider::OpenRouter) => Ok(RuntimePlan::Codex {
                provider: CodexProvider::OpenRouter,
                size: self.size,
                nodes,
            }),
            (UniformHarness::Claude, UniformProvider::Anthropic) => Ok(RuntimePlan::Claude {
                provider: ClaudeProvider::Anthropic,
                size: self.size,
                nodes,
            }),
            (UniformHarness::Claude, UniformProvider::OpenRouter) => Ok(RuntimePlan::Claude {
                provider: ClaudeProvider::OpenRouter,
                size: self.size,
                nodes,
            }),
            _ => Err(NativeV2CliError::Usage(
                "unsupported harness/provider pair".to_owned(),
            )),
        }
    }
}

fn default_uniform_connections(
    provider: UniformProvider,
) -> Result<DeclaredConnections, NativeV2CliError> {
    let (key, name) = match provider {
        UniformProvider::OpenAi => ("openai", "OPENAI_API_KEY"),
        UniformProvider::OpenRouter => ("openrouter", "OPENROUTER_API_KEY"),
        UniformProvider::Anthropic => ("anthropic", "ANTHROPIC_API_KEY"),
    };
    single_connection(key, name)
}

fn git_delivery_binding() -> Result<NodeRuntimeBinding, NativeV2CliError> {
    let connections = single_connection(
        crate::native_v2_contract::GITHUB_CONNECTION_KEY,
        GITHUB_TOKEN_ENV,
    )?;
    Ok(NodeRuntimeBinding::GitDelivery { connections })
}

fn single_connection(key: &str, name: &str) -> Result<DeclaredConnections, NativeV2CliError> {
    let name = EnvironmentVariableName::new(name)
        .map_err(|error| NativeV2CliError::Usage(error.to_string()))?;
    let environment = DeclaredEnvironment::new([name])
        .map_err(|error| NativeV2CliError::Usage(error.to_string()))?;
    DeclaredConnections::single(key, environment)
        .map_err(|error| NativeV2CliError::Usage(error.to_string()))
}

fn insert_template_binding(
    runtime: &mut RuntimePlan,
    name: openengine_cluster_protocol::NodeName,
    binding: NodeRuntimeBinding,
) -> Result<(), NativeV2CliError> {
    let nodes = match runtime {
        RuntimePlan::Codex { nodes, .. } | RuntimePlan::Claude { nodes, .. } => nodes,
    };
    if nodes.contains_key(&name) {
        return Err(NativeV2CliError::Usage(format!(
            "runtime config must not bind template-owned node {:?}",
            name.as_str()
        )));
    }
    nodes.insert(name, binding);
    Ok(())
}

fn template_error(error: impl std::fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Usage(error.to_string())
}

fn validate_graph_profile(graph: &GraphSpec) -> Result<(), NativeV2CliError> {
    if graph.profile == GraphProfile::Full {
        return Ok(());
    }
    Err(NativeV2CliError::Usage(
        "native-v2 requires graph profile openengine.graph.full/v1".to_owned(),
    ))
}

fn read_json<T>(kind: &'static str, path: &Path) -> Result<T, NativeV2CliError>
where
    T: serde::de::DeserializeOwned,
{
    let bytes = std::fs::read(path).map_err(|source| NativeV2CliError::Read {
        kind,
        path: path.to_owned(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|source| NativeV2CliError::Json {
        kind,
        path: path.to_owned(),
        source,
    })
}

fn fresh_submission_key() -> Result<IdempotencyKey, NativeV2CliError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| NativeV2CliError::Randomness)?;
    let mut key = String::from("cli-");
    for byte in random {
        use fmt::Write as _;
        let _ = write!(&mut key, "{byte:02x}");
    }
    IdempotencyKey::new(key).map_err(|error| NativeV2CliError::Usage(error.to_owned()))
}
