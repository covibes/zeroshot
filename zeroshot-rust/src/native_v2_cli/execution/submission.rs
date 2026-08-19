use std::fmt;
use std::path::Path;

use openengine_cluster_protocol::{
    GraphProfile, GraphSpec, IdempotencyKey, NodeRuntimeBinding, RuntimePlan,
};

use super::super::{NativeV2CliError, RunCommand, RunGraph, TargetRunIntent};

pub(super) fn prepare_submission(run: &RunCommand) -> Result<TargetRunIntent, NativeV2CliError> {
    let graph = materialize_graph(&run.graph)?;
    validate_graph_profile(&graph)?;
    let initial_input = read_json::<serde_json::Value>("input", &run.input)?;
    let initial_input = materialize_initial_input(&run.graph, initial_input)?;
    let mut runtime = read_json::<RuntimePlan>("runtime config", &run.runtime_config)?;
    materialize_runtime(&run.graph, &mut runtime)?;
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
        submission_key,
    })
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
    runtime: &mut RuntimePlan,
) -> Result<(), NativeV2CliError> {
    let RunGraph::Template { template, delivery } = selection else {
        return Ok(());
    };
    let Some((name, binding)) = template
        .delivery_runtime_binding(*delivery)
        .map_err(template_error)?
    else {
        return Ok(());
    };
    insert_template_binding(runtime, name, binding)
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
