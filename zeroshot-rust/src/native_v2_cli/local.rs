//! Auth-free local CLI backend for one-run controller processes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{
    IdempotencyKey, RunAttachEventNotification, RunAttachParams, RunForceParams, RunForceResult,
    RunId, RunListParams, RunListResult, RunLogEventNotification, RunLogsParams, RunStatusParams,
    RunStatusResult, RunSubmitResult, RunWatchParams, Sha256Digest,
};
use sha2::{Digest, Sha256};
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep};

use super::oecp::{ChannelSubscription, spawn_attach, spawn_logs, spawn_watch};
use super::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
    NativeV2CliBackend, NativeV2CliError, TargetAdd, TargetRunRequest, TargetSetup,
};
use crate::native_v2_admission::{DeliveryPolicy, NativeV2Admission};
use crate::native_v2_cloud::run_intent_digest;
use crate::native_v2_local::{PreparedLocalRun, prepare_local_run};
use crate::native_v2_portable_controller::{
    ControllerLease, ControllerLeaseError, PortableControllerBootstrap, PortableControllerPaths,
    PortableRunController, read_ready, write_bootstrap_file,
};
use crate::native_v2_portable_controller::process::{PortableControllerTransport, connect_transport};
use crate::v2_run_ledger::sqlite::SqliteRunLedger;
use crate::v2_run_ledger::{RunLedger, RunLedgerError};

#[path = "local/state.rs"]
mod state;
use state::*;

#[path = "local/backend.rs"]
mod backend;

/// Private process mode intercepted by the shipped binary before public CLI parsing.
#[doc(hidden)]
pub const LOCAL_CONTROLLER_MODE: &str = "__zeroshot-run-controller";

const BOOTSTRAP_FILE: &str = "controller.bootstrap.json";
const SUBMISSION_LOCK_FILE: &str = "submission.lock";
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROLLER_HANDOFF_RETRY_DELAY: Duration = Duration::from_millis(25);

#[derive(Clone, Debug)]
pub struct LocalCliBackend {
    state_root: PathBuf,
    executable: PathBuf,
    current_directory: PathBuf,
    git_program: PathBuf,
    ready_timeout: Duration,
}

impl LocalCliBackend {
    pub fn production() -> Result<Self, NativeV2CliError> {
        Ok(Self {
            state_root: default_local_state_root()?,
            executable: std::env::current_exe().map_err(local_io)?,
            current_directory: std::env::current_dir().map_err(local_io)?,
            git_program: PathBuf::from("git"),
            ready_timeout: DEFAULT_READY_TIMEOUT,
        })
    }

    #[must_use]
    pub fn new(
        state_root: PathBuf,
        executable: PathBuf,
        current_directory: PathBuf,
        git_program: PathBuf,
    ) -> Self {
        Self {
            state_root,
            executable,
            current_directory,
            git_program,
            ready_timeout: DEFAULT_READY_TIMEOUT,
        }
    }

    #[must_use]
    pub fn with_ready_timeout(mut self, timeout: Duration) -> Self {
        self.ready_timeout = timeout;
        self
    }

    fn run_storage(
        &self,
        run_id: &openengine_cluster_protocol::RunId,
    ) -> Result<PathBuf, NativeV2CliError> {
        validate_local_run_id(run_id)?;
        Ok(self.state_root.join("runs").join(run_id.as_str()))
    }

    fn paths(
        &self,
        run_id: &openengine_cluster_protocol::RunId,
    ) -> Result<PortableControllerPaths, NativeV2CliError> {
        let paths = self.run_storage(run_id).map(PortableControllerPaths::new)?;
        validate_local_socket_path(&paths.socket())?;
        Ok(paths)
    }

    async fn connect_run(
        &self,
        run_id: &openengine_cluster_protocol::RunId,
    ) -> Result<Arc<PortableControllerTransport>, NativeV2CliError> {
        let paths = self.paths(run_id)?;
        if read_ready(&paths).is_ok_and(|ready| &ready.run_id != run_id) {
            return Err(local_message(
                "controller readiness has a different run identity",
            ));
        }
        if let Ok(transport) = connect_transport(&paths).await {
            return Ok(transport);
        }

        let observer = Arc::new(
            PortableRunController::open_observer(paths.clone(), run_id.clone())
                .await
                .map_err(local_error)?,
        );
        let server = observer.bind().await.map_err(local_error)?;
        tokio::spawn(async move {
            let _ = server.serve().await;
        });
        connect_transport(&paths).await.map_err(local_error)
    }

    async fn start_controller(
        &self,
        request: TargetRunRequest,
    ) -> Result<openengine_cluster_protocol::RunId, NativeV2CliError> {
        let intent_digest = run_intent_digest(&request.intent).map_err(local_error)?;
        let _submission_lock = self.acquire_submission_lock().await?;
        if let Some(run_id) = self
            .existing_submission(&request.intent.submission_key, &intent_digest)
            .await?
        {
            return Ok(run_id);
        }
        NativeV2Admission
            .validate_intent(&request.intent, DeliveryPolicy::Optional)
            .await
            .map_err(local_error)?;
        let prepared = prepare_local_run(request, &self.current_directory, &self.git_program)
            .map_err(local_error)?;
        self.start_prepared_controller(prepared).await
    }

    async fn start_prepared_controller(
        &self,
        prepared: PreparedLocalRun,
    ) -> Result<RunId, NativeV2CliError> {
        let paths = self.paths(&prepared.run_id)?;
        let storage = self.create_run_storage(&prepared.run_id)?;
        let workspace_lease = self.workspace_lease(&prepared.workspace)?;
        let bootstrap_path = storage.join(BOOTSTRAP_FILE);
        let bootstrap = PortableControllerBootstrap {
            run_id: prepared.run_id.clone(),
            submission: prepared.submission,
            environment: prepared.environment,
            workspace: prepared.workspace,
            workspace_lease,
            storage,
            delivery_policy: DeliveryPolicy::Optional,
        };
        write_bootstrap_file(&bootstrap_path, &bootstrap).map_err(local_error)?;
        let mut child = match self.spawn_controller(&bootstrap_path) {
            Ok(child) => child,
            Err(error) => {
                remove_private_bootstrap(&bootstrap_path);
                return Err(error);
            }
        };
        if let Err(error) =
            wait_for_controller(&mut child, &paths, &prepared.run_id, self.ready_timeout).await
        {
            let _ = child.kill().await;
            remove_private_bootstrap(&bootstrap_path);
            return Err(error);
        }
        Ok(prepared.run_id)
    }

    async fn acquire_submission_lock(&self) -> Result<ControllerLease, NativeV2CliError> {
        let path = self.state_root.join(SUBMISSION_LOCK_FILE);
        loop {
            match ControllerLease::acquire(&path) {
                Ok(lock) => return Ok(lock),
                Err(ControllerLeaseError::Held) => sleep(Duration::from_millis(20)).await,
                Err(error) => return Err(local_error(error)),
            }
        }
    }

    async fn existing_submission(
        &self,
        submission_key: &IdempotencyKey,
        intent_digest: &Sha256Digest,
    ) -> Result<Option<RunId>, NativeV2CliError> {
        for run_id in self.local_run_ids()? {
            if let Some(existing) = self
                .matching_submission(run_id, submission_key, intent_digest)
                .await?
            {
                return Ok(Some(existing));
            }
        }
        Ok(None)
    }

    async fn matching_submission(
        &self,
        run_id: RunId,
        submission_key: &IdempotencyKey,
        intent_digest: &Sha256Digest,
    ) -> Result<Option<RunId>, NativeV2CliError> {
        let ledger_path = self.run_storage(&run_id)?.join("runs.sqlite3");
        if !require_existing_ledger(&ledger_path)? {
            return Ok(None);
        }
        let ledger = SqliteRunLedger::open(&ledger_path).map_err(local_error)?;
        let Some(stored) = ledger
            .get_by_submission_key(submission_key)
            .await
            .map_err(local_error)?
        else {
            return Ok(None);
        };
        if stored.snapshot.run_id != run_id {
            return Err(local_message(
                "run ledger identity does not match its storage",
            ));
        }
        if stored.intent_digest != *intent_digest {
            return Err(local_error(RunLedgerError::SubmissionConflict {
                existing_run_id: run_id,
            }));
        }
        Ok(Some(run_id))
    }

    fn local_run_ids(&self) -> Result<Vec<RunId>, NativeV2CliError> {
        let entries = match std::fs::read_dir(self.state_root.join("runs")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(local_io(error)),
        };
        let mut run_ids = entries
            .map(|entry| entry.map_err(local_io))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(local_run_id_from_entry)
            .collect::<Vec<_>>();
        run_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        Ok(run_ids)
    }

    fn workspace_lease(&self, workspace: &Path) -> Result<PathBuf, NativeV2CliError> {
        use std::os::unix::ffi::OsStrExt as _;

        let root = self.state_root.join("workspaces");
        prepare_private_directory(&root)?;
        let digest = Sha256::digest(workspace.as_os_str().as_bytes());
        Ok(root.join(format!("{digest:x}.lock")))
    }

    fn create_run_storage(
        &self,
        run_id: &openengine_cluster_protocol::RunId,
    ) -> Result<PathBuf, NativeV2CliError> {
        let runs = self.state_root.join("runs");
        prepare_private_directory(&runs)?;
        let storage = self.run_storage(run_id)?;
        private_directory_builder()
            .create(&storage)
            .map_err(local_io)?;
        validate_private_directory(&storage)?;
        Ok(storage)
    }

    fn spawn_controller(&self, bootstrap: &Path) -> Result<Child, NativeV2CliError> {
        let mut command = Command::new(&self.executable);
        command
            .arg(LOCAL_CONTROLLER_MODE)
            .arg("--bootstrap")
            .arg(bootstrap)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_clear();
        copy_minimal_process_environment(&mut command);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command.spawn().map_err(local_io)
    }

    async fn list_local(&self) -> Result<RunListResult, NativeV2CliError> {
        let runs_root = self.state_root.join("runs");
        let entries = match std::fs::read_dir(&runs_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RunListResult { runs: Vec::new() });
            }
            Err(error) => return Err(local_io(error)),
        };
        let mut runs = Vec::new();
        for entry in entries {
            if let Some(result) = self.list_entry(entry).await? {
                runs.extend(result.runs);
            }
        }
        runs.sort_by(|left, right| left.run_id.as_str().cmp(right.run_id.as_str()));
        Ok(RunListResult { runs })
    }

    async fn list_entry(
        &self,
        entry: std::io::Result<std::fs::DirEntry>,
    ) -> Result<Option<RunListResult>, NativeV2CliError> {
        let Some(run_id) = entry.ok().and_then(local_run_id_from_entry) else {
            return Ok(None);
        };
        let result = match self.list_entry_once(&run_id).await {
            Ok(result) => Ok(result),
            Err(_) => {
                sleep(CONTROLLER_HANDOFF_RETRY_DELAY).await;
                self.list_entry_once(&run_id).await
            }
        };
        match result {
            Ok(result) => Ok(Some(result)),
            Err(NativeV2CliError::Local(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn list_entry_once(&self, run_id: &RunId) -> Result<RunListResult, NativeV2CliError> {
        let transport = self.connect_run(run_id).await?;
        ClusterClient::new(transport.as_ref())
            .run_list(RunListParams::default())
            .await
            .map_err(protocol_error)
    }

    async fn status_local(
        &self,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        let retry = params.clone();
        match self.status_once(params).await {
            Ok(result) => Ok(result),
            Err(_) => {
                sleep(CONTROLLER_HANDOFF_RETRY_DELAY).await;
                self.status_once(retry).await
            }
        }
    }

    async fn status_once(
        &self,
        params: RunStatusParams,
    ) -> Result<RunStatusResult, NativeV2CliError> {
        let transport = self.connect_run(&params.run_id).await?;
        ClusterClient::new(transport.as_ref())
            .run_status(params)
            .await
            .map_err(protocol_error)
    }

    async fn force_local(
        &self,
        params: RunForceParams,
    ) -> Result<RunForceResult, NativeV2CliError> {
        let retry = params.clone();
        match self.force_once(params).await {
            Ok(result) => Ok(result),
            Err(_) => {
                sleep(CONTROLLER_HANDOFF_RETRY_DELAY).await;
                self.force_once(retry).await
            }
        }
    }

    async fn force_once(&self, params: RunForceParams) -> Result<RunForceResult, NativeV2CliError> {
        let transport = self.connect_run(&params.run_id).await?;
        ClusterClient::new(transport.as_ref())
            .run_force(params)
            .await
            .map_err(protocol_error)
    }
}

async fn wait_for_controller(
    child: &mut Child,
    paths: &PortableControllerPaths,
    run_id: &openengine_cluster_protocol::RunId,
    timeout: Duration,
) -> Result<(), NativeV2CliError> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(ready) = read_ready(paths) {
            if &ready.run_id == run_id {
                connect_transport(paths).await.map_err(local_error)?;
                return Ok(());
            }
        }
        if child.try_wait().map_err(local_io)?.is_some() {
            return Err(local_message("controller exited before becoming ready"));
        }
        if Instant::now() >= deadline {
            return Err(local_message(
                "controller did not become ready before the deadline",
            ));
        }
        sleep(Duration::from_millis(20)).await;
    }
}

fn require_local(target: Option<&str>) -> Result<(), NativeV2CliError> {
    if target.is_none() {
        Ok(())
    } else {
        Err(local_message("local backend cannot serve a named target"))
    }
}

fn protocol_error(error: impl std::fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Protocol(error.to_string())
}

fn local_error(error: impl std::fmt::Display) -> NativeV2CliError {
    local_message(error.to_string())
}

fn local_io(error: std::io::Error) -> NativeV2CliError {
    local_message(error.to_string())
}

fn local_message(message: impl Into<String>) -> NativeV2CliError {
    NativeV2CliError::Local(message.into())
}
