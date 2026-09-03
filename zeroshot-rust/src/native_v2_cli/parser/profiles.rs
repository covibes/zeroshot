use std::path::PathBuf;

use clap::{ArgGroup, Args, ValueEnum};

use super::{DeliveryArgs, TemplateName};

#[derive(Debug, clap::Subcommand)]
pub(super) enum ProfileCommand {
    /// List profile metadata.
    List(ProfileRouteArgs),
    /// Create or replace a fully materialized profile.
    Set(ProfileSetArgs),
    /// Show one profile with its graph and runtime.
    Show(ProfileNameArgs),
    /// Remove one profile.
    Remove(ProfileNameArgs),
    /// Set the scope's default profile, or clear it when NAME is omitted.
    Default(ProfileDefaultArgs),
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
pub(super) enum ProfileScopeArg {
    #[default]
    User,
    Org,
}

#[derive(Debug, Args)]
pub(super) struct ProfileRouteArgs {
    /// Use this named hosted target. If omitted, use local profiles.
    #[arg(long, value_name = "NAME")]
    pub(super) target: Option<String>,
    /// Select user- or organization-scoped hosted profiles.
    #[arg(long, value_enum, default_value_t)]
    pub(super) scope: ProfileScopeArg,
}

#[derive(Debug, Args)]
pub(super) struct ProfileNameArgs {
    /// Profile name.
    #[arg(value_name = "NAME")]
    pub(super) name: String,
    #[command(flatten)]
    pub(super) route: ProfileRouteArgs,
}

#[derive(Debug, Args)]
pub(super) struct ProfileDefaultArgs {
    /// Profile name. Omit to clear the selected scope's default.
    #[arg(value_name = "NAME")]
    pub(super) name: Option<String>,
    #[command(flatten)]
    pub(super) route: ProfileRouteArgs,
}

#[derive(Debug, Args)]
#[command(group = ArgGroup::new("profile_graph_source").args(["graph", "template"]).required(true).multiple(false))]
#[command(group = ArgGroup::new("profile_runtime_source")
    .args(["runtime_config", "uniform_runtime_config"])
    .required(true)
    .multiple(false))]
pub(super) struct ProfileSetArgs {
    #[arg(value_name = "NAME")]
    pub(super) name: String,
    #[arg(long, value_name = "FILE")]
    pub(super) graph: Option<PathBuf>,
    #[arg(long, value_enum, value_name = "TEMPLATE")]
    pub(super) template: Option<TemplateName>,
    #[arg(long, value_name = "FILE")]
    pub(super) runtime_config: Option<PathBuf>,
    #[arg(long, value_name = "FILE")]
    pub(super) uniform_runtime_config: Option<PathBuf>,
    #[arg(long)]
    pub(super) default: bool,
    #[command(flatten)]
    pub(super) delivery: DeliveryArgs,
    #[command(flatten)]
    pub(super) route: ProfileRouteArgs,
}
