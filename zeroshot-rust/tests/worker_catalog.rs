use std::collections::BTreeSet;

use zeroshot_engine::execution::SessionScope;
use zeroshot_engine::worker_catalog::{
    worker_catalog, CapabilityPolicy, CapabilitySupport, CredentialRequirementName, DriverFamily,
    ExecutableArgument, ExecutableMetadata, ExecutableName, ModelId, ModelLevel, ModelPolicy,
    ModelSelection, ProbeStrategy, ProviderAlias, ProviderDescriptor, ProviderDescriptorSpec,
    ProviderDisplayName, ProviderId, ReasoningEffort, ReasoningPolicy, SessionPolicy,
    WorkerCapability, WorkerCatalog, WorkerCatalogSpec, DEFAULT_WORKER_PROVIDER,
    WORKER_CATALOG_VERSION, WORKER_PROVIDER_COUNT,
};

#[derive(Debug)]
struct ExpectedProvider {
    id: &'static str,
    aliases: &'static [&'static str],
    display: &'static str,
    family: DriverFamily,
    executable: Option<(&'static str, &'static [&'static str], ProbeStrategy)>,
    models: [Option<&'static str>; 3],
    reasoning_defaults: [Option<ReasoningEffort>; 3],
    reasoning: &'static [ReasoningEffort],
    capabilities: &'static [(WorkerCapability, CapabilitySupport)],
    credential: &'static str,
}

const fn stable(capability: WorkerCapability) -> (WorkerCapability, CapabilitySupport) {
    (capability, CapabilitySupport::Stable)
}

const FIXTURE: &[ExpectedProvider] = &[
    ExpectedProvider {
        id: "claude",
        aliases: &["anthropic"],
        display: "Claude",
        family: DriverFamily::CliProcess,
        executable: Some(("claude", &[], ProbeStrategy::Version)),
        models: [Some("haiku"), Some("sonnet"), Some("opus")],
        reasoning_defaults: [None, None, None],
        reasoning: &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            stable(WorkerCapability::JsonSchema),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
            stable(WorkerCapability::ReasoningEffort),
            stable(WorkerCapability::SessionResume),
        ],
        credential: "claude-auth",
    },
    ExpectedProvider {
        id: "codex",
        aliases: &["openai"],
        display: "Codex",
        family: DriverFamily::CliProcess,
        executable: Some(("codex", &["exec"], ProbeStrategy::Version)),
        models: [Some("gpt-5.4"), Some("gpt-5.4"), Some("gpt-5.4")],
        reasoning_defaults: [
            Some(ReasoningEffort::Medium),
            Some(ReasoningEffort::High),
            Some(ReasoningEffort::Xhigh),
        ],
        reasoning: &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            stable(WorkerCapability::JsonSchema),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
            stable(WorkerCapability::ReasoningEffort),
            stable(WorkerCapability::SessionResume),
        ],
        credential: "codex-auth",
    },
    ExpectedProvider {
        id: "copilot",
        aliases: &[],
        display: "Copilot",
        family: DriverFamily::CliProcess,
        executable: Some(("copilot", &[], ProbeStrategy::HelpOrVersion)),
        models: [None, None, None],
        reasoning_defaults: [None, None, None],
        reasoning: &[],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential: "copilot-auth",
    },
    ExpectedProvider {
        id: "gateway",
        aliases: &[],
        display: "Gateway",
        family: DriverFamily::GatewayHttp,
        executable: None,
        models: [None, None, None],
        reasoning_defaults: [None, None, None],
        reasoning: &[],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential: "gateway-auth",
    },
    ExpectedProvider {
        id: "gemini",
        aliases: &["google"],
        display: "Gemini",
        family: DriverFamily::CliProcess,
        executable: Some(("gemini", &[], ProbeStrategy::Version)),
        models: [None, None, None],
        reasoning_defaults: [None, None, None],
        reasoning: &[],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            (
                WorkerCapability::JsonSchema,
                CapabilitySupport::Experimental,
            ),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential: "gemini-auth",
    },
    ExpectedProvider {
        id: "kiro",
        aliases: &[],
        display: "Kiro",
        family: DriverFamily::AcpStdio,
        executable: Some(("kiro-cli", &["acp"], ProbeStrategy::Version)),
        models: [None, None, None],
        reasoning_defaults: [None, None, None],
        reasoning: &[],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential: "kiro-auth",
    },
    ExpectedProvider {
        id: "opencode",
        aliases: &[],
        display: "Opencode",
        family: DriverFamily::CliProcess,
        executable: Some(("opencode", &["run"], ProbeStrategy::Version)),
        models: [None, None, None],
        reasoning_defaults: [
            Some(ReasoningEffort::Low),
            Some(ReasoningEffort::Medium),
            Some(ReasoningEffort::High),
        ],
        reasoning: &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            (
                WorkerCapability::JsonSchema,
                CapabilitySupport::Experimental,
            ),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
            stable(WorkerCapability::ReasoningEffort),
        ],
        credential: "opencode-auth",
    },
    ExpectedProvider {
        id: "pi",
        aliases: &[],
        display: "Pi",
        family: DriverFamily::CliProcess,
        executable: Some(("pi", &[], ProbeStrategy::HelpOrVersion)),
        models: [None, None, None],
        reasoning_defaults: [None, None, None],
        reasoning: &[],
        capabilities: &[
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential: "pi-auth",
    },
];

#[test]
fn canonical_catalog_matches_the_exact_versioned_fixture() {
    let catalog = worker_catalog();
    assert_eq!(catalog.version(), WORKER_CATALOG_VERSION);
    assert_eq!(catalog.providers().len(), WORKER_PROVIDER_COUNT);
    assert_eq!(
        catalog.default_provider_id().as_str(),
        DEFAULT_WORKER_PROVIDER
    );
    assert_eq!(catalog.default_provider().id().as_str(), "claude");

    for (provider, expected) in catalog.providers().iter().zip(FIXTURE) {
        assert_eq!(provider.id().as_str(), expected.id);
        assert_eq!(
            provider
                .aliases()
                .iter()
                .map(ProviderAlias::as_str)
                .collect::<Vec<_>>(),
            expected.aliases
        );
        assert_eq!(provider.display_name().as_str(), expected.display);
        assert_eq!(provider.driver_family(), expected.family);
        assert_eq!(
            provider.driver_family().token(),
            provider.driver_family_id().as_str()
        );

        match (provider.executable(), expected.executable) {
            (None, None) => {}
            (Some(actual), Some((name, arguments, probe))) => {
                assert_eq!(actual.name().as_str(), name);
                assert_eq!(
                    actual
                        .arguments()
                        .iter()
                        .map(ExecutableArgument::as_str)
                        .collect::<Vec<_>>(),
                    arguments
                );
                assert_eq!(actual.probe(), probe);
            }
            pair => panic!("executable fixture mismatch for {}: {pair:?}", expected.id),
        }

        for (index, level) in [ModelLevel::Level1, ModelLevel::Level2, ModelLevel::Level3]
            .into_iter()
            .enumerate()
        {
            let selection = provider
                .models()
                .selection(level)
                .expect("fixture model level");
            assert_eq!(
                selection.model().map(ModelId::as_str),
                expected.models[index]
            );
            assert_eq!(
                selection.default_reasoning_effort(),
                expected.reasoning_defaults[index]
            );
        }
        assert_eq!(provider.models().default_level(), ModelLevel::Level2);
        assert_eq!(
            provider
                .reasoning()
                .efforts()
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            expected.reasoning
        );
        assert_eq!(
            provider
                .capabilities()
                .entries()
                .iter()
                .map(|(capability, support)| (*capability, *support))
                .collect::<Vec<_>>(),
            expected.capabilities
        );
        assert_eq!(
            provider.sessions().scopes(),
            &BTreeSet::from([SessionScope::Execution])
        );
        assert!(!provider.sessions().supports(SessionScope::NodeInstance));
        assert_eq!(
            provider
                .credential_requirements()
                .iter()
                .map(CredentialRequirementName::as_str)
                .collect::<Vec<_>>(),
            [expected.credential]
        );
    }
}

#[test]
fn canonical_aliases_resolve_directly_to_their_owner() {
    let catalog = worker_catalog();
    for (identity, canonical) in [
        ("claude", "claude"),
        ("anthropic", "claude"),
        ("codex", "codex"),
        ("openai", "codex"),
        ("gemini", "gemini"),
        ("google", "gemini"),
    ] {
        assert_eq!(
            catalog
                .resolve(identity)
                .map(|provider| provider.id().as_str()),
            Some(canonical)
        );
    }
    assert!(catalog.resolve("Anthropic").is_none());
    assert!(catalog.resolve("unknown").is_none());
}

#[test]
fn canonical_bytes_and_digest_are_stable_across_order_and_repetition() {
    let left = valid_catalog(vec![
        valid_provider("zeta", "Zeta", &[]),
        valid_provider("alpha", "Alpha", &["first"]),
    ]);
    let right = valid_catalog(vec![
        valid_provider("alpha", "Alpha", &["first"]),
        valid_provider("zeta", "Zeta", &[]),
    ]);
    assert_eq!(left.canonical_bytes(), right.canonical_bytes());
    assert_eq!(left.digest(), right.digest());
    assert_eq!(left.canonical_bytes(), left.canonical_bytes());
    assert_eq!(left.digest(), left.digest());

    let built_in = worker_catalog();
    assert_eq!(
        built_in.canonical_bytes(),
        worker_catalog().canonical_bytes()
    );
    assert_eq!(built_in.digest(), worker_catalog().digest());
    assert_eq!(built_in.digest().as_str().len(), 64);
}

#[test]
fn provider_identity_and_display_collisions_fail_closed() {
    let duplicate_id = WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers: vec![
            valid_provider("alpha", "Alpha", &[]),
            valid_provider("alpha", "Other", &[]),
        ],
    })
    .expect_err("duplicate canonical id must fail");
    assert_eq!(duplicate_id.field(), "catalog providers");

    let alias_collision = WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers: vec![
            valid_provider("alpha", "Alpha", &["shared"]),
            valid_provider("beta", "Beta", &["shared"]),
        ],
    })
    .expect_err("alias collision must fail");
    assert_eq!(alias_collision.field(), "provider identity");

    let canonical_alias_collision = WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers: vec![
            valid_provider("alpha", "Alpha", &["beta"]),
            valid_provider("beta", "Beta", &[]),
        ],
    })
    .expect_err("alias-to-canonical collision must fail");
    assert_eq!(canonical_alias_collision.field(), "provider identity");

    let display_collision = WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers: vec![
            valid_provider("alpha", "Same", &[]),
            valid_provider("beta", "same", &[]),
        ],
    })
    .expect_err("display collision must fail");
    assert_eq!(display_collision.field(), "provider display names");
}

#[test]
fn invalid_family_session_model_and_reasoning_policies_fail_closed() {
    let missing_default = ModelPolicy::new(
        ModelLevel::Level2,
        [ModelSelection::new(ModelLevel::Level1, None, None)],
    )
    .expect_err("missing default model level must fail");
    assert_eq!(missing_default.field(), "default model level");

    let duplicate_reasoning = ReasoningPolicy::new([ReasoningEffort::High, ReasoningEffort::High])
        .expect_err("duplicate reasoning effort must fail");
    assert_eq!(duplicate_reasoning.field(), "reasoning policy");

    let duplicate_scope = SessionPolicy::new([SessionScope::Execution, SessionScope::Execution])
        .expect_err("duplicate session scope must fail");
    assert_eq!(duplicate_scope.field(), "session policy");

    let mut gateway_with_process = valid_spec("gateway", "Gateway", &[]);
    gateway_with_process.driver_family = DriverFamily::GatewayHttp;
    let family_error = ProviderDescriptor::new(gateway_with_process)
        .expect_err("HTTP family with executable must fail");
    assert_eq!(family_error.field(), "driver family policy");

    let mut process_without_executable = valid_spec("alpha", "Alpha", &[]);
    process_without_executable.executable = None;
    let executable_error = ProviderDescriptor::new(process_without_executable)
        .expect_err("process family without executable must fail");
    assert_eq!(executable_error.field(), "driver family policy");

    let mut node_scope = valid_spec("alpha", "Alpha", &[]);
    node_scope.sessions = SessionPolicy::new([SessionScope::Execution, SessionScope::NodeInstance])
        .expect("bounded scopes");
    let node_error =
        ProviderDescriptor::new(node_scope).expect_err("unsupported node-instance scope must fail");
    assert_eq!(node_error.field(), "session policy");

    let mut unsupported_reasoning = valid_spec("alpha", "Alpha", &[]);
    unsupported_reasoning.reasoning =
        ReasoningPolicy::new([ReasoningEffort::High]).expect("bounded reasoning");
    let reasoning_error = ProviderDescriptor::new(unsupported_reasoning)
        .expect_err("reasoning policy without capability must fail");
    assert_eq!(reasoning_error.field(), "reasoning policy");

    let mut invalid_model_default = valid_spec("alpha", "Alpha", &[]);
    invalid_model_default.models = ModelPolicy::new(
        ModelLevel::Level2,
        [
            ModelSelection::new(ModelLevel::Level1, None, None),
            ModelSelection::new(ModelLevel::Level2, None, Some(ReasoningEffort::High)),
        ],
    )
    .expect("model structure is bounded");
    let model_error = ProviderDescriptor::new(invalid_model_default)
        .expect_err("unsupported default reasoning must fail");
    assert_eq!(model_error.field(), "model policy");
}

fn valid_catalog(providers: Vec<ProviderDescriptor>) -> WorkerCatalog {
    WorkerCatalog::new(WorkerCatalogSpec {
        version: 1,
        default_provider: provider_id("alpha"),
        providers,
    })
    .expect("valid test catalog")
}

fn valid_provider(id: &str, display: &str, aliases: &[&str]) -> ProviderDescriptor {
    ProviderDescriptor::new(valid_spec(id, display, aliases)).expect("valid test provider")
}

fn valid_spec(id: &str, display: &str, aliases: &[&str]) -> ProviderDescriptorSpec {
    ProviderDescriptorSpec {
        id: provider_id(id),
        aliases: aliases
            .iter()
            .map(|alias| ProviderAlias::new(*alias).expect("test alias"))
            .collect(),
        display_name: ProviderDisplayName::new(display).expect("test display"),
        driver_family: DriverFamily::CliProcess,
        models: ModelPolicy::new(
            ModelLevel::Level2,
            [
                ModelSelection::new(ModelLevel::Level1, None, None),
                ModelSelection::new(ModelLevel::Level2, None, None),
                ModelSelection::new(ModelLevel::Level3, None, None),
            ],
        )
        .expect("test model policy"),
        reasoning: ReasoningPolicy::new([]).expect("test reasoning policy"),
        sessions: SessionPolicy::new([SessionScope::Execution]).expect("test session policy"),
        capabilities: CapabilityPolicy::new([stable(WorkerCapability::ToolUse)])
            .expect("test capabilities"),
        executable: Some(
            ExecutableMetadata::new(
                ExecutableName::new("test-provider").expect("test executable"),
                vec![],
                ProbeStrategy::Version,
            )
            .expect("test executable metadata"),
        ),
        credential_requirements: vec![
            CredentialRequirementName::new("provider-auth").expect("test credential requirement"),
        ],
    }
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).expect("test provider id")
}
