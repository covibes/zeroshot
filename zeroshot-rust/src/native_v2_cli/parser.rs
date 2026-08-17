use std::ffi::OsString;
use std::path::PathBuf;

use openengine_cluster_protocol::{ExecutionRef, IdempotencyKey};

use super::{NativeV2CliCommand, NativeV2CliError, RunCommand, RunSelector, TargetAdd, TargetSetup};

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
    let (name, options) = parse_target_options(args, &["--url"])?;
    Ok(NativeV2CliCommand::TargetAdd(TargetAdd {
        name,
        url: options.required("--url")?,
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
    let (name, options) = parse_target_options(
        args,
        &[
            "--repository",
            "--runtime-config",
            "--base",
            "--target-branch",
        ],
    )?;
    Ok(NativeV2CliCommand::TargetSetup(TargetSetup {
        name,
        repository: options.required("--repository")?,
        runtime_config: PathBuf::from(options.required("--runtime-config")?),
        base: options.optional("--base"),
        target_branch: options.optional("--target-branch"),
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
        &["--target", "--graph", "--input", "--submission-key"],
        &["--ship", "--detach", "-d"],
    )?;
    let submission_key = options
        .optional("--submission-key")
        .map(IdempotencyKey::new)
        .transpose()
        .map_err(|error| usage(format!("invalid --submission-key: {error}")))?;
    Ok(NativeV2CliCommand::Run(RunCommand {
        target: required_target(&options)?,
        graph: PathBuf::from(options.required("--graph")?),
        input: PathBuf::from(options.required("--input")?),
        ship: options.flag("--ship"),
        detach: options.flag("--detach") || options.flag("-d"),
        submission_key,
    }))
}

fn parse_list(args: &[String]) -> Result<NativeV2CliCommand, NativeV2CliError> {
    let options = Options::parse(args, &["--target"], &[])?;
    Ok(NativeV2CliCommand::List {
        target: required_target(&options)?,
    })
}

fn parse_run_selector(args: &[String]) -> Result<RunSelector, NativeV2CliError> {
    let run_id = args.first().ok_or_else(|| usage("run ID is required"))?;
    validate_public_id(run_id, "run ID")?;
    let options = Options::parse(argument_tail(args, 1)?, &["--target"], &[])?;
    Ok(RunSelector {
        target: required_target(&options)?,
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
            target: required_target(&options)?,
            run_id: openengine_cluster_protocol::RunId::new(run_id),
        },
        execution,
    })
}

fn required_target(options: &Options) -> Result<String, NativeV2CliError> {
    let target = options.required("--target")?;
    validate_public_id(&target, "target name")?;
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
