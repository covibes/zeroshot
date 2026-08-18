use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudRunReceipt {
    pub run_id: RunId,
    pub deduped: bool,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("capsule allocation is unavailable")]
pub struct CapsuleAllocationUnavailable;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("exclusive controller authority is unavailable")]
pub struct ControllerClaimUnavailable;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("capsule destruction could not be confirmed")]
pub struct CapsuleCleanupUnavailable;

/// Opaque acknowledgement from allocator authority that the disposable runtime no longer exists.
///
/// For a live capsule this follows successful destruction. After an observed connection loss the
/// same receipt confirms that allocator authority observes the capsule absent; loss therefore
/// cannot strand an otherwise terminalizable run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapsuleDestroyed {
    _closed: (),
}

impl CapsuleDestroyed {
    #[must_use]
    pub const fn confirmed() -> Self {
        Self { _closed: () }
    }
}

#[async_trait]
pub trait CapsuleCleanup: Send + Sync {
    async fn destroy_or_confirm_absent(
        &self,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable>;
}

pub struct AllocatedCapsule {
    pub runner: Arc<dyn NodeRunner>,
    pub loss: watch::Receiver<bool>,
    pub cleanup: Arc<dyn CapsuleCleanup>,
}

/// Allocator-owned proof that this is the only active controller for one run.
///
/// The allocator must keep the claim exclusive until the last reference is dropped. This is a
/// hosting authority contract, not a product-local distributed lease implementation.
pub trait ExclusiveControllerClaim: Send + Sync {}

#[async_trait]
pub trait CapsuleAllocator: Send + Sync {
    /// Acquires exclusive controller authority for the supplied public run identity.
    async fn claim_controller(
        &self,
        run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable>;

    /// An error guarantees that allocation left no surviving capsule. Once allocation succeeds,
    /// cleanup authority is carried by [`AllocatedCapsule`].
    async fn allocate(
        &self,
        run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable>;

    /// Destroys an allocator-known capsule for a controller-reconstructed run, or confirms that
    /// it is already absent. This operation never allocates a replacement.
    async fn destroy_or_confirm_absent(
        &self,
        run_id: &RunId,
        exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable>;
}
