use openengine_cluster_protocol::{RunProfileName, RunProfileScope};

use super::super::{ProfileCommand, ProfileScopeArg};
use super::super::profiles::{ProfileDefaultArgs, ProfileRouteArgs, ProfileSetArgs};
use crate::native_v2_cli::{NativeV2CliCommand, NativeV2CliError, ProfileRoute, ProfileSetCommand};

impl ProfileCommand {
    pub(super) fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        match self {
            Self::List(args) => list_command(args),
            Self::Set(args) => set_command(args),
            Self::Show(args) => named_command(args, false),
            Self::Remove(args) => named_command(args, true),
            Self::Default(args) => default_command(args),
        }
    }
}

fn list_command(args: ProfileRouteArgs) -> Result<NativeV2CliCommand, NativeV2CliError> {
    Ok(NativeV2CliCommand::ProfileList(profile_route(
        args.target,
        args.scope,
    )?))
}

fn set_command(args: ProfileSetArgs) -> Result<NativeV2CliCommand, NativeV2CliError> {
    Ok(NativeV2CliCommand::ProfileSet(ProfileSetCommand {
        route: profile_route(args.route.target, args.route.scope)?,
        name: profile_name(args.name)?,
        graph: super::run_graph(args.graph, args.template, args.delivery.selection())?,
        runtime: super::run_runtime(args.runtime_config, args.uniform_runtime_config)?,
        set_default: args.default,
    }))
}

fn default_command(args: ProfileDefaultArgs) -> Result<NativeV2CliCommand, NativeV2CliError> {
    Ok(NativeV2CliCommand::ProfileDefault {
        route: profile_route(args.route.target, args.route.scope)?,
        name: args.name.map(profile_name).transpose()?,
    })
}

fn named_command(
    args: super::super::ProfileNameArgs,
    remove: bool,
) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let route = profile_route(args.route.target, args.route.scope)?;
    let name = profile_name(args.name)?;
    Ok(if remove {
        NativeV2CliCommand::ProfileRemove { route, name }
    } else {
        NativeV2CliCommand::ProfileShow { route, name }
    })
}

pub(super) fn profile_route(
    target: Option<String>,
    scope: ProfileScopeArg,
) -> Result<ProfileRoute, NativeV2CliError> {
    let target = super::validated_target(target)?;
    let scope = match scope {
        ProfileScopeArg::User => RunProfileScope::User,
        ProfileScopeArg::Org => RunProfileScope::Org,
    };
    if target.is_none() && scope == RunProfileScope::Org {
        return Err(super::usage("organization profiles require --target"));
    }
    Ok(ProfileRoute { target, scope })
}

pub(super) fn profile_name(value: String) -> Result<RunProfileName, NativeV2CliError> {
    RunProfileName::new(value)
        .map_err(|error| super::usage(format!("invalid profile name: {error}")))
}
