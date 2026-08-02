//! Precedence, closed-world admission, and determinism coverage for native credential
//! resolution.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use zeroshot_engine::native_credentials::fake::{FakeCancellation, FakeCredentialSource};
use zeroshot_engine::native_credentials::{
    AcquisitionBudget, CredentialFaultKind, CredentialRequirementSet, CredentialSourceFault,
    CredentialSourceKind, CredentialSourcePolicy, CredentialSourceRegistry,
};
use zeroshot_engine::native_settings::{
    CredentialRequirementName as SettingsCredentialRequirementName, NativeSettingsSchema,
    NativeSettingsSchemaSpec,
};
use zeroshot_engine::worker_catalog::{
    worker_catalog, CredentialRequirementName, WorkerCatalog, WorkerCatalogSpec,
};

#[path = "support/credential_fixtures.rs"]
mod fixtures;
use fixtures::{claude_manifest, claude_requirements, requirement, source_ref, ResolverFixture};

fn different_digest_catalog() -> WorkerCatalog {
    WorkerCatalog::new(WorkerCatalogSpec {
        version: 2,
        default_provider: worker_catalog().default_provider_id().clone(),
        providers: worker_catalog().providers().to_vec(),
    })
    .expect("alternate catalog must be valid")
}

fn budget(cancel: &FakeCancellation) -> AcquisitionBudget<'_> {
    AcquisitionBudget::new(10_000, 5_000, cancel)
}

#[test]
fn first_declared_source_wins() {
    let source_a = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret-a".to_vec())))]),
    ));
    let source_b = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::HelperCommand,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret-b".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_a.clone())
        .unwrap()
        .register(source_b.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![
            source_ref(CredentialSourceKind::Environment, "claude-auth"),
            source_ref(CredentialSourceKind::HelperCommand, "claude-auth"),
        ],
    )]))
    .unwrap();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();

    let leases = resolver
        .acquire(&requirements, &budget(&fixture.cancel))
        .expect("acquire must succeed");
    leases
        .capability(&requirement("claude-auth"))
        .expect("capability must exist")
        .with_material(|bytes| assert_eq!(bytes, b"secret-a"))
        .expect("material must be readable");

    assert_eq!(source_a.load_count(), 1);
    assert_eq!(source_b.load_count(), 0);
}

#[test]
fn second_source_is_consulted_only_after_the_first_is_absent() {
    let source_a = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::new(),
    ));
    let source_b = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::HelperCommand,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret-b".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_a.clone())
        .unwrap()
        .register(source_b.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![
            source_ref(CredentialSourceKind::Environment, "claude-auth"),
            source_ref(CredentialSourceKind::HelperCommand, "claude-auth"),
        ],
    )]))
    .unwrap();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();

    let leases = resolver
        .acquire(&requirements, &budget(&fixture.cancel))
        .expect("acquire must succeed");
    leases
        .capability(&requirement("claude-auth"))
        .expect("capability must exist")
        .with_material(|bytes| assert_eq!(bytes, b"secret-b"))
        .expect("material must be readable");

    assert_eq!(source_a.load_count(), 1);
    assert_eq!(source_b.load_count(), 1);
}

#[test]
fn hard_error_from_first_source_does_not_fall_through() {
    let source_a = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([(
            "claude-auth".to_owned(),
            Err(CredentialSourceFault::Unavailable),
        )]),
    ));
    let source_b = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::HelperCommand,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret-b".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_a.clone())
        .unwrap()
        .register(source_b.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![
            source_ref(CredentialSourceKind::Environment, "claude-auth"),
            source_ref(CredentialSourceKind::HelperCommand, "claude-auth"),
        ],
    )]))
    .unwrap();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();

    let error = resolver
        .acquire(&requirements, &budget(&fixture.cancel))
        .expect_err("a hard source error must fail closed");
    assert_eq!(error.kind(), CredentialFaultKind::Missing);
    assert_eq!(source_a.load_count(), 1);
    assert_eq!(source_b.load_count(), 0);
}

#[test]
fn duplicate_source_ref_in_one_requirement_is_rejected() {
    let error = CredentialSourcePolicy::new(BTreeMap::from([(
        requirement("claude-auth"),
        vec![
            source_ref(CredentialSourceKind::Environment, "same"),
            source_ref(CredentialSourceKind::Environment, "same"),
        ],
    )]))
    .unwrap_err();
    assert_eq!(error.reason(), "duplicate credential source");
}

#[test]
fn duplicate_requirement_keys_collapse_deterministically() {
    let pairs = vec![
        (
            requirement("claude-auth"),
            vec![source_ref(CredentialSourceKind::Environment, "first")],
        ),
        (
            requirement("claude-auth"),
            vec![source_ref(CredentialSourceKind::Environment, "second")],
        ),
    ];
    let map: BTreeMap<_, _> = pairs.into_iter().collect();
    assert_eq!(map.len(), 1, "a BTreeMap collapses duplicate keys");
    let policy = CredentialSourcePolicy::new(map).unwrap();

    let source = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([("second".to_owned(), Ok(Some(b"secret".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source.clone())
        .unwrap();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();

    resolver
        .acquire(&requirements, &budget(&fixture.cancel))
        .expect("the surviving entry (\"second\") must resolve deterministically");
}

#[test]
fn requirement_absent_from_policy_is_missing() {
    let policy = CredentialSourcePolicy::new(BTreeMap::new()).unwrap();
    let registry = CredentialSourceRegistry::new();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();

    let error = resolver
        .acquire(&requirements, &budget(&fixture.cancel))
        .expect_err("an undeclared requirement must fail closed");
    assert_eq!(error.kind(), CredentialFaultKind::Missing);
}

#[test]
fn requirement_outside_the_admitted_set_is_a_closed_world() {
    let source_claude = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::Environment,
        BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret".to_vec())))]),
    ));
    let source_beta = Arc::new(FakeCredentialSource::new(
        CredentialSourceKind::HelperCommand,
        BTreeMap::from([("beta-auth".to_owned(), Ok(Some(b"beta".to_vec())))]),
    ));
    let registry = CredentialSourceRegistry::new()
        .register(source_claude.clone())
        .unwrap()
        .register(source_beta.clone())
        .unwrap();
    let policy = CredentialSourcePolicy::new(BTreeMap::from([
        (
            requirement("claude-auth"),
            vec![source_ref(CredentialSourceKind::Environment, "claude-auth")],
        ),
        (
            requirement("beta-auth"),
            vec![source_ref(CredentialSourceKind::HelperCommand, "beta-auth")],
        ),
    ]))
    .unwrap();
    let fixture = ResolverFixture::new();
    let resolver = fixture.resolver(policy, registry);
    let requirements = claude_requirements();

    let leases = resolver
        .acquire(&requirements, &budget(&fixture.cancel))
        .expect("acquire must succeed");
    assert_eq!(source_claude.load_count(), 1);
    assert_eq!(
        source_beta.load_count(),
        0,
        "a requirement outside the admitted set must never be loaded"
    );

    let error = leases
        .capability(&requirement("beta-auth"))
        .expect_err("an undeclared requirement must be rejected");
    assert_eq!(error.kind(), CredentialFaultKind::Undeclared);
}

#[test]
fn source_faults_map_to_their_typed_kinds() {
    let cases = [
        (
            CredentialSourceFault::PermissionDenied,
            CredentialFaultKind::PermissionDenied,
        ),
        (
            CredentialSourceFault::AuthenticationRequired,
            CredentialFaultKind::AuthenticationRequired,
        ),
        (
            CredentialSourceFault::Malformed,
            CredentialFaultKind::Malformed,
        ),
        (
            CredentialSourceFault::Unavailable,
            CredentialFaultKind::Missing,
        ),
    ];
    for (source_fault, expected_kind) in cases {
        let source = Arc::new(FakeCredentialSource::new(
            CredentialSourceKind::Environment,
            BTreeMap::from([("claude-auth".to_owned(), Err(source_fault))]),
        ));
        let registry = CredentialSourceRegistry::new()
            .register(source.clone())
            .unwrap();
        let policy = CredentialSourcePolicy::new(BTreeMap::from([(
            requirement("claude-auth"),
            vec![source_ref(CredentialSourceKind::Environment, "claude-auth")],
        )]))
        .unwrap();
        let fixture = ResolverFixture::new();
        let resolver = fixture.resolver(policy, registry);
        let requirements = claude_requirements();

        let error = resolver
            .acquire(&requirements, &budget(&fixture.cancel))
            .expect_err("a scripted source fault must fail acquisition");
        assert_eq!(error.kind(), expected_kind);
    }
}

#[test]
fn from_admitted_rejects_a_mismatched_catalog_digest() {
    let manifest = claude_manifest();
    let mismatched = different_digest_catalog();
    let error = CredentialRequirementSet::from_admitted(
        &manifest,
        &mismatched,
        &NativeSettingsSchema::default(),
    )
    .unwrap_err();
    assert_eq!(error.field(), "worker catalog");
}

#[test]
fn admitted_set_unions_catalog_and_settings_requirements() {
    let manifest = claude_manifest();
    let mut extra = BTreeSet::new();
    extra.insert(
        SettingsCredentialRequirementName::new("audit-log").expect("test settings requirement"),
    );
    let settings = NativeSettingsSchema::new(NativeSettingsSchemaSpec {
        credential_requirements: extra,
        ..NativeSettingsSchemaSpec::default()
    })
    .expect("valid native settings schema");

    let requirements =
        CredentialRequirementSet::from_admitted(&manifest, worker_catalog(), &settings)
            .expect("valid requirement set");
    let names: BTreeSet<&str> = requirements
        .requirements()
        .iter()
        .map(CredentialRequirementName::as_str)
        .collect();
    assert_eq!(names, BTreeSet::from(["claude-auth", "audit-log"]));
}

#[test]
fn identical_acquisitions_produce_identical_digests_and_ordering() {
    let requirements = claude_requirements();
    let fixture = ResolverFixture::new();

    let run = || {
        let source = Arc::new(FakeCredentialSource::new(
            CredentialSourceKind::Environment,
            BTreeMap::from([("claude-auth".to_owned(), Ok(Some(b"secret".to_vec())))]),
        ));
        let registry = CredentialSourceRegistry::new().register(source).unwrap();
        let policy = CredentialSourcePolicy::new(BTreeMap::from([(
            requirement("claude-auth"),
            vec![source_ref(CredentialSourceKind::Environment, "claude-auth")],
        )]))
        .unwrap();
        let resolver = fixture.resolver(policy, registry);
        let leases = resolver
            .acquire(&requirements, &budget(&fixture.cancel))
            .expect("acquire must succeed");
        let digest = leases
            .capability(&requirement("claude-auth"))
            .expect("capability must exist")
            .digest()
            .clone();
        (
            digest,
            requirements
                .requirements()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
        )
    };

    let (digest_a, order_a) = run();
    let (digest_b, order_b) = run();
    assert_eq!(digest_a, digest_b);
    assert_eq!(order_a, order_b);
}
