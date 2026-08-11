use std::collections::BTreeSet;

use zeroshot_engine::execution::SessionScope;
use zeroshot_engine::worker_catalog::{
    worker_catalog, CapabilitySupport, CredentialRequirementName, DriverFamily, ExecutableArgument,
    ModelId, ModelLevel, ProbeStrategy, ProviderAlias, ProviderDescriptor, ReasoningEffort,
    WorkerCapability, DEFAULT_WORKER_PROVIDER, WORKER_CATALOG_VERSION, WORKER_PROVIDER_COUNT,
};

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

const NO_MODELS: [Option<&str>; 3] = [None, None, None];
const NO_REASONING: [Option<ReasoningEffort>; 3] = [None, None, None];
const DEFAULT_REASONING: [Option<ReasoningEffort>; 3] = [
    Some(ReasoningEffort::Low),
    Some(ReasoningEffort::Medium),
    Some(ReasoningEffort::High),
];
const ALL_REASONING: &[ReasoningEffort] = &[
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
    ReasoningEffort::Max,
];
const BASIC_CAPABILITIES: &[(WorkerCapability, CapabilitySupport)] = &[
    stable(WorkerCapability::ToolUse),
    stable(WorkerCapability::WorkspaceIsolation),
    stable(WorkerCapability::StreamEvents),
    stable(WorkerCapability::Thinking),
];
const PI_CAPABILITIES: &[(WorkerCapability, CapabilitySupport)] = &[
    stable(WorkerCapability::ToolUse),
    stable(WorkerCapability::WorkspaceIsolation),
    stable(WorkerCapability::StreamEvents),
    stable(WorkerCapability::Thinking),
    stable(WorkerCapability::ReasoningEffort),
];
const COPILOT_CAPABILITIES: &[(WorkerCapability, CapabilitySupport)] = &[
    stable(WorkerCapability::ToolUse),
    stable(WorkerCapability::WorkspaceIsolation),
    stable(WorkerCapability::McpServers),
    stable(WorkerCapability::StreamEvents),
    stable(WorkerCapability::Thinking),
];
const GEMINI_CAPABILITIES: &[(WorkerCapability, CapabilitySupport)] = &[
    stable(WorkerCapability::ToolUse),
    stable(WorkerCapability::WorkspaceIsolation),
    stable(WorkerCapability::McpServers),
    (
        WorkerCapability::JsonSchema,
        CapabilitySupport::Experimental,
    ),
    stable(WorkerCapability::StreamEvents),
    stable(WorkerCapability::Thinking),
];
const OPENCODE_CAPABILITIES: &[(WorkerCapability, CapabilitySupport)] = &[
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
];
const FULL_CAPABILITIES: &[(WorkerCapability, CapabilitySupport)] = &[
    stable(WorkerCapability::ToolUse),
    stable(WorkerCapability::WorkspaceIsolation),
    stable(WorkerCapability::McpServers),
    stable(WorkerCapability::JsonSchema),
    stable(WorkerCapability::StreamEvents),
    stable(WorkerCapability::Thinking),
    stable(WorkerCapability::ReasoningEffort),
    stable(WorkerCapability::SessionResume),
];

const FIXTURE: &[ExpectedProvider] = &[
    ExpectedProvider {
        id: "claude",
        aliases: &["anthropic"],
        display: "Claude",
        family: DriverFamily::CliProcess,
        executable: Some(("claude", &[], ProbeStrategy::Version)),
        models: [Some("haiku"), Some("sonnet"), Some("opus")],
        reasoning_defaults: NO_REASONING,
        reasoning: ALL_REASONING,
        capabilities: FULL_CAPABILITIES,
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
        reasoning: ALL_REASONING,
        capabilities: FULL_CAPABILITIES,
        credential: "codex-auth",
    },
    ExpectedProvider {
        id: "copilot",
        aliases: &[],
        display: "Copilot",
        family: DriverFamily::CliProcess,
        executable: Some(("copilot", &[], ProbeStrategy::HelpOrVersion)),
        models: NO_MODELS,
        reasoning_defaults: NO_REASONING,
        reasoning: &[],
        capabilities: COPILOT_CAPABILITIES,
        credential: "copilot-auth",
    },
    ExpectedProvider {
        id: "gateway",
        aliases: &[],
        display: "Gateway",
        family: DriverFamily::GatewayHttp,
        executable: None,
        models: NO_MODELS,
        reasoning_defaults: NO_REASONING,
        reasoning: &[],
        capabilities: BASIC_CAPABILITIES,
        credential: "gateway-auth",
    },
    ExpectedProvider {
        id: "gemini",
        aliases: &["google"],
        display: "Gemini",
        family: DriverFamily::CliProcess,
        executable: Some(("gemini", &[], ProbeStrategy::Version)),
        models: NO_MODELS,
        reasoning_defaults: NO_REASONING,
        reasoning: &[],
        capabilities: GEMINI_CAPABILITIES,
        credential: "gemini-auth",
    },
    ExpectedProvider {
        id: "kiro",
        aliases: &[],
        display: "Kiro",
        family: DriverFamily::AcpStdio,
        executable: Some(("kiro-cli", &["acp"], ProbeStrategy::Version)),
        models: NO_MODELS,
        reasoning_defaults: NO_REASONING,
        reasoning: &[],
        capabilities: BASIC_CAPABILITIES,
        credential: "kiro-auth",
    },
    ExpectedProvider {
        id: "opencode",
        aliases: &[],
        display: "Opencode",
        family: DriverFamily::CliProcess,
        executable: Some(("opencode", &["run"], ProbeStrategy::Version)),
        models: NO_MODELS,
        reasoning_defaults: DEFAULT_REASONING,
        reasoning: ALL_REASONING,
        capabilities: OPENCODE_CAPABILITIES,
        credential: "opencode-auth",
    },
    ExpectedProvider {
        id: "pi",
        aliases: &[],
        display: "Pi",
        family: DriverFamily::CliProcess,
        executable: Some(("pi", &[], ProbeStrategy::Version)),
        models: NO_MODELS,
        reasoning_defaults: DEFAULT_REASONING,
        reasoning: ALL_REASONING,
        capabilities: PI_CAPABILITIES,
        credential: "pi-auth",
    },
];

pub(super) fn assert_canonical_catalog() {
    let catalog = worker_catalog();
    assert_eq!(catalog.version(), WORKER_CATALOG_VERSION);
    assert_eq!(catalog.providers().len(), WORKER_PROVIDER_COUNT);
    assert_eq!(FIXTURE.len(), WORKER_PROVIDER_COUNT);
    assert_eq!(
        catalog.default_provider_id().as_str(),
        DEFAULT_WORKER_PROVIDER
    );
    assert_eq!(catalog.default_provider().id().as_str(), "claude");

    for (provider, expected) in catalog.providers().iter().zip(FIXTURE) {
        assert_provider(provider, expected);
    }
}

fn assert_provider(provider: &ProviderDescriptor, expected: &ExpectedProvider) {
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
    assert_executable(provider, expected);
    assert_models(provider, expected);
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
            .map(|(key, value)| (*key, *value))
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

fn assert_executable(provider: &ProviderDescriptor, expected: &ExpectedProvider) {
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
}

fn assert_models(provider: &ProviderDescriptor, expected: &ExpectedProvider) {
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
}
