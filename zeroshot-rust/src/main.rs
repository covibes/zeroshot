use std::path::PathBuf;

use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use openengine_cluster_server::stdio::serve_stdio;
use thiserror::Error;
use tokio::sync::watch;

use zeroshot_engine::cluster_ledger::{LedgerError, OwnerId, ResourceId};
use zeroshot_engine::{
    binding_for_route, run_deterministic_worker, run_greeting_validator, NativeAdmissionOpenError,
    ProductionNativeBackendFactory, NATIVE_FENCE_RENEW_INTERVAL_MS, NATIVE_FENCE_TTL_MS,
    NATIVE_VALIDATOR_MODE, NATIVE_WORKER_MODE,
};

#[derive(Debug, Error)]
enum ProcessError {
    #[error("invalid arguments for the native stdio entrypoint")]
    Usage,
    #[error("state directory must be an absolute path")]
    RelativeStateDirectory,
    #[error("workspace must be a canonical absolute directory")]
    InvalidWorkspace,
    #[error("process identity randomness is unavailable")]
    Randomness,
    #[error(transparent)]
    Admission(#[from] NativeAdmissionOpenError),
    #[error("native cluster transport failed: {0}")]
    Transport(#[from] std::io::Error),
    #[error("native cluster lease failed: {0}")]
    Lease(#[from] LedgerError),
    #[error("native cluster lease renewal task failed")]
    RenewalTask,
    #[error("native validation failed")]
    Validation,
}

struct ServeArgs {
    state_dir: PathBuf,
    cluster_id: ResourceId,
    workspace: PathBuf,
}

enum ProcessMode {
    Serve(ServeArgs),
    DeterministicWorker { effect_id: String },
    GreetingValidator,
}

fn parse_args() -> Result<ProcessMode, ProcessError> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Some(effect_id) = parse_worker_args(&args)? {
        return Ok(ProcessMode::DeterministicWorker { effect_id });
    }
    if args.as_slice() == [NATIVE_VALIDATOR_MODE] {
        return Ok(ProcessMode::GreetingValidator);
    }
    parse_serve_args(&args).map(ProcessMode::Serve)
}

fn parse_worker_args(args: &[std::ffi::OsString]) -> Result<Option<String>, ProcessError> {
    let [command, effect_flag, effect_id] = args else {
        return Ok(None);
    };
    if command != NATIVE_WORKER_MODE || effect_flag != "--effect-id" {
        return Ok(None);
    }
    let effect_id = effect_id.to_str().ok_or(ProcessError::Usage)?;
    let valid = effect_id.len() == 64
        && effect_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid {
        return Err(ProcessError::Usage);
    }
    Ok(Some(effect_id.to_owned()))
}

fn parse_serve_args(args: &[std::ffi::OsString]) -> Result<ServeArgs, ProcessError> {
    let (state_dir, cluster_id, workspace) = serve_values(args)?;
    let state_dir = PathBuf::from(state_dir);
    if !state_dir.is_absolute() {
        return Err(ProcessError::RelativeStateDirectory);
    }
    let cluster_id = cluster_id.to_str().ok_or(ProcessError::Usage)?;
    let cluster_id = ResourceId::new(cluster_id).map_err(|_| ProcessError::Usage)?;
    let workspace = canonical_workspace(workspace)?;
    Ok(ServeArgs {
        state_dir,
        cluster_id,
        workspace,
    })
}

fn serve_values(
    args: &[std::ffi::OsString],
) -> Result<(&std::ffi::OsStr, &std::ffi::OsStr, &std::ffi::OsStr), ProcessError> {
    let [
        command,
        state_flag,
        state_dir,
        cluster_flag,
        cluster_id,
        workspace_flag,
        workspace,
    ] = args
    else {
        return Err(ProcessError::Usage);
    };
    let actual = (
        command.as_os_str(),
        state_flag.as_os_str(),
        cluster_flag.as_os_str(),
        workspace_flag.as_os_str(),
    );
    let expected = (
        std::ffi::OsStr::new("serve-stdio"),
        std::ffi::OsStr::new("--state-dir"),
        std::ffi::OsStr::new("--cluster-id"),
        std::ffi::OsStr::new("--workspace"),
    );
    if actual != expected {
        return Err(ProcessError::Usage);
    }
    Ok((state_dir, cluster_id, workspace))
}

fn canonical_workspace(workspace: &std::ffi::OsStr) -> Result<PathBuf, ProcessError> {
    let supplied_workspace = PathBuf::from(workspace);
    if !supplied_workspace.is_absolute() {
        return Err(ProcessError::InvalidWorkspace);
    }
    let workspace =
        std::fs::canonicalize(&supplied_workspace).map_err(|_| ProcessError::InvalidWorkspace)?;
    if workspace != supplied_workspace {
        return Err(ProcessError::InvalidWorkspace);
    }
    Ok(workspace)
}

fn process_owner() -> Result<OwnerId, ProcessError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| ProcessError::Randomness)?;
    let mut suffix = String::with_capacity(random.len() * 2);
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut suffix, "{byte:02x}").expect("writing to a String cannot fail");
    }
    OwnerId::new(format!("process-{}-{suffix}", std::process::id()))
        .map_err(|_| ProcessError::Randomness)
}

async fn run() -> Result<(), ProcessError> {
    match parse_args()? {
        ProcessMode::Serve(args) => serve(args).await,
        ProcessMode::DeterministicWorker { effect_id } => {
            run_deterministic_worker(&effect_id)?;
            Ok(())
        }
        ProcessMode::GreetingValidator => {
            run_greeting_validator().map_err(|_| ProcessError::Validation)
        }
    }
}

async fn serve(args: ServeArgs) -> Result<(), ProcessError> {
    let factory = ProductionNativeBackendFactory::open(
        &args.state_dir,
        args.cluster_id,
        process_owner()?,
        &args.workspace,
    )
    .await?;

    let renewal_factory = factory.clone();
    let renewal_ledger = factory.ledger().clone();
    let (stop_renewal, mut renewal_stop) = watch::channel(false);
    let mut renewal_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = renewal_stop.changed() => {
                    if changed.is_err() || *renewal_stop.borrow() {
                        return Ok(());
                    }
                }
                () = tokio::time::sleep(std::time::Duration::from_millis(
                    NATIVE_FENCE_RENEW_INTERVAL_MS,
                )) => {
                    if let Err(error) = renewal_ledger.renew_fence(NATIVE_FENCE_TTL_MS).await {
                        renewal_factory.mark_lease_lost();
                        return Err(error);
                    }
                }
            }
        }
    });

    if let Err(error) = factory.recover_pending().await {
        let _ = stop_renewal.send(true);
        let _ = renewal_task.await;
        let _ = factory.ledger().release_fence().await;
        return Err(error.into());
    }

    let identity = ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("local-native"),
        tenant: TenantId::new("local-native"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    });
    let binding = binding_for_route(&factory, identity);
    let server = serve_stdio(binding);
    tokio::pin!(server);
    tokio::select! {
        server_result = &mut server => {
            let _ = stop_renewal.send(true);
            match renewal_task.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    factory.mark_lease_lost();
                    return Err(error.into());
                }
                Err(_) => {
                    factory.mark_lease_lost();
                    return Err(ProcessError::RenewalTask);
                }
            }
            factory.ledger().release_fence().await?;
            server_result?;
            Ok(())
        }
        renewal_result = &mut renewal_task => {
            factory.mark_lease_lost();
            match renewal_result {
                Ok(Err(error)) => Err(error.into()),
                Ok(Ok(())) | Err(_) => Err(ProcessError::RenewalTask),
            }
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("zeroshot-rust: {error}");
        std::process::exit(1);
    }
}
