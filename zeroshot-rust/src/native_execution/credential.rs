use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::execution::process::ProcessSecretEnvironment;
use crate::native_credentials::{
    AcquisitionBudget, CancellationSignal, CredentialClock, CredentialRequirementName,
    CredentialSourceKind, CredentialSourcePolicy, CredentialSourceRef, CredentialSourceRegistry,
    EnvSnapshotCredentialSource, NativeCredentialResolver,
};
use crate::observability::NoopObservationSink;

const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
static CREDENTIAL_CLOCK: SystemCredentialClock = SystemCredentialClock;
static CREDENTIAL_OBSERVATIONS: NoopObservationSink = NoopObservationSink;
static NEVER_CANCELLED: NeverCancelled = NeverCancelled;

pub(super) struct OpenAiCredential {
    requirement: CredentialRequirementName,
    resolver: NativeCredentialResolver<'static>,
}

impl OpenAiCredential {
    pub(super) fn new(
        requirement: CredentialRequirementName,
        api_key: Option<String>,
    ) -> Result<Self, ()> {
        let source = CredentialSourceRef::new(CredentialSourceKind::Environment, OPENAI_API_KEY)
            .map_err(|_| ())?;
        let policy =
            CredentialSourcePolicy::new(BTreeMap::from([(requirement.clone(), vec![source])]))
                .map_err(|_| ())?;
        let snapshot = api_key
            .map(|value| BTreeMap::from([(OPENAI_API_KEY.to_owned(), value)]))
            .unwrap_or_default();
        let registry = CredentialSourceRegistry::new()
            .register(Arc::new(EnvSnapshotCredentialSource::new(snapshot)))
            .map_err(|_| ())?;
        Ok(Self {
            requirement,
            resolver: NativeCredentialResolver::new(
                policy,
                registry,
                &CREDENTIAL_CLOCK,
                &CREDENTIAL_OBSERVATIONS,
            ),
        })
    }

    pub(super) fn acquire(&self, timeout_ms: u64) -> Result<ProcessSecretEnvironment, ()> {
        let now = CREDENTIAL_CLOCK.now_ms();
        let budget =
            AcquisitionBudget::new(now.saturating_add(timeout_ms), timeout_ms, &NEVER_CANCELLED);
        self.resolver
            .with_requirement_material(&self.requirement, &budget, |material| {
                ProcessSecretEnvironment::single(OPENAI_API_KEY, material)
            })
            .map_err(|_| ())?
            .map_err(|_| ())
    }

    pub(super) fn validate(&self, timeout_ms: u64) -> Result<(), ()> {
        drop(self.acquire(timeout_ms)?);
        Ok(())
    }

    pub(super) fn probe_placeholder() -> ProcessSecretEnvironment {
        ProcessSecretEnvironment::single(OPENAI_API_KEY, b"zeroshot-local-model-probe")
            .expect("fixed probe credential is valid")
    }
}

struct SystemCredentialClock;

impl CredentialClock for SystemCredentialClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

struct NeverCancelled;

impl CancellationSignal for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
}
