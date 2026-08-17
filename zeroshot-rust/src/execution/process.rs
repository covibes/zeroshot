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

/// One-run Linux identity allocation for contained provider turns.
///
/// Workers reuse one identity because the workspace gate serializes them. Verifiers derive stable,
/// disjoint identities from their session scope so parallel cleanup cannot affect peers.
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
mod hosted_identity_tests {
    use std::path::Path;

    use super::{HostedProcessPool, HostedProcessScope};

    #[test]
    fn hosted_scopes_keep_loop_sessions_stable_and_executions_disjoint() {
        let pool = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).unwrap();
        let loop_scope = HostedProcessScope::VerifierNodeInstance(7);
        let repeated = pool.identity(loop_scope).unwrap();
        let first_execution = pool
            .identity(HostedProcessScope::VerifierExecution(7))
            .unwrap();
        let second_execution = pool
            .identity(HostedProcessScope::VerifierExecution(8))
            .unwrap();

        assert_eq!(pool.identity(loop_scope).unwrap().uid(), repeated.uid());
        assert_ne!(repeated.uid(), first_execution.uid());
        assert_ne!(first_execution.uid(), second_execution.uid());
        assert_eq!(
            loop_scope.private_home(Path::new("/runtime")),
            Path::new("/runtime/verifier-node-instance-7")
        );
        assert_eq!(
            HostedProcessScope::VerifierExecution(7).private_home(Path::new("/runtime")),
            Path::new("/runtime/verifier-execution-7")
        );
        assert!(
            pool.identity(HostedProcessScope::VerifierExecution(0))
                .is_err()
        );
    }
}
