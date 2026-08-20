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
use openengine_cluster_protocol::{RunId, RunSubmission, RunSubmitParams};
use thiserror::Error;

use crate::execution::process::HostedProcessPool;
use crate::native_v2_admission::{DeliveryPolicy, NativeV2Admission};
use crate::native_v2_claude::ClaudeProcessEnvironment;
use crate::native_v2_cloud::{NativeV2CloudController, run_intent_digest};
use crate::native_v2_contract::SourceBranchId;
use crate::native_v2_target_authority::{
    FileTargetSetupStore, NativeV2TargetAuthority, TargetAuthorityError, TargetControllerFactory,
    TargetRunReceipt, TargetRunRequest, TargetSetupDocument,
};
use crate::v2_run_ledger::RunLedger;
use crate::v2_run_ledger::sqlite::SqliteRunLedger;
use crate::native_v2_supervisor::RunEnvironment;

use allocator::{ProductionCapsuleAllocator, ProductionCapsuleConfig};
use repository::{production_source, repository_token, resolve_source, SourceResolution};

const DEFAULT_CLAUDE_TURN_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);
const TARGET_SETUP_FILE: &str = "target-setup.json";

/// Composes the production controller factory with the target's one durable setup document.
/// Every process restart restores setup before it can mint an OECP session.
pub async fn build_production_target_authority(
    config: ProductionHostingConfig,
) -> Result<NativeV2TargetAuthority, ProductionHostingError> {
    let root = prepare_storage_root(&config.storage_root)?;
    let setup_store = Arc::new(FileTargetSetupStore::new(root.join(TARGET_SETUP_FILE)));
    NativeV2TargetAuthority::with_setup_store(
        Arc::new(ProductionTargetControllerFactory::new(config)),
        setup_store,
    )
    .await
    .map_err(|_| ProductionHostingError::SetupStore)
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
        setup: &TargetSetupDocument,
    ) -> Result<Arc<NativeV2CloudController>, ProductionHostingError> {
        setup
            .validate()
            .map_err(|_| ProductionHostingError::InvalidSetup)?;
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
    async fn create(
        &self,
        setup: &TargetSetupDocument,
    ) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        self.create_controller(setup)
            .await
            .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))
    }

    async fn submit(
        &self,
        setup: &TargetSetupDocument,
        controller: &NativeV2CloudController,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        setup.validate()?;
        let TargetRunRequest {
            intent,
            environment,
        } = request;
        let intent_digest = run_intent_digest(&intent)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
        if let Some(receipt) = controller
            .resolve_intent(&intent.submission_key, &intent_digest)
            .await
            .map_err(|error| TargetAuthorityError::conflict(error.to_string()))?
        {
            return Ok(TargetRunReceipt {
                run_id: receipt.run_id,
            });
        }
        NativeV2Admission
            .validate_intent(&intent, DeliveryPolicy::Optional)
            .await
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
        let environment = RunEnvironment::exact(&intent.runtime, environment)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
        let repository_source = production_source(&setup.repository);
        let branch = effective_branch(intent.branch.as_ref(), setup.default_branch.as_deref());
        let source = resolve_source(SourceResolution {
            git_program: &self.config.git_program,
            source: &repository_source,
            repository: &setup.repository,
            branch,
            process_pool: self.config.process_pool,
            github_token: repository_token(&environment),
        })
        .await
        .map_err(|_| TargetAuthorityError::unavailable("source could not be resolved"))?;
        let run_id = fresh_host_run_id()?;
        let receipt = controller
            .submit_with_intent_digest_and_exact_environment(
                RunSubmitParams {
                    run_id,
                    submission: RunSubmission {
                        title: intent.title,
                        graph: intent.graph,
                        initial_input: intent.initial_input,
                        runtime: intent.runtime,
                        source,
                        submission_key: intent.submission_key,
                    },
                },
                intent_digest,
                environment,
            )
            .await
            .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))?;
        Ok(TargetRunReceipt {
            run_id: receipt.run_id,
        })
    }
}

fn effective_branch<'a>(
    run_override: Option<&'a SourceBranchId>,
    target_default: Option<&'a str>,
) -> Option<&'a str> {
    run_override.map(SourceBranchId::as_str).or(target_default)
}

fn fresh_host_run_id() -> Result<RunId, TargetAuthorityError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| TargetAuthorityError::unavailable("run identity could not be assigned"))?;
    let mut id = String::from("run-");
    for byte in random {
        use std::fmt::Write as _;
        let _ = write!(&mut id, "{byte:02x}");
    }
    Ok(RunId::new(id))
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProductionHostingError {
    #[error("native-v2 target setup is invalid")]
    InvalidSetup,
    #[error("native-v2 target storage could not be prepared")]
    Storage,
    #[error("native-v2 target setup store could not be opened")]
    SetupStore,
    #[error("native-v2 target ledger could not be opened")]
    Ledger,
    #[error("native-v2 capsule configuration is invalid")]
    CapsuleConfiguration,
    #[error("native-v2 target controller could not be started")]
    Controller,
}

fn prepare_storage_root(path: &PathBuf) -> Result<PathBuf, ProductionHostingError> {
    std::fs::create_dir_all(path).map_err(|_| ProductionHostingError::Storage)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ProductionHostingError::Storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ProductionHostingError::Storage);
    }
    let root = std::fs::canonicalize(path).map_err(|_| ProductionHostingError::Storage)?;
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
    let runs_metadata =
        std::fs::symlink_metadata(&runs).map_err(|_| ProductionHostingError::Storage)?;
    if !runs_metadata.is_dir() || runs_metadata.file_type().is_symlink() {
        return Err(ProductionHostingError::Storage);
    }
    Ok(root)
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
