mod platform;
#[cfg(unix)]
mod platform_unix;
#[cfg(windows)]
mod platform_windows;
mod session;
mod session_runtime;
mod spawn_recovery;

use std::path::{Path, PathBuf};

use thiserror::Error;

use platform::ProcessContainment;
pub use session::{
    MAX_PROCESS_FRAME_BYTES, MAX_PROCESS_FRAMING_OVERHEAD_BYTES, MAX_PROCESS_MESSAGE_BYTES,
    PROCESS_STDIN_CAPACITY, PROCESS_STDOUT_CAPACITY, ProcessFrame, ProcessOutputChunk,
    ProcessSession, ProcessSessionCommand, ProcessSessionOutput,
};

pub const MAX_PROCESS_DIAGNOSTIC_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_ARGV_ITEMS: usize = 256;
pub const MAX_PROCESS_ARGV_BYTES: usize = 64 * 1024;
pub const MAX_PROCESS_ENV_ITEMS: usize = 256;
pub const MAX_PROCESS_ENV_BYTES: usize = 64 * 1024;
pub const HOSTED_WORKER_UID: u32 = 10_002;
pub const HOSTED_WORKER_GID: u32 = 10_002;

/// Linux identity allocation for one contained provider process domain.
///
/// Within an active run, workers reuse one identity because the workspace gate serializes them.
/// Verifiers derive stable, disjoint identities from their session scope so parallel cleanup cannot
/// affect peers. A production host derives one such pool per active run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostedProcessPool {
    writer_uid: u32,
    writer_gid: u32,
    verifier_uid_base: u32,
    verifier_gid: u32,
}

/// Stable containment and runtime-home scope for one provider session.
///
/// Node-instance scopes survive authored loop revisits. Execution scopes are deliberately fresh.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostedProcessScope {
    Writer,
    WriterNodeInstance(u64),
    WriterExecution(u64),
    VerifierNodeInstance(u64),
    VerifierExecution(u64),
}

impl HostedProcessScope {
    #[must_use]
    pub fn private_home(self, root: &Path) -> PathBuf {
        let leaf = match self {
            Self::Writer => "writer".to_owned(),
            Self::WriterNodeInstance(identity) => format!("writer-node-instance-{identity}"),
            Self::WriterExecution(identity) => format!("writer-execution-{identity}"),
            Self::VerifierNodeInstance(identity) => {
                format!("verifier-node-instance-{identity}")
            }
            Self::VerifierExecution(identity) => format!("verifier-execution-{identity}"),
        };
        root.join(leaf)
    }

    fn verifier_identity(self) -> Option<(u64, u32)> {
        match self {
            Self::Writer | Self::WriterNodeInstance(_) | Self::WriterExecution(_) => None,
            Self::VerifierNodeInstance(identity) => Some((identity, 0)),
            Self::VerifierExecution(identity) => Some((identity, 1)),
        }
    }

    fn validate(self) -> Result<(), ProcessRunnerError> {
        let identity = match self {
            Self::Writer => None,
            Self::WriterNodeInstance(identity)
            | Self::WriterExecution(identity)
            | Self::VerifierNodeInstance(identity)
            | Self::VerifierExecution(identity) => Some(identity),
        };
        if identity == Some(0) {
            return Err(ProcessRunnerError::InvalidCommand(
                "provider process identity must be greater than zero".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HostedProcessIdentity {
    runner: LocalProcessRunner,
    uid: u32,
    gid: u32,
    scope: HostedProcessScope,
}

impl HostedProcessIdentity {
    #[must_use]
    pub const fn runner(self) -> LocalProcessRunner {
        self.runner
    }

    #[must_use]
    pub const fn uid(self) -> u32 {
        self.uid
    }

    #[must_use]
    pub const fn gid(self) -> u32 {
        self.gid
    }

    /// Creates or reclaims the provider-private leaf under a supervisor-owned runtime root.
    ///
    /// The root must already exist and be traversable by the configured provider identity. It must
    /// not be writable by provider processes; only the generated leaf is handed to the child.
    pub fn prepare_private_home(self, root: &Path) -> Result<PathBuf, ProcessRunnerError> {
        let home = self.scope.private_home(root);
        prepare_private_directory(&home, Some((self.uid, self.gid)))?;
        Ok(home)
    }
}

impl HostedProcessPool {
    pub(crate) const fn hosted_default() -> Self {
        Self {
            writer_uid: HOSTED_WORKER_UID,
            writer_gid: HOSTED_WORKER_GID,
            verifier_uid_base: 20_000,
            verifier_gid: 20_000,
        }
    }

    pub fn new(
        writer_uid: u32,
        writer_gid: u32,
        verifier_uid_base: u32,
        verifier_gid: u32,
    ) -> Result<Self, ProcessRunnerError> {
        if writer_uid == 0
            || writer_gid == 0
            || verifier_uid_base == 0
            || verifier_gid == 0
            || verifier_uid_base == u32::MAX
            || writer_uid >= verifier_uid_base
        {
            return Err(ProcessRunnerError::InvalidCommand(
                "hosted provider identities are invalid".to_owned(),
            ));
        }
        Ok(Self {
            writer_uid,
            writer_gid,
            verifier_uid_base,
            verifier_gid,
        })
    }

    pub fn writer(self) -> Result<LocalProcessRunner, ProcessRunnerError> {
        self.identity(HostedProcessScope::Writer)
            .map(HostedProcessIdentity::runner)
    }

    pub fn verifier(self, execution: u64) -> Result<LocalProcessRunner, ProcessRunnerError> {
        self.identity(HostedProcessScope::VerifierExecution(execution))
            .map(HostedProcessIdentity::runner)
    }

    /// Derives one disjoint active-run pool from this host pool.
    ///
    /// The host pool's writer identity remains reserved for serialized source resolution. Active
    /// runs start at its verifier base and reserve one writer plus both verifier session variants
    /// for every admitted execution identity.
    pub(crate) fn active_run_slot(
        self,
        slot: u32,
        maximum_identity: u64,
    ) -> Result<Self, ProcessRunnerError> {
        let width = maximum_identity
            .checked_mul(2)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(identity_range_exhausted)?;
        let verifier_span = maximum_identity
            .checked_mul(2)
            .and_then(|value| value.checked_sub(1))
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(identity_range_exhausted)?;
        let offset = u64::from(slot)
            .checked_mul(width)
            .ok_or_else(identity_range_exhausted)?;
        let writer_uid = u64::from(self.verifier_uid_base)
            .checked_add(offset)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(identity_range_exhausted)?;
        let verifier_uid_base = writer_uid
            .checked_add(1)
            .ok_or_else(identity_range_exhausted)?;
        let highest_uid = verifier_uid_base
            .checked_add(verifier_span)
            .ok_or_else(identity_range_exhausted)?;
        if highest_uid == u32::MAX {
            return Err(identity_range_exhausted());
        }
        Self::new(
            writer_uid,
            self.writer_gid,
            verifier_uid_base,
            self.verifier_gid,
        )
    }

    pub fn identity(
        self,
        scope: HostedProcessScope,
    ) -> Result<HostedProcessIdentity, ProcessRunnerError> {
        scope.validate()?;
        let (uid, gid) = match scope.verifier_identity() {
            None => (self.writer_uid, self.writer_gid),
            Some((identity, discriminator)) => {
                let index = identity.checked_sub(1).ok_or_else(|| {
                    ProcessRunnerError::InvalidCommand(
                        "provider process identity must be greater than zero".to_owned(),
                    )
                })?;
                let offset = index
                    .checked_mul(2)
                    .and_then(|value| value.checked_add(u64::from(discriminator)))
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| {
                        ProcessRunnerError::InvalidCommand(
                            "verifier identity range is exhausted".to_owned(),
                        )
                    })?;
                let uid = self.verifier_uid_base.checked_add(offset).ok_or_else(|| {
                    ProcessRunnerError::InvalidCommand(
                        "verifier identity range is exhausted".to_owned(),
                    )
                })?;
                (uid, self.verifier_gid)
            }
        };
        let runner = LocalProcessRunner::hosted_worker_identity(uid, gid)?;
        Ok(HostedProcessIdentity {
            runner,
            uid,
            gid,
            scope,
        })
    }
}

fn identity_range_exhausted() -> ProcessRunnerError {
    ProcessRunnerError::InvalidCommand("hosted process identity range is exhausted".to_owned())
}

pub fn prepare_local_private_home(
    root: &Path,
    scope: HostedProcessScope,
) -> Result<PathBuf, ProcessRunnerError> {
    scope.validate()?;
    let home = scope.private_home(root);
    prepare_private_directory(&home, None)?;
    Ok(home)
}

fn prepare_private_directory(
    path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<(), ProcessRunnerError> {
    create_private_directory(path)?;
    validate_private_directory(path)?;
    set_private_directory_mode(path)?;
    set_private_directory_owner(path, owner)
}

fn create_private_directory(path: &Path) -> Result<(), ProcessRunnerError> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(ProcessRunnerError::Launch(
            "provider private home could not be created".to_owned(),
        )),
    }
}

fn validate_private_directory(path: &Path) -> Result<(), ProcessRunnerError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        ProcessRunnerError::Launch("provider private home could not be inspected".to_owned())
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ProcessRunnerError::InvalidCommand(
            "provider private home is not a directory".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_mode(path: &Path) -> Result<(), ProcessRunnerError> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| {
        ProcessRunnerError::Launch("provider private home mode could not be set".to_owned())
    })
}

#[cfg(not(unix))]
fn set_private_directory_mode(_path: &Path) -> Result<(), ProcessRunnerError> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_private_directory_owner(
    path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<(), ProcessRunnerError> {
    use std::os::unix::ffi::OsStrExt;

    if let Some((uid, gid)) = owner {
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            ProcessRunnerError::InvalidCommand("provider private home path is invalid".to_owned())
        })?;
        // SAFETY: the path is a live NUL-free C string and the caller supplied fixed numeric IDs.
        if unsafe { libc::chown(path.as_ptr(), uid, gid) } != 0 {
            return Err(ProcessRunnerError::Launch(
                "provider private home ownership could not be set".to_owned(),
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_private_directory_owner(
    _path: &Path,
    owner: Option<(u32, u32)>,
) -> Result<(), ProcessRunnerError> {
    let _ = owner;
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessLaunchEvidence {
    DefinitelyNotStarted,
    MayHaveStarted,
}

#[derive(Debug, Error)]
pub enum ProcessRunnerError {
    #[error("invalid process command: {0}")]
    InvalidCommand(String),
    #[error("process launch failed before start: {0}")]
    Launch(String),
    #[error("process I/O failed after launch: {0}")]
    Io(String),
}

impl ProcessRunnerError {
    #[must_use]
    pub const fn launch_evidence(&self) -> ProcessLaunchEvidence {
        match self {
            Self::InvalidCommand(_) | Self::Launch(_) => {
                ProcessLaunchEvidence::DefinitelyNotStarted
            }
            Self::Io(_) => ProcessLaunchEvidence::MayHaveStarted,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LocalProcessRunner {
    containment: ProcessContainment,
}

impl Default for LocalProcessRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalProcessRunner {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            containment: ProcessContainment::ProcessGroup,
        }
    }

    pub fn hosted_worker() -> Result<Self, ProcessRunnerError> {
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                containment: ProcessContainment::WorkerUid {
                    uid: HOSTED_WORKER_UID,
                    gid: HOSTED_WORKER_GID,
                },
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(ProcessRunnerError::Launch(
                "hosted worker containment requires Linux".to_owned(),
            ))
        }
    }

    pub fn hosted_worker_identity(uid: u32, gid: u32) -> Result<Self, ProcessRunnerError> {
        #[cfg(target_os = "linux")]
        {
            if uid == 0 || gid == 0 {
                return Err(ProcessRunnerError::InvalidCommand(
                    "hosted worker identity must be unprivileged".to_owned(),
                ));
            }
            Ok(Self {
                containment: ProcessContainment::WorkerUid { uid, gid },
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (uid, gid);
            Err(ProcessRunnerError::Launch(
                "hosted worker containment requires Linux".to_owned(),
            ))
        }
    }
}

pub use platform::ProcessCleanupEvidence;

#[cfg(test)]
#[path = "process/tests.rs"]
mod tests;
