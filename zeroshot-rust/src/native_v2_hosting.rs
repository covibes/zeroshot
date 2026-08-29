//! Production composition for one native-v2 target.
//!
//! The target authority owns one SQLite ledger and one controller. Each admitted run receives one
//! disposable directory containing its repository checkout and provider-private runtime homes.
//! The allocator constructs only the existing native candidate and private capsule boundary; it
//! has no retry, credential-store, or Node compatibility path.

mod allocator;
mod repository;

#[cfg(test)]
mod tests;

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::RunSubmitParams;
use thiserror::Error;

use crate::execution::process::HostedProcessPool;
use crate::native_v2_admission::DeliveryPolicy;
use crate::native_v2_claude::ClaudeProcessEnvironment;
use crate::native_v2_cloud::{NativeV2CloudController, NativeV2CloudError};
use crate::native_v2_cloud::submission_digest;
use crate::native_v2_target_authority::{
    NativeV2TargetAuthority, TargetAuthorityError, TargetControllerFactory, TargetRunReceipt,
    TargetRunRequest,
};
use crate::v2_run_ledger::RunLedger;
use crate::v2_run_ledger::RunLedgerError;
use crate::v2_run_ledger::sqlite::SqliteRunLedger;
use crate::native_v2_supervisor::RunEnvironment;

use allocator::{ProductionCapsuleAllocator, ProductionCapsuleConfig};
const DEFAULT_CLAUDE_TURN_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// Composes the production target around exact sourceful run requests.
pub async fn build_production_target_authority(
    config: ProductionHostingConfig,
) -> Result<NativeV2TargetAuthority, ProductionHostingError> {
    prepare_storage_root(&config.storage_root)?;
    Ok(NativeV2TargetAuthority::new(Arc::new(
        ProductionTargetControllerFactory::new(config),
    )))
}

/// Host-owned non-secret capabilities used to compose one installed target.
#[derive(Clone)]
pub struct ProductionHostingConfig {
    pub storage_root: PathBuf,
    pub codex_executable: PathBuf,
    pub claude_executable: String,
    pub claude_prefix_arguments: Vec<String>,
    pub claude_process_environment: ClaudeProcessEnvironment,
    pub executable_search_path: String,
    pub git_program: PathBuf,
    pub gh_program: PathBuf,
    pub process_pool: HostedProcessPool,
    pub claude_turn_timeout: Duration,
}

impl fmt::Debug for ProductionHostingConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProductionHostingConfig")
            .field("storage_root", &self.storage_root)
            .field("codex_executable", &self.codex_executable)
            .field("claude_executable", &self.claude_executable)
            .field("git_program", &self.git_program)
            .field("gh_program", &self.gh_program)
            .finish_non_exhaustive()
    }
}

/// Factory installed behind [`crate::native_v2_target_authority::NativeV2TargetAuthority`].
#[derive(Clone, Debug)]
pub struct ProductionTargetControllerFactory {
    config: Arc<ProductionHostingConfig>,
}

impl ProductionTargetControllerFactory {
    #[must_use]
    pub fn new(config: ProductionHostingConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }

    pub async fn create_controller(
        &self,
    ) -> Result<Arc<NativeV2CloudController>, ProductionHostingError> {
        let root = prepare_storage_root(&self.config.storage_root)?;
        let ledger: Arc<dyn RunLedger> = Arc::new(
            SqliteRunLedger::open(root.join("runs.sqlite3"))
                .map_err(|_| ProductionHostingError::Ledger)?,
        );
        let allocator = Arc::new(ProductionCapsuleAllocator::new(ProductionCapsuleConfig {
            storage_root: root,
            codex_executable: self.config.codex_executable.clone(),
            claude_executable: self.config.claude_executable.clone(),
            claude_prefix_arguments: self.config.claude_prefix_arguments.clone(),
            claude_process_environment: self.config.claude_process_environment.clone(),
            executable_search_path: self.config.executable_search_path.clone(),
            git_program: self.config.git_program.clone(),
            gh_program: self.config.gh_program.clone(),
            process_pool: self.config.process_pool,
            claude_turn_timeout: self.config.claude_turn_timeout,
        })?);
        let controller = NativeV2CloudController::new_with_delivery_policy(
            ledger,
            allocator,
            DeliveryPolicy::Optional,
        )
        .await
        .map_err(|_| ProductionHostingError::Controller)?;
        Ok(Arc::new(controller))
    }
}

#[async_trait]
impl TargetControllerFactory for ProductionTargetControllerFactory {
    async fn create(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        self.create_controller()
            .await
            .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))
    }

    async fn submit(
        &self,
        controller: &NativeV2CloudController,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        let TargetRunRequest {
            run_id,
            submission,
            connections,
            github_token,
        } = request;
        let digest = submission_digest(&submission)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
        if let Some(receipt) = controller
            .resolve_submission(&submission.submission_key, &digest)
            .await
            .map_err(project_cloud_error)?
        {
            return Ok(TargetRunReceipt {
                run_id: receipt.run_id,
            });
        }
        let environment = RunEnvironment::exact(&submission.runtime, connections)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
        let receipt = controller
            .submit_with_exact_environment_and_github_token(
                RunSubmitParams { run_id, submission },
                environment,
                github_token,
            )
            .await
            .map_err(project_cloud_error)?;
        Ok(TargetRunReceipt {
            run_id: receipt.run_id,
        })
    }
}

fn project_cloud_error(error: NativeV2CloudError) -> TargetAuthorityError {
    let message = error.to_string();
    match error {
        NativeV2CloudError::Admission(_)
        | NativeV2CloudError::Environment(_)
        | NativeV2CloudError::SubmissionIdentity
        | NativeV2CloudError::Ledger(RunLedgerError::AdmittedRunTooLarge) => {
            TargetAuthorityError::invalid(message)
        }
        NativeV2CloudError::Ledger(
            RunLedgerError::SubmissionConflict { .. } | RunLedgerError::RunIdConflict,
        ) => TargetAuthorityError::conflict(message),
        _ => TargetAuthorityError::unavailable(message),
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProductionHostingError {
    #[error("native-v2 target storage could not be prepared")]
    Storage,
    #[error("native-v2 target ledger could not be opened")]
    Ledger,
    #[error("native-v2 capsule configuration is invalid")]
    CapsuleConfiguration,
    #[error("native-v2 target controller could not be started")]
    Controller,
}

fn prepare_storage_root(path: &PathBuf) -> Result<PathBuf, ProductionHostingError> {
    std::fs::create_dir_all(path).map_err(|_| ProductionHostingError::Storage)?;
    let root = canonical_directory(path)?;
    let runs = prepare_runs_directory(&root)?;
    set_traversable_directory(&root).map_err(|_| ProductionHostingError::Storage)?;
    set_traversable_directory(&runs).map_err(|_| ProductionHostingError::Storage)?;
    Ok(root)
}

fn prepare_runs_directory(root: &std::path::Path) -> Result<PathBuf, ProductionHostingError> {
    let runs = root.join("runs");
    std::fs::create_dir(&runs)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|_| ProductionHostingError::Storage)?;
    canonical_directory(&runs)?;
    Ok(runs)
}

fn canonical_directory(path: &std::path::Path) -> Result<PathBuf, ProductionHostingError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ProductionHostingError::Storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ProductionHostingError::Storage);
    }
    std::fs::canonicalize(path).map_err(|_| ProductionHostingError::Storage)
}

#[cfg(unix)]
fn set_traversable_directory(path: &std::path::Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o711))
}

#[cfg(not(unix))]
fn set_traversable_directory(_path: &std::path::Path) -> Result<(), std::io::Error> {
    Ok(())
}

impl Default for ProductionHostingConfig {
    fn default() -> Self {
        Self {
            storage_root: PathBuf::from("/var/lib/zeroshot/native-v2"),
            codex_executable: PathBuf::from("/usr/local/bin/codex"),
            claude_executable: "/usr/local/bin/claude".to_owned(),
            claude_prefix_arguments: Vec::new(),
            claude_process_environment: ClaudeProcessEnvironment::default(),
            executable_search_path: "/usr/local/bin:/usr/bin:/bin".to_owned(),
            git_program: PathBuf::from("/usr/bin/git"),
            gh_program: PathBuf::from("/usr/bin/gh"),
            process_pool: HostedProcessPool::hosted_default(),
            claude_turn_timeout: DEFAULT_CLAUDE_TURN_TIMEOUT,
        }
    }
}
