use std::fmt;
use std::fmt::Write as _;
use std::sync::atomic::{compiler_fence, AtomicUsize, Ordering};
use std::sync::Arc;

use sha2::{Digest as _, Sha256};

/// See the comment on [`super::AdmissionManifestDigest`]: `type` aliases (not `use`) for
/// macro-declared cross-module types keep source-level import checks able to resolve them.
type CredentialRequirementName = super::CredentialRequirementName;
type CredentialDigest = super::CredentialDigest;

pub(crate) const MAX_SECRET_MATERIAL_BYTES: usize = 8192;

/// Non-serializable, non-cloneable secret bytes. Zeroized on drop.
pub struct SecretMaterial {
    bytes: Vec<u8>,
    release_hook: Option<Arc<AtomicUsize>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SecretMaterialTooLong;

impl SecretMaterial {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self, SecretMaterialTooLong> {
        if bytes.len() > MAX_SECRET_MATERIAL_BYTES {
            return Err(SecretMaterialTooLong);
        }
        Ok(Self {
            bytes,
            release_hook: None,
        })
    }

    /// Test-support hook: increments `hook` exactly once, when this material is actually dropped
    /// (zeroized), so external tests can observe release-exactly-once without any other access
    /// to the owning lease.
    pub(crate) fn with_release_hook(mut self, hook: Arc<AtomicUsize>) -> Self {
        self.release_hook = Some(hook);
        self
    }

    pub(crate) fn expose(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn digest(&self, requirement: &CredentialRequirementName) -> CredentialDigest {
        let mut hasher = Sha256::new();
        hasher.update(b"zeroshot.credential.v1\0");
        hasher.update(requirement.as_str().as_bytes());
        hasher.update([0u8]);
        hasher.update(&self.bytes);
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            write!(&mut hex, "{byte:02x}").expect("writing to a string cannot fail");
        }
        CredentialDigest::new(hex).expect("sha256 hex digest is always well-formed")
    }
}

impl fmt::Debug for SecretMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretMaterial(<redacted>)")
    }
}

impl Drop for SecretMaterial {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            unsafe {
                std::ptr::write_volatile(byte, 0);
            }
        }
        compiler_fence(Ordering::SeqCst);
        if let Some(hook) = &self.release_hook {
            hook.fetch_add(1, Ordering::SeqCst);
        }
    }
}
