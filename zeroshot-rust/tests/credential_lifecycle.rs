//! Expiry, cancellation, deadline, and exactly-once release coverage for native credential
//! leases, plus proof that the secret fixture never reaches any safe surface.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use zeroshot_engine::native_credentials::fake::{
    FakeCancellation, FakeCredentialClock, FakeCredentialSource,
};
use zeroshot_engine::native_credentials::{
    AcquisitionBudget, CancellationSignal, CredentialCapability, CredentialClock,
    CredentialFaultKind, CredentialRequirementSet, CredentialSourceKind, CredentialSourcePolicy,
    CredentialSourceRegistry, NativeCredentialResolver,
};
use zeroshot_engine::native_settings::{
    CredentialRequirementName as SettingsCredentialRequirementName, NativeSettingsSchema,
    NativeSettingsSchemaSpec,
};
use zeroshot_engine::observability::{InMemoryObservationSink, NoopObservationSink};
use zeroshot_engine::worker_catalog::worker_catalog;

#[path = "support/credential_fixtures.rs"]
mod fixtures;
use fixtures::{claude_manifest, claude_requirements, requirement, source_ref, ResolverFixture};

const SECRET_FIXTURE: &str = "ZS-SECRET-FIXTURE-e7c1";

/// Admits "claude-auth" (from the catalog) and "zzz-second-auth" (from settings), which sorts
/// after "claude-auth" so acquisition order is deterministic across the two requirements.
fn two_requirements() -> CredentialRequirementSet {
    let mut extra = std::collections::BTreeSet::new();
    extra.insert(
        SettingsCredentialRequirementName::new("zzz-second-auth")
            .expect("test settings requirement"),
    );
    let settings = NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        credential_requirements: extra,
        ..NativeSettingsSchemaSpec::default()
    })
    .expect("valid native settings schema");
    CredentialRequirementSet::from_admitted(&claude_manifest(), worker_catalog(), &settings)
        .expect("valid requirement set")
}

fn single_source_fixture(
    locator: &str,
    bytes: &[u8],
) -> (
    Arc<FakeCredentialSource>,
    CredentialSourceRegistry,
    CredentialSourcePolicy,
) {
    let source = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([(locator.to_owned(), Ok(Some(bytes.to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![source_ref(CredentialSourceKind::Environment, locator)],
    )]))
    .unwrap();
    (source, registry, policy)
}

/// A clock whose `now_ms` advances by `step_ms` on every call, so a test can force a deadline to
/// elapse deterministically between two requirement resolutions within one `acquire` call.
struct TickingClock {
    calls: AtomicU64,
    start_ms: u64,
    step_ms: u64,
}

impl TickingClock {
    fn new(start_ms: u64, step_ms: u64) -> Self {
        Self {
            calls: AtomicU64::new(0),
            start_ms,
            step_ms,
        }
    }
}

impl CredentialClock for TickingClock {
    fn now_ms(&self) -> u64 {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        self.start_ms + call * self.step_ms
    }
}

/// A cancellation signal that reports uncancelled on its first check and cancelled from the
/// second check onward, so a test can force cancellation deterministically between two
/// requirement resolutions within one `acquire` call.
struct CancelFromSecondCheck {
    calls: AtomicU64,
}

impl CancelFromSecondCheck {
    fn new() -> Self {
        Self {
            calls: AtomicU64::new(0),
        }
    }
}

impl CancellationSignal for CancelFromSecondCheck {
    fn is_cancelled(&self) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst) >= 1
    }
}

#[test]
fn material_access_fails_expired_after_the_ttl_elapses() {
    let (source, registry, policy) = single_source_fixture("claude-auth", b"secret");
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &fixture.cancel);

    let leases = resolver
        .acquire(&requirements, &budget)
        .expect("acquire must succeed");
    let capability = leases
        .capability(&requirement("claude-auth"))
        .expect("capability must exist");
    capability
        .with_material(<[u8]>::len)
        .expect("material must be readable before expiry");

    fixture.clock.advance(1_001);
    let error = capability
        .with_material(<[u8]>::len)
        .expect_err("material access must fail once the ttl elapses");
    assert_eq!(error.kind(), CredentialFaultKind::Expired);
    let _ = source;
}

#[test]
fn deadline_exceeded_mid_acquisition_releases_every_already_acquired_lease_exactly_once() {
    let source_first = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_first.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![source_ref(CredentialSourceKind::Environment, "claude-auth")],
    )]))
    .unwrap();
    let clock = TickingClock::new(0, 100);
    let cancel = FakeCancellation::default();
    let observations = NoopObservationSink;
    let resolver = NativeCredentialResolver::new(policy, registry, &clock, &observations);
    let requirements = two_requirements();
    let budget = AcquisitionBudget::new(150, 1_000, &cancel);

    let error = resolver
        .acquire(&requirements, &budget)
        .expect_err("the deadline must elapse before the second requirement resolves");
    assert_eq!(error.kind(), CredentialFaultKind::DeadlineExceeded);
    assert_eq!(
        source_first.release_count(),
        1,
        "the lease acquired for the first requirement must be released exactly once"
    );
}

#[test]
fn cancellation_mid_acquisition_releases_every_already_acquired_lease_exactly_once() {
    let source_first = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_first.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![source_ref(CredentialSourceKind::Environment, "claude-auth")],
    )]))
    .unwrap();
    let clock = FakeCredentialClock::new(0);
    let cancel = CancelFromSecondCheck::new();
    let observations = NoopObservationSink;
    let resolver = NativeCredentialResolver::new(policy, registry, &clock, &observations);
    let requirements = two_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &cancel);

    let error = resolver
        .acquire(&requirements, &budget)
        .expect_err("cancellation must be observed before the second requirement resolves");
    assert_eq!(error.kind(), CredentialFaultKind::Cancelled);
    assert_eq!(
        source_first.release_count(),
        1,
        "the lease acquired for the first requirement must be released exactly once"
    );
}

#[test]
fn a_mid_set_source_error_fully_releases_the_partial_acquisition_exactly_once() {
    let source_first = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret".to_vec())))]),
    ));
    let source_second = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::HelperCommand,
        BTreeMap::from([(
            "zzz-second-auth".to_owned(),
            Err(zeroshot_engine::native_credentials::CredentialSourceFault::Unavailable),
        )]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_first.clone())
        .unwrap()
        .register(source_second.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([
        (
            requirement("claude-auth"),
            vec![source_ref(CredentialSourceKind::Environment, "claude-auth")],
        ),
        (
            requirement("zzz-second-auth"),
            vec![source_ref(
                CredentialSourceKind::HelperCommand,
                "zzz-second-auth",
            )],
        ),
    ]))
    .unwrap();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = two_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &fixture.cancel);

    let error = resolver
        .acquire(&requirements, &budget)
        .expect_err("a hard source error on the second requirement must fail the acquisition");
    assert_eq!(error.kind(), CredentialFaultKind::Missing);
    assert_eq!(
        source_first.release_count(),
        1,
        "the partially acquired first lease must be released exactly once"
    );
}

#[test]
fn release_all_followed_by_drop_still_counts_one_release() {
    let (source, registry, policy) = single_source_fixture("claude-auth", b"secret");
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &fixture.cancel);

    {
        let leases = resolver
            .acquire(&requirements, &budget)
            .expect("acquire must succeed");
        assert_eq!(leases.release_all(), 1);
    }

    assert_eq!(source.release_count(), 1);
}

#[test]
fn four_threads_racing_release_on_one_lease_count_exactly_one() {
    let (source, registry, policy) = single_source_fixture("claude-auth", b"secret");
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &fixture.cancel);
    let leases = resolver
        .acquire(&requirements, &budget)
        .expect("acquire must succeed");

    let total: usize = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| leases.release_all()))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .sum()
    });

    assert_eq!(total, 1);
    assert_eq!(source.release_count(), 1);
}

struct FakeCliDriver;

impl FakeCliDriver {
    fn invoke(&self, capability: &CredentialCapability<'_>) -> usize {
        capability
            .with_material(<[u8]>::len)
            .expect("driver must read material through the capability")
    }
}

struct FakeSourceProvider;

impl FakeSourceProvider {
    fn authenticate(&self, capability: &CredentialCapability<'_>) -> usize {
        capability
            .with_material(<[u8]>::len)
            .expect("source provider must read material through the capability")
    }
}

struct FakeIssueProvider;

impl FakeIssueProvider {
    fn authenticate(&self, capability: &CredentialCapability<'_>) -> usize {
        capability
            .with_material(<[u8]>::len)
            .expect("issue provider must read material through the capability")
    }
}

#[test]
fn fake_driver_source_and_issue_consumers_obtain_bytes_only_inside_with_material() {
    let (_source, registry, policy) = single_source_fixture("claude-auth", b"secret");
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &fixture.cancel);
    let leases = resolver
        .acquire(&requirements, &budget)
        .expect("acquire must succeed");
    let capability = leases
        .capability(&requirement("claude-auth"))
        .expect("capability must exist");

    assert_eq!(FakeCliDriver.invoke(&capability), 6);
    assert_eq!(FakeSourceProvider.authenticate(&capability), 6);
    assert_eq!(FakeIssueProvider.authenticate(&capability), 6);
}

#[test]
fn secret_fixture_never_appears_in_any_safe_surface() {
    let sink = InMemoryObservationSink::default();
    let (_source, registry, policy) =
        single_source_fixture(SECRET_FIXTURE, SECRET_FIXTURE.as_bytes());
    let clock = FakeCredentialClock::new(0);
    let cancel = FakeCancellation::default();
    let resolver = NativeCredentialResolver::new(policy, registry, &clock, &sink);
    let requirements = claude_requirements();
    let budget = AcquisitionBudget::new(10_000, 1_000, &cancel);

    let leases = resolver
        .acquire(&requirements, &budget)
        .expect("acquire must succeed");
    let capability = leases
        .capability(&requirement("claude-auth"))
        .expect("capability must exist");

    assert!(!format!("{leases:?}").contains(SECRET_FIXTURE));
    assert!(!format!("{capability:?}").contains(SECRET_FIXTURE));
    assert!(!format!("{:?}", capability.identity()).contains(SECRET_FIXTURE));
    assert!(!format!("{:?}", capability.digest()).contains(SECRET_FIXTURE));
    assert!(
        !serde_json::to_string(&requirements)
            .unwrap()
            .contains(SECRET_FIXTURE)
    );

    clock.advance(1_001);
    let fault = capability
        .with_material(<[u8]>::len)
        .expect_err("access past the ttl must fail");
    assert!(!format!("{fault:?}").contains(SECRET_FIXTURE));
    let encoded = fault
        .engine_fault()
        .encode_json()
        .expect("a typed engine fault must always encode");
    assert!(!String::from_utf8(encoded).unwrap().contains(SECRET_FIXTURE));

    drop(leases);
    let snapshot = sink.snapshot();
    assert!(!format!("{snapshot:?}").contains(SECRET_FIXTURE));
}
