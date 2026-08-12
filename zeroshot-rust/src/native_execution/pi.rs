#[path = "pi/protocol.rs"]
mod protocol;

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use openengine_cluster_protocol as wire;
use tokio::time::{Duration, Instant};

use crate::execution::{self, driver, process};

use super::credential::OpenAiCredential;
use super::program::NATIVE_AGENT_PROCESS_TIMEOUT_MS;
use super::worker_process::{
    cli_configuration, finish_worker_run, probe_output, successful_stdout, WorkerRunFailure,
};
use super::NativeExecutionProcess;
use protocol::{parse_pi_output, PiUserInput};

const MINIMUM_PI_VERSION: (u64, u64, u64) = (0, 84, 1);
const PI_PROVIDER: &str = "openai";
const PI_MODEL: &str = "gpt-5.4";
const PROBE_TIMEOUT_MS: u64 = 10_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const DENY_FLAGS: [&str; 7] = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--no-tools",
];
const REQUIRED_FLAGS: [&str; 14] = [
    "--mode",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--no-tools",
    "--provider",
    "--model",
    "--thinking",
    "--offline",
    "--list-models",
    "--version",
];

pub(super) fn validate_terminal_output(output: &serde_json::Value) -> Result<(), ()> {
    protocol::validate_terminal_output(output)
}

pub(super) struct NativePiDriver {
    runner: process::LocalProcessRunner,
    executable: Option<PathBuf>,
    environment: Option<BTreeMap<String, String>>,
    workspace: PathBuf,
    config: PathBuf,
    credential: OpenAiCredential,
}

impl NativePiDriver {
    pub(super) fn new(process: &NativeExecutionProcess) -> Result<Self, ()> {
        let configuration = cli_configuration("pi", process.path_snapshot.as_deref())?;
        if !configuration.arguments.is_empty() {
            return Err(());
        }
        let (workspace, config) = private_directories(process);
        let environment = pi_environment(process.path_snapshot.as_ref(), &config);
        Ok(Self {
            runner: process::LocalProcessRunner::new(),
            executable: configuration.executable,
            environment,
            workspace,
            config,
            credential: OpenAiCredential::new(
                configuration.requirement,
                process.api_key_snapshot.clone(),
            )?,
        })
    }

    pub(super) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(super) async fn preflight(&self, input: &serde_json::Value) -> Result<(), ()> {
        PiUserInput::parse(input)?;
        self.prepare_private_roots()?;
        self.require_empty_roots()?;
        self.credential.validate(PROBE_TIMEOUT_MS)?;
        self.validate_version().await?;
        self.validate_help().await?;
        self.validate_model().await?;
        self.require_empty_roots()
    }

    async fn validate_version(&self) -> Result<(), ()> {
        let version = self
            .run_probe(probe_arguments(["--version"]), false)
            .await?;
        if parse_version(&version).is_none_or(|version| version < MINIMUM_PI_VERSION) {
            return Err(());
        }
        Ok(())
    }

    async fn validate_help(&self) -> Result<(), ()> {
        let help = String::from_utf8(self.run_probe(probe_arguments(["--help"]), false).await?)
            .map_err(|_| ())?;
        let options = help_options(&help);
        if REQUIRED_FLAGS.iter().any(|flag| !options.contains(flag)) {
            return Err(());
        }
        Ok(())
    }

    async fn validate_model(&self) -> Result<(), ()> {
        let models = String::from_utf8(
            self.run_probe(
                probe_arguments(["--offline", "--list-models", PI_MODEL]),
                true,
            )
            .await?,
        )
        .map_err(|_| ())?;
        if !models.lines().any(|line| {
            let mut columns = line.split_whitespace();
            columns.next() == Some(PI_PROVIDER) && columns.next() == Some(PI_MODEL)
        }) {
            return Err(());
        }
        Ok(())
    }

    async fn run_probe(&self, argv: Vec<String>, needs_placeholder: bool) -> Result<Vec<u8>, ()> {
        let command = self.command(argv, process::ProcessInput::empty(), PROBE_TIMEOUT)?;
        let secret = if needs_placeholder {
            Some(OpenAiCredential::probe_placeholder())
        } else {
            None
        };
        probe_output(&self.runner, command, secret).await
    }

    fn command(
        &self,
        argv: Vec<String>,
        stdin: process::ProcessInput,
        timeout: Duration,
    ) -> Result<process::ProcessCommand, ()> {
        Ok(process::ProcessCommand {
            program: self
                .executable
                .as_ref()
                .and_then(|path| path.to_str())
                .ok_or(())?
                .to_owned(),
            argv,
            environment: self.environment.clone().ok_or(())?,
            workspace: driver::WorkspaceCapability {
                current_dir: self.workspace.clone(),
                mode: execution::WorkspaceAccessMode::ReadOnly,
            },
            stdin,
            deadline: Instant::now() + timeout,
        })
    }

    async fn run_request(
        &self,
        request: driver::DriverRequest,
        cancellation: driver::DriverCancellation,
    ) -> Result<wire::WorkerOutcome, WorkerRunFailure> {
        self.require_empty_roots()
            .map_err(|()| WorkerRunFailure::Closed(wire::WorkerErrorCode::Refusal))?;
        let input = PiUserInput::from_execution_input(request.input)
            .map_err(|()| WorkerRunFailure::Closed(wire::WorkerErrorCode::Malformed))?;
        let stdin = process::ProcessInput::new(input.into_prompt().into_bytes())
            .map_err(|_| WorkerRunFailure::Closed(wire::WorkerErrorCode::Malformed))?;
        let argv = [
            "--mode",
            "json",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-approve",
            "--no-tools",
            "--provider",
            PI_PROVIDER,
            "--model",
            PI_MODEL,
            "--thinking",
            "medium",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let command = self
            .command(
                argv,
                stdin,
                Duration::from_millis(NATIVE_AGENT_PROCESS_TIMEOUT_MS),
            )
            .map_err(|()| WorkerRunFailure::Closed(wire::WorkerErrorCode::Crash))?;
        let secret = self
            .credential
            .acquire(NATIVE_AGENT_PROCESS_TIMEOUT_MS)
            .map_err(|()| WorkerRunFailure::Closed(wire::WorkerErrorCode::Refusal))?;
        classify_pi_process(
            self.runner
                .run_with_secrets(command, secret, cancellation)
                .await,
        )
    }

    fn require_empty_roots(&self) -> Result<(), ()> {
        for directory in [&self.workspace, &self.config] {
            if std::fs::read_dir(directory)
                .map_err(|_| ())?
                .next()
                .is_some()
            {
                return Err(());
            }
        }
        Ok(())
    }

    fn prepare_private_roots(&self) -> Result<(), ()> {
        let root = self.workspace.parent().ok_or(())?;
        for directory in [root, &self.workspace, &self.config] {
            create_private_directory(directory)?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl driver::BuiltinWorkerDriver for NativePiDriver {
    async fn start(
        &self,
        request: driver::DriverRequest,
        cancellation: driver::DriverCancellation,
    ) -> driver::DriverStartOutcome {
        finish_worker_run(self.run_request(request, cancellation).await)
    }
}

fn classify_pi_process(
    result: Result<process::ProcessRunOutput, process::ProcessRunnerError>,
) -> Result<wire::WorkerOutcome, WorkerRunFailure> {
    let stdout = successful_stdout(result)?;
    parse_pi_output(&stdout, PI_PROVIDER, PI_MODEL)
        .map_err(|()| WorkerRunFailure::Closed(wire::WorkerErrorCode::Malformed))
}

fn probe_arguments<const N: usize>(tail: [&str; N]) -> Vec<String> {
    DENY_FLAGS
        .into_iter()
        .chain(tail)
        .map(str::to_owned)
        .collect()
}

fn help_options(help: &str) -> BTreeSet<&str> {
    help.split_whitespace()
        .filter(|token| token.starts_with("--"))
        .map(|token| token.trim_end_matches([',', ':', ';']))
        .collect()
}

fn parse_version(bytes: &[u8]) -> Option<(u64, u64, u64)> {
    let text = std::str::from_utf8(bytes).ok()?;
    text.split_whitespace().find_map(|word| {
        let version = word.trim_start_matches('v');
        let mut parts = version.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.split('-').next()?.parse().ok()?;
        parts.next().is_none().then_some((major, minor, patch))
    })
}

fn private_root(state_dir: &Path, resource: &crate::cluster_ledger::ResourceId) -> PathBuf {
    let digest = crate::cluster_ledger::record::CanonicalDigest::of(resource.as_str().as_bytes());
    state_dir.join(format!(
        "native-pi-{}",
        crate::native_admission::native_worker_protocol::digest_hex(digest)
    ))
}

fn private_directories(process: &NativeExecutionProcess) -> (PathBuf, PathBuf) {
    let root = private_root(&process.state_dir, &process.resource);
    let workspace = root.join("workspace");
    let config = root.join("config");
    (workspace, config)
}

fn pi_environment(
    path: Option<&std::ffi::OsString>,
    config: &Path,
) -> Option<BTreeMap<String, String>> {
    Some(BTreeMap::from([
        ("PATH".to_owned(), path?.clone().into_string().ok()?),
        (
            "PI_CODING_AGENT_DIR".to_owned(),
            config.to_str()?.to_owned(),
        ),
        ("PI_OFFLINE".to_owned(), "1".to_owned()),
        ("PI_SKIP_VERSION_CHECK".to_owned(), "1".to_owned()),
        ("PI_TELEMETRY".to_owned(), "0".to_owned()),
    ]))
}

fn create_private_directory(path: &Path) -> Result<(), ()> {
    std::fs::create_dir_all(path).map_err(|_| ())?;
    if !path.is_dir()
        || path
            .symlink_metadata()
            .map_err(|_| ())?
            .file_type()
            .is_symlink()
    {
        return Err(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| ())?;
    }
    Ok(())
}
