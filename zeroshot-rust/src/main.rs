use std::path::PathBuf;

use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use openengine_cluster_server::stdio::serve_stdio;
use thiserror::Error;
use tokio::sync::watch;

use zeroshot_engine::cluster_ledger::{LedgerError, OwnerId, ResourceId};
use zeroshot_engine::{
    binding_for_route, NativeAdmissionOpenError, ProductionNativeBackendFactory,
    NATIVE_FENCE_RENEW_INTERVAL_MS, NATIVE_FENCE_TTL_MS,
};

#[derive(Debug, Error)]
enum ProcessError {
    #[error(
        "usage: zeroshot-rust serve-stdio --state-dir <absolute-directory> --cluster-id <bounded-id>"
    )]
    Usage,
    #[error("state directory must be an absolute path")]
    RelativeStateDirectory,
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
}

struct ServeArgs {
    state_dir: PathBuf,
    cluster_id: ResourceId,
}

fn parse_args() -> Result<ServeArgs, ProcessError> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let [command, state_flag, state_dir, cluster_flag, cluster_id] = args.as_slice() else {
        return Err(ProcessError::Usage);
    };
    if command != "serve-stdio" || state_flag != "--state-dir" || cluster_flag != "--cluster-id" {
        return Err(ProcessError::Usage);
    }
    let state_dir = PathBuf::from(state_dir);
    if !state_dir.is_absolute() {
        return Err(ProcessError::RelativeStateDirectory);
    }
    let cluster_id = cluster_id.to_str().ok_or(ProcessError::Usage)?;
    let cluster_id = ResourceId::new(cluster_id).map_err(|_| ProcessError::Usage)?;
    Ok(ServeArgs {
        state_dir,
        cluster_id,
    })
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
    let args = parse_args()?;
    let factory =
        ProductionNativeBackendFactory::open(&args.state_dir, args.cluster_id, process_owner()?)
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
