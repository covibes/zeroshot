//! Engine-owned test doubles for exercising native credential resolution without a real source,
//! clock, or cancellation signal. Shipped in the product for external contract tests, mirroring
//! [`crate::workspace_lease::fake`].

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use super::resolver::{CancellationSignal, CredentialClock};
use super::source::{
    CredentialSourceFault, CredentialSourceKind, CredentialSourcePort, CredentialSourceRef,
};
use super::SecretMaterial;

/// A scripted source: each locator maps to a scripted outcome. Counts every `load` call and
/// every time a material it minted was actually released (zeroized), so tests can observe
/// release-exactly-once without any other access to the owning lease.
pub struct FakeCredentialSource {
    kind: CredentialSourceKind,
    scripted: BTreeMap<String, Result<Option<Vec<u8>>, CredentialSourceFault>>,
    loads: AtomicUsize,
    releases: Arc<AtomicUsize>,
}

impl FakeCredentialSource {
    #[must_use]
    pub fn new(
        kind: CredentialSourceKind,
        scripted: BTreeMap<String, Result<Option<Vec<u8>>, CredentialSourceFault>>,
    ) -> Self {
        Self {
            kind,
            scripted,
            loads: AtomicUsize::new(0),
            releases: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[must_use]
    pub fn load_count(&self) -> usize {
        self.loads.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn release_count(&self) -> usize {
        self.releases.load(Ordering::SeqCst)
    }
}

impl CredentialSourcePort for FakeCredentialSource {
    fn kind(&self) -> CredentialSourceKind {
        self.kind
    }

    fn load(
        &self,
        source: &CredentialSourceRef,
    ) -> Result<Option<SecretMaterial>, CredentialSourceFault> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        match self.scripted.get(source.locator()) {
            Some(Ok(Some(bytes))) => Ok(Some(
                SecretMaterial::new(bytes.clone())
                    .expect("fake secret material fits the bound")
                    .with_release_hook(self.releases.clone()),
            )),
            Some(Ok(None)) => Ok(None),
            Some(Err(fault)) => Err(*fault),
            None => Ok(None),
        }
    }
}

/// A controllable clock starting at `now_ms`, advanced explicitly by tests.
#[derive(Default)]
pub struct FakeCredentialClock {
    now_ms: AtomicU64,
}

impl FakeCredentialClock {
    #[must_use]
    pub fn new(now_ms: u64) -> Self {
        Self {
            now_ms: AtomicU64::new(now_ms),
        }
    }

    pub fn advance(&self, delta_ms: u64) {
        self.now_ms.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

impl CredentialClock for FakeCredentialClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}

/// A controllable cancellation signal, uncancelled until [`FakeCancellation::cancel`] is called.
#[derive(Default)]
pub struct FakeCancellation {
    cancelled: AtomicBool,
}

impl FakeCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

impl CancellationSignal for FakeCancellation {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}
