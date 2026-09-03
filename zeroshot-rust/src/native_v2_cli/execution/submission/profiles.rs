use openengine_cluster_protocol::{
    GraphSpec, RunProfile, RunProfileListRequest, RunProfileScope, RunProfileSelector, RuntimePlan,
};

use super::{materialize_graph, materialize_runtime, validate_graph_profile};
use crate::native_v2_admission::{DeliveryPolicy, NativeV2Admission};
use crate::native_v2_cli::{
    LocalRunProfileStore, NativeV2CliBackend, NativeV2CliError, ProfileQualifier, ProfileReference,
    RunCommand, RunGraph, RunRuntime, RunSelection,
};

pub(super) struct ResolvedRunProfile {
    pub(super) graph: GraphSpec,
    pub(super) runtime: RuntimePlan,
    pub(super) remote_selector: Option<RunProfileSelector>,
}

pub(super) async fn resolve_run_profile<B>(
    run: &RunCommand,
    backend: &B,
) -> Result<ResolvedRunProfile, NativeV2CliError>
where
    B: NativeV2CliBackend,
{
    match &run.selection {
        RunSelection::Inline { graph, runtime } => {
            let (graph, runtime) = materialize_profile(graph, runtime).await?;
            Ok(ResolvedRunProfile {
                graph,
                runtime,
                remote_selector: None,
            })
        }
        RunSelection::Profile(reference) => {
            resolve_stored_profile(run.target.as_deref(), reference.as_ref(), backend).await
        }
    }
}

async fn resolve_stored_profile<B>(
    target: Option<&str>,
    reference: Option<&ProfileReference>,
    backend: &B,
) -> Result<ResolvedRunProfile, NativeV2CliError>
where
    B: NativeV2CliBackend,
{
    let local = LocalRunProfileStore::production()?;
    for scope in profile_scopes(reference, target)? {
        let list = profile_list(scope, target, backend, &local).await?;
        let Some(selected) = select_profile(list, reference) else {
            continue;
        };
        let selector = RunProfileSelector {
            scope: selected.scope,
            name: selected.name,
        };
        let profile = match scope {
            None => local.show(selector.clone())?,
            Some(_) => backend.profile_show(target, selector.clone()).await?,
        };
        return Ok(from_profile(profile, scope.map(|_| selector)));
    }
    Err(profile_not_found(reference))
}

fn profile_scopes(
    reference: Option<&ProfileReference>,
    target: Option<&str>,
) -> Result<Vec<Option<RunProfileScope>>, NativeV2CliError> {
    let scopes = match reference.and_then(|value| value.qualifier) {
        Some(ProfileQualifier::Local) => vec![None],
        Some(ProfileQualifier::User) => vec![Some(RunProfileScope::User)],
        Some(ProfileQualifier::Org) => vec![Some(RunProfileScope::Org)],
        None => default_scopes(target),
    };
    if scopes.iter().any(Option::is_some) && target.is_none() {
        return Err(NativeV2CliError::Usage(
            "remote profile selectors require --target".to_owned(),
        ));
    }
    Ok(scopes)
}

fn default_scopes(target: Option<&str>) -> Vec<Option<RunProfileScope>> {
    let mut scopes = vec![None];
    if target.is_some() {
        scopes.extend([Some(RunProfileScope::User), Some(RunProfileScope::Org)]);
    }
    scopes
}

async fn profile_list<B: NativeV2CliBackend>(
    scope: Option<RunProfileScope>,
    target: Option<&str>,
    backend: &B,
    local: &LocalRunProfileStore,
) -> Result<openengine_cluster_protocol::RunProfileListResult, NativeV2CliError> {
    match scope {
        None => local.list(RunProfileListRequest {
            scope: RunProfileScope::User,
        }),
        Some(scope) => {
            backend
                .profile_list(target, RunProfileListRequest { scope })
                .await
        }
    }
}

fn select_profile(
    list: openengine_cluster_protocol::RunProfileListResult,
    reference: Option<&ProfileReference>,
) -> Option<openengine_cluster_protocol::RunProfileSummary> {
    match reference {
        Some(reference) => list
            .profiles
            .into_iter()
            .find(|profile| profile.name == reference.name),
        None => list.profiles.into_iter().find(|profile| profile.is_default),
    }
}

fn profile_not_found(reference: Option<&ProfileReference>) -> NativeV2CliError {
    NativeV2CliError::Usage(match reference {
        Some(reference) => format!("profile {} was not found", reference.name),
        None => "no default run profile is configured".to_owned(),
    })
}

fn from_profile(
    profile: RunProfile,
    remote_selector: Option<RunProfileSelector>,
) -> ResolvedRunProfile {
    ResolvedRunProfile {
        graph: profile.graph,
        runtime: profile.runtime,
        remote_selector,
    }
}

pub(in crate::native_v2_cli::execution) async fn materialize_profile(
    selection: &RunGraph,
    runtime_source: &RunRuntime,
) -> Result<(GraphSpec, RuntimePlan), NativeV2CliError> {
    let graph = materialize_graph(selection)?;
    validate_graph_profile(&graph)?;
    let runtime = materialize_runtime(selection, &graph, runtime_source)?;
    NativeV2Admission
        .validate_profile(&graph, &runtime, DeliveryPolicy::Optional)
        .await
        .map_err(NativeV2CliError::InvalidRun)?;
    Ok((graph, runtime))
}
