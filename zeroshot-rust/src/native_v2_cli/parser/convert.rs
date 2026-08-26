use std::ffi::OsString;
use std::path::PathBuf;

use clap::Parser;
use openengine_cluster_protocol::{Cursor, ExecutionRef, IdempotencyKey, RunTitle, SourceBranchId};

use super::{
    AttachArgs, Cli, CliCommand, RunArgs, RunLogsArgs, RunSelectorArgs, RunWatchArgs,
    TargetCommand, TemplateCommand, TemplateName, UtilityCommand,
};
use crate::native_v2_cli::{
    BuiltinGraphTemplate, NativeV2CliCommand, NativeV2CliError, RunCommand, RunGraph,
    RunLogsCommand, RunRuntime, RunSelector, RunWatchCommand, TargetAdd, TargetServe, TargetSetup,
    TemplateDelivery,
};

/// Parse the public native-v2 command surface from arguments after the executable name.
///
/// Help and version requests are returned as static commands so callers can select their output
/// stream without letting Clap terminate the process. Unknown options are rejected by the same
/// typed schema that generates help and documentation.
pub fn parse_native_v2_args<I>(args: I) -> Result<NativeV2CliCommand, NativeV2CliError>
where
    I: IntoIterator<Item = OsString>,
{
    let arguments = std::iter::once(OsString::from("zeroshot-rust")).chain(args);
    match Cli::try_parse_from(arguments) {
        Ok(cli) => cli.into_command(),
        Err(error) => match error.kind() {
            clap::error::ErrorKind::DisplayHelp
            | clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
                Ok(NativeV2CliCommand::Help(error.to_string()))
            }
            clap::error::ErrorKind::DisplayVersion => Ok(NativeV2CliCommand::Version),
            _ => Err(usage(error.to_string().trim_end())),
        },
    }
}

impl Cli {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        if self.version {
            return Ok(NativeV2CliCommand::Version);
        }
        self.command
            .ok_or_else(|| usage("a command is required"))?
            .into_command()
    }
}

impl CliCommand {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        match self {
            Self::Target { command } => command.into_command(),
            Self::Template { command } => command.into_command(),
            Self::Run(args) => args.into_command(),
            Self::Utility(command) => command.into_command(),
        }
    }
}

impl UtilityCommand {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        match self {
            Self::List(args) => Ok(NativeV2CliCommand::List {
                target: validated_target(args.target)?,
            }),
            Self::Status(args) => args.into_selector().map(NativeV2CliCommand::Status),
            Self::Watch(args) => args.into_command(),
            Self::Logs(args) => args.into_command(),
            Self::Attach(args) => args.into_command(),
            Self::ForceStop(args) => args.into_selector().map(NativeV2CliCommand::ForceStop),
            Self::Version => Ok(NativeV2CliCommand::Version),
        }
    }
}

impl TargetCommand {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        match self {
            Self::Add(args) => {
                validate_public_id(&args.name, "target name")?;
                Ok(NativeV2CliCommand::TargetAdd(TargetAdd {
                    name: args.name,
                    url: args.url,
                    direct: args.direct,
                }))
            }
            Self::Login(args) => {
                validate_public_id(&args.name, "target name")?;
                Ok(NativeV2CliCommand::TargetLogin { name: args.name })
            }
            Self::Setup(args) => {
                validate_public_id(&args.name, "target name")?;
                Ok(NativeV2CliCommand::TargetSetup(TargetSetup {
                    name: args.name,
                    repository: args.repository,
                    default_branch: optional_branch(args.branch)?,
                }))
            }
            Self::Serve(args) => Ok(NativeV2CliCommand::TargetServe(TargetServe {
                listen: args.listen,
                public_origin: args.public_origin,
                storage: args.storage,
                bootstrap_key_file: args.bootstrap_key_file,
            })),
        }
    }
}

impl TemplateCommand {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        match self {
            Self::List => Ok(NativeV2CliCommand::TemplateList),
            Self::Show(args) => {
                let template = args.template.into_template()?;
                Ok(NativeV2CliCommand::TemplateShow {
                    template,
                    delivery: template_delivery(template, args.delivery.selection())?,
                })
            }
        }
    }
}

impl TemplateName {
    fn into_template(self) -> Result<BuiltinGraphTemplate, NativeV2CliError> {
        let name = match self {
            Self::SingleWorker => "single-worker",
            Self::SoftwareChange => "software-change",
        };
        BuiltinGraphTemplate::parse(name)
            .ok_or_else(|| usage("Clap template value is outside the built-in catalog"))
    }
}

impl RunArgs {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        let (target, branch) = run_route(self.target, self.branch)?;
        Ok(NativeV2CliCommand::Run(RunCommand {
            target,
            title: RunTitle::new(self.title)
                .map_err(|error| usage(format!("invalid --title: {error}")))?,
            graph: run_graph(self.graph, self.template, self.delivery.selection())?,
            input: self.input,
            runtime: run_runtime(self.runtime_config, self.uniform_runtime_config)?,
            branch,
            detach: self.detach,
            validate_only: self.validate_only,
            submission_key: submission_key(self.submission_key)?,
        }))
    }
}

fn run_runtime(
    exact: Option<PathBuf>,
    uniform: Option<PathBuf>,
) -> Result<RunRuntime, NativeV2CliError> {
    match (exact, uniform) {
        (Some(path), None) => Ok(RunRuntime::Exact(path)),
        (None, Some(path)) => Ok(RunRuntime::Uniform(path)),
        _ => Err(usage(
            "exactly one of --runtime-config or --uniform-runtime-config is required",
        )),
    }
}

fn run_route(
    target: Option<String>,
    branch: Option<String>,
) -> Result<(Option<String>, Option<SourceBranchId>), NativeV2CliError> {
    let target = validated_target(target)?;
    let branch = optional_branch(branch)?;
    if target.is_none() && branch.is_some() {
        return Err(usage("--branch requires --target"));
    }
    Ok((target, branch))
}

fn run_graph(
    graph: Option<PathBuf>,
    template: Option<TemplateName>,
    delivery: (Option<&str>, bool, bool),
) -> Result<RunGraph, NativeV2CliError> {
    let (delivery, pr, ship) = delivery;
    match (graph, template) {
        (Some(path), None) if delivery.is_none() && !pr && !ship => Ok(RunGraph::File(path)),
        (Some(_), None) => Err(usage(
            "--pr and --ship require --template software-change; author delivery in custom graphs",
        )),
        (None, Some(template)) => {
            let template = template.into_template()?;
            Ok(RunGraph::Template {
                template,
                delivery: template_delivery(template, (delivery, pr, ship))?,
            })
        }
        _ => Err(usage("exactly one of --graph or --template is required")),
    }
}

fn submission_key(
    submission_key: Option<String>,
) -> Result<Option<IdempotencyKey>, NativeV2CliError> {
    submission_key
        .map(IdempotencyKey::new)
        .transpose()
        .map_err(|error| usage(format!("invalid --submission-key: {error}")))
}

impl RunSelectorArgs {
    fn into_selector(self) -> Result<RunSelector, NativeV2CliError> {
        validate_public_id(&self.run_id, "run ID")?;
        Ok(RunSelector {
            target: validated_target(self.target)?,
            run_id: openengine_cluster_protocol::RunId::new(self.run_id),
        })
    }
}

impl RunWatchArgs {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        Ok(NativeV2CliCommand::Watch(RunWatchCommand {
            run: self.run.into_selector()?,
            after: self.after.map(Cursor::new),
        }))
    }
}

impl RunLogsArgs {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        let execution = self
            .execution
            .map(ExecutionRef::new)
            .transpose()
            .map_err(|error| usage(format!("invalid execution reference: {error}")))?;
        Ok(NativeV2CliCommand::Logs(RunLogsCommand {
            run: self.run.into_selector()?,
            after: self.after.map(Cursor::new),
            execution,
        }))
    }
}

impl AttachArgs {
    fn into_command(self) -> Result<NativeV2CliCommand, NativeV2CliError> {
        validate_public_id(&self.run_id, "run ID")?;
        let execution = ExecutionRef::new(self.execution)
            .map_err(|error| usage(format!("invalid execution reference: {error}")))?;
        Ok(NativeV2CliCommand::Attach {
            run: RunSelector {
                target: validated_target(self.target)?,
                run_id: openengine_cluster_protocol::RunId::new(self.run_id),
            },
            execution,
        })
    }
}

fn template_delivery(
    template: BuiltinGraphTemplate,
    (selected, pr, ship): (Option<&str>, bool, bool),
) -> Result<TemplateDelivery, NativeV2CliError> {
    let delivery = match (selected, pr, ship) {
        (Some("none"), false, false) | (None, false, false) => TemplateDelivery::None,
        (Some("pull_request"), false, false) | (None, true, false) => TemplateDelivery::PullRequest,
        (Some("merge"), false, false) | (None, false, true) => TemplateDelivery::Merge,
        (Some(mode), false, false) => {
            return Err(usage(format!("unknown template delivery mode {mode:?}")));
        }
        _ => return Err(usage("--delivery, --pr, and --ship are mutually exclusive")),
    };
    if template == BuiltinGraphTemplate::SingleWorker && delivery != TemplateDelivery::None {
        return Err(usage(
            "--pr and --ship are valid only with --template software-change",
        ));
    }
    Ok(delivery)
}

fn validated_target(target: Option<String>) -> Result<Option<String>, NativeV2CliError> {
    if let Some(target) = &target {
        validate_public_id(target, "target name")?;
    }
    Ok(target)
}

fn optional_branch(branch: Option<String>) -> Result<Option<SourceBranchId>, NativeV2CliError> {
    branch
        .map(SourceBranchId::new)
        .transpose()
        .map_err(|error| usage(format!("invalid --branch: {error}")))
}

fn validate_public_id(value: &str, kind: &str) -> Result<(), NativeV2CliError> {
    if value.is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control) {
        return Err(usage(format!(
            "{kind} must be 1..=256 non-control characters"
        )));
    }
    Ok(())
}

fn usage(message: impl Into<String>) -> NativeV2CliError {
    NativeV2CliError::Usage(message.into())
}
