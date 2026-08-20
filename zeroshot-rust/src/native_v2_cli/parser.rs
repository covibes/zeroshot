use std::ffi::OsString;
use std::path::PathBuf;

use openengine_cluster_protocol::{ExecutionRef, IdempotencyKey, RunTitle, SourceBranchId};

use super::{
    BuiltinGraphTemplate, NativeV2CliCommand, NativeV2CliError, RunCommand, RunGraph, RunSelector,
    TargetAdd, TargetSetup, TemplateDelivery,
};

/// Parses only the native-v2 public command surface. Unknown options are rejected.
pub fn parse_native_v2_args<I>(args: I) -> Result<NativeV2CliCommand, NativeV2CliError>
where
    I: IntoIterator<Item = OsString>,
{
    parse_native_v2_strings(&collect_utf8_args(args)?)
}

fn collect_utf8_args<I>(args: I) -> Result<Vec<String>, NativeV2CliError>
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| usage("arguments must be valid UTF-8"))
        })
        .collect()
}

fn parse_native_v2_strings(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(NativeV2CliCommand::Help);
    };
    if is_observation_command(command) {
        return parse_observation_command(command, argument_tail(args, 1)?);
    }
    if command == "template" {
        return parse_template(argument_tail(args, 1)?);
    }
    parse_primary_command(command, args)
}

fn parse_primary_command(
    command: &str,
    args: &[String],
) -> Result<NativeV2CliCommand, NativeV2CliError> {
    match command {
        "help" | "--help" | "-h" => exact_help(args),
        "target" => parse_target(argument_tail(args, 1)?),
        "run" => parse_run(argument_tail(args, 1)?),
        "list" => parse_list(argument_tail(args, 1)?),
        _ => Err(usage(format!("unknown native-v2 command {command:?}"))),
    }
}

fn parse_template(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(usage("template requires list or show"));
    };
    match command {
        "list" if args.len() == 1 => Ok(NativeV2CliCommand::TemplateList),
        "list" => Err(usage("template list accepts no arguments")),
        "show" => parse_template_show(argument_tail(args, 1)?),
        _ => Err(usage(format!("unknown template command {command:?}"))),
    }
}

fn parse_template_show(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let template = parse_template_name(args.first())?;
    let options = Options::parse(argument_tail(args, 1)?, &[], &["--pr", "--ship"])?;
    Ok(NativeV2CliCommand::TemplateShow {
        template,
        delivery: parse_template_delivery(template, &options)?,
    })
}

fn is_observation_command(command: &str) -> bool {
    matches!(
        command,
        "status" | "watch" | "logs" | "attach" | "force-stop"
    )
}

fn parse_observation_command(
    command: &str,
    args: &[String],
) -> Result<NativeV2CliCommand, NativeV2CliError> {
    match command {
        "status" => parse_run_selector(args).map(NativeV2CliCommand::Status),
        "watch" => parse_run_selector(args).map(NativeV2CliCommand::Watch),
        "logs" => parse_run_selector(args).map(NativeV2CliCommand::Logs),
        "attach" => parse_attach(args),
        "force-stop" => parse_run_selector(args).map(NativeV2CliCommand::ForceStop),
        _ => Err(usage(format!("unknown observation command {command:?}"))),
    }
}

fn exact_help(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    if args.len() == 1 {
        Ok(NativeV2CliCommand::Help)
    } else {
        Err(usage("help accepts no arguments"))
    }
}

fn parse_target(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(usage("target requires add, login, or setup"));
    };
    match command {
        "add" => parse_target_add(args),
        "login" => parse_target_login(args),
        "setup" => parse_target_setup(args),
        _ => Err(usage(format!("unknown target command {command:?}"))),
    }
}

fn parse_target_add(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let name = required_name(args.get(1), "target name")?;
    let options = Options::parse(argument_tail(args, 2)?, &["--url"], &["--direct"])?;
    Ok(NativeV2CliCommand::TargetAdd(TargetAdd {
        name,
        url: options.required("--url")?,
        direct: options.flag("--direct"),
    }))
}

fn parse_target_login(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    if args.len() != 2 {
        return Err(usage("target login requires exactly one target name"));
    }
    Ok(NativeV2CliCommand::TargetLogin {
        name: required_name(args.get(1), "target name")?,
    })
}

fn parse_target_setup(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let (name, options) = parse_target_options(args, &["--repository", "--branch"])?;
    Ok(NativeV2CliCommand::TargetSetup(TargetSetup {
        name,
        repository: options.required("--repository")?,
        default_branch: optional_branch(&options)?,
    }))
}

fn parse_target_options(
    args: &[String],
    accepted_values: &[&str],
) -> Result<(String, Options), NativeV2CliError> {
    let name = required_name(args.get(1), "target name")?;
    let options = Options::parse(argument_tail(args, 2)?, accepted_values, &[])?;
    Ok((name, options))
}

fn parse_run(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let options = Options::parse(
        args,
        &[
            "--target",
            "--title",
            "--graph",
            "--template",
            "--input",
            "--runtime-config",
            "--branch",
            "--submission-key",
        ],
        &["--detach", "-d", "--pr", "--ship"],
    )?;
    let (target, branch) = parse_run_route(&options)?;
    Ok(NativeV2CliCommand::Run(RunCommand {
        target,
        title: RunTitle::new(options.required("--title")?)
            .map_err(|error| usage(format!("invalid --title: {error}")))?,
        graph: parse_run_graph(&options)?,
        input: PathBuf::from(options.required("--input")?),
        runtime_config: PathBuf::from(options.required("--runtime-config")?),
        branch,
        detach: detach_requested(&options),
        submission_key: parse_submission_key(&options)?,
    }))
}

fn parse_run_route(
    options: &Options,
) -> Result<(Option<String>, Option<SourceBranchId>), NativeV2CliError> {
    let target = optional_target(options)?;
    let branch = optional_branch(options)?;
    if target.is_none() && branch.is_some() {
        return Err(usage("--branch requires --target"));
    }
    Ok((target, branch))
}

fn detach_requested(options: &Options) -> bool {
    options.flag("--detach") || options.flag("-d")
}

fn parse_submission_key(options: &Options) -> Result<Option<IdempotencyKey>, NativeV2CliError> {
    options
        .optional("--submission-key")
        .map(IdempotencyKey::new)
        .transpose()
        .map_err(|error| usage(format!("invalid --submission-key: {error}")))
}

fn optional_branch(options: &Options) -> Result<Option<SourceBranchId>, NativeV2CliError> {
    options
        .optional("--branch")
        .map(SourceBranchId::new)
        .transpose()
        .map_err(|error| usage(format!("invalid --branch: {error}")))
}

fn parse_run_graph(options: &Options) -> Result<RunGraph, NativeV2CliError> {
    match (options.optional("--graph"), options.optional("--template")) {
        (Some(path), None) => {
            reject_delivery_flags(options)?;
            Ok(RunGraph::File(PathBuf::from(path)))
        }
        (None, Some(name)) => {
            let template = parse_template_name(Some(&name))?;
            let delivery = parse_template_delivery(template, options)?;
            Ok(RunGraph::Template { template, delivery })
        }
        (Some(_), Some(_)) => Err(usage("--graph and --template are mutually exclusive")),
        (None, None) => Err(usage("exactly one of --graph or --template is required")),
    }
}

fn parse_template_name(value: Option<&String>) -> Result<BuiltinGraphTemplate, NativeV2CliError> {
    let name = value.ok_or_else(|| usage("template name is required"))?;
    BuiltinGraphTemplate::parse(name)
        .ok_or_else(|| usage(format!("unknown built-in template {name:?}")))
}

fn parse_template_delivery(
    template: BuiltinGraphTemplate,
    options: &Options,
) -> Result<TemplateDelivery, NativeV2CliError> {
    let delivery = selected_delivery(options)?;
    if template == BuiltinGraphTemplate::SingleWorker && delivery != TemplateDelivery::None {
        return Err(usage(
            "--pr and --ship are valid only with --template software-change",
        ));
    }
    Ok(delivery)
}

fn selected_delivery(options: &Options) -> Result<TemplateDelivery, NativeV2CliError> {
    match (options.flag("--pr"), options.flag("--ship")) {
        (true, true) => Err(usage("--pr and --ship are mutually exclusive")),
        (true, false) => Ok(TemplateDelivery::PullRequest),
        (false, true) => Ok(TemplateDelivery::Merge),
        (false, false) => Ok(TemplateDelivery::None),
    }
}

fn reject_delivery_flags(options: &Options) -> Result<(), NativeV2CliError> {
    if options.flag("--pr") || options.flag("--ship") {
        return Err(usage(
            "--pr and --ship require --template software-change; author delivery in custom graphs",
        ));
    }
    Ok(())
}

fn parse_list(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let options = Options::parse(args, &["--target"], &[])?;
    Ok(NativeV2CliCommand::List {
        target: optional_target(&options)?,
    })
}

fn parse_run_selector(args: &[String]) -> Result<RunSelector, NativeV2CliError> {
    let run_id = args.first().ok_or_else(|| usage("run ID is required"))?;
    validate_public_id(run_id, "run ID")?;
    let options = Options::parse(argument_tail(args, 1)?, &["--target"], &[])?;
    Ok(RunSelector {
        target: optional_target(&options)?,
        run_id: openengine_cluster_protocol::RunId::new(run_id),
    })
}

fn parse_attach(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let run_id = args
        .first()
        .ok_or_else(|| usage("attach requires a run ID"))?;
    validate_public_id(run_id, "run ID")?;
    let execution = args
        .get(1)
        .ok_or_else(|| usage("attach requires an execution reference"))?;
    let execution = ExecutionRef::new(execution.clone())
        .map_err(|error| usage(format!("invalid execution reference: {error}")))?;
    let options = Options::parse(argument_tail(args, 2)?, &["--target"], &[])?;
    Ok(NativeV2CliCommand::Attach {
        run: RunSelector {
            target: optional_target(&options)?,
            run_id: openengine_cluster_protocol::RunId::new(run_id),
        },
        execution,
    })
}

fn optional_target(options: &Options) -> Result<Option<String>, NativeV2CliError> {
    let target = options.optional("--target");
    if let Some(target) = &target {
        validate_public_id(target, "target name")?;
    }
    Ok(target)
}

fn required_name(value: Option<&String>, kind: &str) -> Result<String, NativeV2CliError> {
    let value = value.ok_or_else(|| usage(format!("{kind} is required")))?;
    validate_public_id(value, kind)?;
    Ok(value.clone())
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

#[derive(Default)]
struct Options {
    values: std::collections::BTreeMap<String, String>,
    flags: std::collections::BTreeSet<String>,
}

impl Options {
    fn parse(
        args: &[String],
        value_names: &[&str],
        flag_names: &[&str],
    ) -> Result<Self, NativeV2CliError> {
        let mut parsed = Self::default();
        let mut index = 0;
        while index < args.len() {
            let name = args
                .get(index)
                .ok_or_else(|| usage("option index exceeds argument list"))?
                .as_str();
            if value_names.contains(&name) {
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.is_empty() && !value.starts_with('-'))
                    .ok_or_else(|| usage(format!("{name} requires a value")))?;
                if parsed
                    .values
                    .insert(name.to_owned(), value.clone())
                    .is_some()
                {
                    return Err(usage(format!("{name} may be specified only once")));
                }
                index += 2;
            } else if flag_names.contains(&name) {
                if !parsed.flags.insert(name.to_owned()) {
                    return Err(usage(format!("{name} may be specified only once")));
                }
                index += 1;
            } else {
                return Err(usage(format!("unknown option or argument {name:?}")));
            }
        }
        Ok(parsed)
    }

    fn required(&self, name: &str) -> Result<String, NativeV2CliError> {
        self.values
            .get(name)
            .cloned()
            .ok_or_else(|| usage(format!("{name} is required")))
    }

    fn optional(&self, name: &str) -> Option<String> {
        self.values.get(name).cloned()
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}

fn argument_tail(args: &[String], start: usize) -> Result<&[String], NativeV2CliError> {
    args.get(start..)
        .ok_or_else(|| usage("command arguments are incomplete"))
}
