use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{ArgGroup, Args, Parser, Subcommand, ValueEnum};

/// Run multi-agent graph workloads locally or on named Zeroshot targets.
///
/// Single-result commands write JSON. Foreground `run`, `watch`, `logs`, and `attach` stream
/// newline-delimited JSON (NDJSON).
#[derive(Debug, Parser)]
#[command(
    name = "zeroshot-rust",
    version,
    disable_version_flag = true,
    arg_required_else_help = true
)]
pub struct Cli {
    /// Print the Zeroshot Rust version.
    #[arg(short = 'V', long, exclusive = true)]
    version: bool,

    #[command(subcommand)]
    command: Option<CliCommand>,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Manage named targets or serve a direct target.
    Target {
        #[command(subcommand)]
        command: TargetCommand,
    },

    /// Manage static credentials by connection key.
    Connection {
        #[command(subcommand)]
        command: ConnectionCommand,
    },

    /// Inspect built-in graph templates.
    Template {
        #[command(subcommand)]
        command: TemplateCommand,
    },

    /// Submit a graph run locally or to a named target.
    ///
    /// When --target is omitted, the run uses the current local repository. A foreground run
    /// follows NDJSON events until completion. --detach returns after submission; Ctrl-C also
    /// detaches from observation without stopping the run. Named-target runs send GH_TOKEN, when
    /// set, for source checkout and Git delivery; providers receive it only when the runtime
    /// declares GH_TOKEN.
    Run(RunArgs),

    #[command(flatten)]
    Utility(UtilityCommand),
}

#[derive(Debug, Subcommand)]
enum UtilityCommand {
    /// List runs as JSON.
    List(TargetRouteArgs),

    /// Read a run's current status as JSON.
    Status(RunSelectorArgs),

    /// Follow a run's durable event stream as NDJSON.
    Watch(RunWatchArgs),

    /// Follow a run's log stream as NDJSON.
    Logs(RunLogsArgs),

    /// Attach to an execution's interactive event stream as NDJSON.
    Attach(AttachArgs),

    /// Force a run to stop and write the result as JSON.
    ForceStop(RunSelectorArgs),

    /// Print the Zeroshot Rust version.
    Version,
}

#[derive(Debug, Subcommand)]
enum TargetCommand {
    /// Register a named target.
    Add(TargetAddArgs),

    /// Authenticate with a hosted named target.
    ///
    /// On Linux, desktop sessions prefer Secret Service and headless sessions use a durable
    /// private file. Set ZEROSHOT_RUST_CREDENTIAL_STORE to auto, system, or file to override
    /// automatic selection.
    Login(TargetNameArgs),

    /// Configure the local profile for a named target.
    ///
    /// This changes only the local named-target registry; it does not configure the remote target.
    Setup(TargetSetupArgs),

    /// Serve a native-v2 target, unauthenticated unless --bootstrap-key-file is set.
    ///
    /// Without --bootstrap-key-file, clients connect directly with no authentication. With a
    /// bootstrap key, the server enables private authenticated access and consumes and removes the
    /// key file while starting.
    Serve(TargetServeArgs),
}

#[derive(Debug, Subcommand)]
enum ConnectionCommand {
    /// List connection metadata without secret values.
    List(ConnectionRouteArgs),

    /// Create or replace one static connection.
    Set(ConnectionSetArgs),

    /// Delete one connection.
    Delete(ConnectionDeleteArgs),
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum ConnectionScopeArg {
    #[default]
    User,
    Org,
}

#[derive(Debug, Args)]
struct ConnectionRouteArgs {
    /// Use this named hosted target. If omitted, use local connections.
    #[arg(long, value_name = "NAME")]
    target: Option<String>,

    /// Select user- or organization-scoped connections.
    #[arg(long, value_enum, default_value_t)]
    scope: ConnectionScopeArg,
}

#[derive(Debug, Args)]
#[command(group = ArgGroup::new("connection_input").args(["field", "json_stdin"]).required(true).multiple(false))]
struct ConnectionSetArgs {
    /// Unique connection key within the selected scope.
    #[arg(value_name = "KEY")]
    key: String,

    /// Prompt without echo for this environment field. Repeat for multiple fields.
    #[arg(long, value_name = "ENV", action = clap::ArgAction::Append)]
    field: Vec<String>,

    /// Read one JSON object of environment field names to secret values from standard input.
    #[arg(long)]
    json_stdin: bool,

    #[command(flatten)]
    route: ConnectionRouteArgs,
}

#[derive(Debug, Args)]
struct ConnectionDeleteArgs {
    /// Unique connection key within the selected scope.
    #[arg(value_name = "KEY")]
    key: String,

    #[command(flatten)]
    route: ConnectionRouteArgs,
}

#[derive(Debug, Subcommand)]
enum TemplateCommand {
    /// List built-in template names as JSON.
    List,

    /// Write a built-in graph template as JSON.
    Show(TemplateShowArgs),
}

#[derive(Debug, Args)]
struct TargetAddArgs {
    /// Local name used to select this target.
    #[arg(value_name = "NAME")]
    name: String,

    /// Target origin URL.
    #[arg(long, value_name = "ORIGIN")]
    url: String,

    /// Use unauthenticated direct access instead of hosted authentication.
    #[arg(long)]
    direct: bool,
}

#[derive(Debug, Args)]
struct TargetNameArgs {
    /// Local target name.
    #[arg(value_name = "NAME")]
    name: String,
}

#[derive(Debug, Args)]
struct TargetSetupArgs {
    /// Local target name.
    #[arg(value_name = "NAME")]
    name: String,

    /// GitHub repository in owner/name form.
    #[arg(long, value_name = "OWNER/NAME")]
    repository: String,

    /// Default source branch used when a run does not specify --branch.
    #[arg(long, value_name = "BRANCH")]
    branch: Option<String>,
}

#[derive(Debug, Args)]
struct TargetServeArgs {
    /// IP socket address on which the target listens.
    #[arg(long, value_name = "ADDRESS")]
    listen: SocketAddr,

    /// Public HTTP(S) origin advertised to clients.
    #[arg(long, value_name = "ORIGIN")]
    public_origin: String,

    /// Directory that stores target state and run data.
    #[arg(long, value_name = "DIRECTORY")]
    storage: PathBuf,

    /// Enable private auth with a one-time key file consumed and removed at startup.
    ///
    /// The target consumes and removes this file while starting. If omitted, the target accepts
    /// unauthenticated direct connections.
    #[arg(long, value_name = "PATH")]
    bootstrap_key_file: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum TemplateName {
    /// A single general-purpose worker.
    SingleWorker,

    /// A review, validation, and optional delivery workflow for code changes.
    SoftwareChange,
}

#[derive(Debug, Args)]
#[group(id = "delivery_mode", multiple = false)]
struct DeliveryArgs {
    /// Materialize this Rust-owned delivery mode.
    #[arg(long, value_name = "MODE")]
    delivery: Option<String>,

    /// Materialize pull-request delivery for the software-change template.
    #[arg(long)]
    pr: bool,

    /// Materialize merge delivery for the software-change template.
    ///
    /// Named-target runs forward GH_TOKEN for the generated GitHub merge operation.
    #[arg(long)]
    ship: bool,
}

impl DeliveryArgs {
    fn selection(&self) -> (Option<&str>, bool, bool) {
        (self.delivery.as_deref(), self.pr, self.ship)
    }
}

#[derive(Debug, Args)]
struct TemplateShowArgs {
    /// Built-in graph template to render.
    #[arg(value_enum, value_name = "TEMPLATE")]
    template: TemplateName,

    #[command(flatten)]
    delivery: DeliveryArgs,
}

#[derive(Debug, Args)]
#[command(group = ArgGroup::new("graph_source").args(["graph", "template"]).required(true).multiple(false))]
#[command(group = ArgGroup::new("runtime_source")
    .args(["runtime_config", "uniform_runtime_config"])
    .required(true)
    .multiple(false))]
#[command(after_long_help = r#"RUNTIME CONFIGURATION
    The file is secret-free JSON. For example:

      {
        "harness": "codex",
        "provider": "openrouter",
        "size": "medium",
        "nodes": {
          "worker": {
            "kind": "agent",
            "model": "gpt-5.6-sol",
            "connections": {"openrouter": ["OPENROUTER_API_KEY"]}
          }
        }
      }

    Harness/provider pairs:
      codex: openai or openrouter
      claude: anthropic or openrouter

    Sizes are small, medium, and large. Codex models are gpt-5.6, gpt-5.6-sol,
    gpt-5.6-terra, and gpt-5.6-luna. Claude models are claude-haiku-4-5, claude-sonnet-5,
    claude-opus-5, and claude-fable-5.

    Every executable graph node needs a same-named binding. Agent bindings require kind and model.
    Optional fields are effort (low, medium, high, xhigh, or max when supported), sessionScope
    (execution or node_instance), and connections. Each connection key maps to the exact
    environment variable names required by that node; never put values in this file.

    Use `zeroshot-rust template show TEMPLATE` to inspect node names. With --pr or --ship, omit the
    template-owned delivery binding.

    --uniform-runtime-config accepts the same harness, provider, size, model, effort, sessionScope,
    and connections fields without nodes. Rust expands that agent binding across every executable
    graph node and supplies graph-visible Git delivery bindings itself."#)]
struct RunArgs {
    /// Human-readable title recorded with the run.
    #[arg(long, value_name = "TITLE")]
    title: String,

    /// Load a custom graph specification from this JSON file.
    #[arg(long, value_name = "FILE")]
    graph: Option<PathBuf>,

    /// Materialize and run this built-in graph template.
    #[arg(long, value_enum, value_name = "TEMPLATE")]
    template: Option<TemplateName>,

    /// Load the graph's initial input from this JSON file.
    #[arg(long, value_name = "FILE")]
    input: PathBuf,

    /// Load an exact secret-free runtime plan from this JSON file.
    #[arg(long, value_name = "FILE")]
    runtime_config: Option<PathBuf>,

    /// Expand one secret-free agent runtime across every executable graph node.
    #[arg(long, value_name = "FILE")]
    uniform_runtime_config: Option<PathBuf>,

    /// Run on this named target; if omitted, run locally. Named targets receive GH_TOKEN when set.
    ///
    /// The token is used for source checkout and Git delivery. A provider receives it only when
    /// the runtime configuration explicitly declares GH_TOKEN.
    #[arg(long, value_name = "NAME")]
    target: Option<String>,

    /// Source branch to resolve on the named target. Requires --target.
    #[arg(long, value_name = "BRANCH")]
    branch: Option<String>,

    /// Stable idempotency key for safely retrying submission.
    #[arg(long, value_name = "KEY")]
    submission_key: Option<String>,

    /// Return after submission instead of following NDJSON run events.
    #[arg(short = 'd', long)]
    detach: bool,

    /// Validate and materialize the run without submitting it or contacting a target.
    #[arg(long)]
    validate_only: bool,

    #[command(flatten)]
    delivery: DeliveryArgs,
}

#[derive(Debug, Args)]
struct TargetRouteArgs {
    /// Use this named target. If omitted, use the local controller.
    #[arg(long, value_name = "NAME")]
    target: Option<String>,
}

#[derive(Debug, Args)]
struct RunSelectorArgs {
    /// Public run ID.
    #[arg(value_name = "RUN_ID")]
    run_id: String,

    /// Use this named target. If omitted, use the local controller.
    #[arg(long, value_name = "NAME")]
    target: Option<String>,
}

#[derive(Debug, Args)]
struct RunWatchArgs {
    #[command(flatten)]
    run: RunSelectorArgs,

    /// Resume strictly after this durable cursor.
    #[arg(long, value_name = "CURSOR")]
    after: Option<String>,
}

#[derive(Debug, Args)]
struct RunLogsArgs {
    #[command(flatten)]
    run: RunSelectorArgs,

    /// Resume strictly after this durable cursor.
    #[arg(long, value_name = "CURSOR")]
    after: Option<String>,

    /// Return records only for this opaque execution selector.
    #[arg(long, value_name = "EXECUTION_REF")]
    execution: Option<String>,
}

#[derive(Debug, Args)]
struct AttachArgs {
    /// Public run ID.
    #[arg(value_name = "RUN_ID")]
    run_id: String,

    /// Execution reference emitted by the run.
    #[arg(value_name = "EXECUTION_REF")]
    execution: String,

    /// Use this named target. If omitted, use the local controller.
    #[arg(long, value_name = "NAME")]
    target: Option<String>,
}

#[path = "parser/convert.rs"]
mod convert;
pub use convert::parse_native_v2_args;
