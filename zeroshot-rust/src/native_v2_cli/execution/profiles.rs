use std::io::Write;

use openengine_cluster_protocol::{
    RunProfileDefaultRequest, RunProfileListRequest, RunProfileSelector, RunProfileSetRequest,
};

use super::super::{
    CliOutcome, NativeV2CliBackend, NativeV2CliCommand, NativeV2CliError, ProfileSetCommand,
};
use super::submission::materialize_profile;
use super::write_json;

pub(super) async fn execute_profile<B, W>(
    command: NativeV2CliCommand,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    let result = match command {
        NativeV2CliCommand::ProfileList(route) => list(route, backend, output).await,
        NativeV2CliCommand::ProfileShow { route, name } => show(route, name, backend, output).await,
        NativeV2CliCommand::ProfileSet(command) => set(command, backend, output).await,
        NativeV2CliCommand::ProfileRemove { route, name } => {
            remove(route, name, backend, output).await
        }
        NativeV2CliCommand::ProfileDefault { route, name } => {
            set_default(route, name, backend, output).await
        }
        _ => {
            return Err(NativeV2CliError::Usage(
                "expected a profile operation".to_owned(),
            ));
        }
    };
    result.map(|()| CliOutcome::Completed)
}

async fn list<B: NativeV2CliBackend>(
    route: super::super::ProfileRoute,
    backend: &B,
    output: &mut impl Write,
) -> Result<(), NativeV2CliError> {
    let result = backend
        .profile_list(
            route.target.as_deref(),
            RunProfileListRequest { scope: route.scope },
        )
        .await?;
    write_json(output, &result)
}

async fn show<B: NativeV2CliBackend>(
    route: super::super::ProfileRoute,
    name: openengine_cluster_protocol::RunProfileName,
    backend: &B,
    output: &mut impl Write,
) -> Result<(), NativeV2CliError> {
    let target = route.target.as_deref();
    let request = selector(&route, name);
    let result = backend.profile_show(target, request).await?;
    write_json(output, &result)
}

async fn set<B: NativeV2CliBackend>(
    command: ProfileSetCommand,
    backend: &B,
    output: &mut impl Write,
) -> Result<(), NativeV2CliError> {
    let ProfileSetCommand {
        route,
        name,
        graph,
        runtime,
        set_default,
    } = command;
    let (graph, runtime) = materialize_profile(&graph, &runtime).await?;
    let result = backend
        .profile_set(
            route.target.as_deref(),
            RunProfileSetRequest {
                name,
                scope: route.scope,
                graph,
                runtime,
                set_default,
            },
        )
        .await?;
    write_json(output, &result)
}

async fn remove<B: NativeV2CliBackend>(
    route: super::super::ProfileRoute,
    name: openengine_cluster_protocol::RunProfileName,
    backend: &B,
    output: &mut impl Write,
) -> Result<(), NativeV2CliError> {
    let result = backend
        .profile_delete(route.target.as_deref(), selector(&route, name))
        .await?;
    write_json(output, &result)
}

fn selector(
    route: &super::super::ProfileRoute,
    name: openengine_cluster_protocol::RunProfileName,
) -> RunProfileSelector {
    RunProfileSelector {
        scope: route.scope,
        name,
    }
}

async fn set_default<B: NativeV2CliBackend>(
    route: super::super::ProfileRoute,
    name: Option<openengine_cluster_protocol::RunProfileName>,
    backend: &B,
    output: &mut impl Write,
) -> Result<(), NativeV2CliError> {
    let result = backend
        .profile_default(
            route.target.as_deref(),
            RunProfileDefaultRequest {
                scope: route.scope,
                name,
            },
        )
        .await?;
    write_json(output, &result)
}
