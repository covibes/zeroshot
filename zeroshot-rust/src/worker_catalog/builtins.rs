use super::*;

const ALL_REASONING: &[ReasoningEffort] = &[
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
    ReasoningEffort::Max,
];

pub(super) fn canonical_catalog_spec() -> WorkerCatalogSpec {
    WorkerCatalogSpec {
        version: WORKER_CATALOG_VERSION,
        default_provider: provider_id(DEFAULT_WORKER_PROVIDER),
        providers: vec![
            claude(),
            codex(),
            gateway(),
            gemini(),
            opencode(),
            pi(),
            kiro(),
            copilot(),
        ],
    }
}

fn claude() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "claude",
        aliases: &["anthropic"],
        display_name: "Claude",
        family: DriverFamily::CliProcess,
        executable: Some(("claude", &[], ProbeStrategy::Version)),
        level_models: [Some("haiku"), Some("sonnet"), Some("opus")],
        level_reasoning: [None, None, None],
        reasoning: ALL_REASONING,
        capabilities: vec![
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            stable(WorkerCapability::JsonSchema),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
            stable(WorkerCapability::ReasoningEffort),
            stable(WorkerCapability::SessionResume),
        ],
        credential_requirement: "claude-auth",
    })
}

fn codex() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "codex",
        aliases: &["openai"],
        display_name: "Codex",
        family: DriverFamily::CliProcess,
        executable: Some(("codex", &["exec"], ProbeStrategy::Version)),
        level_models: [Some("gpt-5.4"), Some("gpt-5.4"), Some("gpt-5.4")],
        level_reasoning: [
            Some(ReasoningEffort::Medium),
            Some(ReasoningEffort::High),
            Some(ReasoningEffort::Xhigh),
        ],
        reasoning: ALL_REASONING,
        capabilities: vec![
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            stable(WorkerCapability::JsonSchema),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
            stable(WorkerCapability::ReasoningEffort),
            stable(WorkerCapability::SessionResume),
        ],
        credential_requirement: "codex-auth",
    })
}

fn gateway() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "gateway",
        aliases: &[],
        display_name: "Gateway",
        family: DriverFamily::GatewayHttp,
        executable: None,
        level_models: [None, None, None],
        level_reasoning: [None, None, None],
        reasoning: &[],
        capabilities: vec![
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential_requirement: "gateway-auth",
    })
}

fn gemini() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "gemini",
        aliases: &["google"],
        display_name: "Gemini",
        family: DriverFamily::CliProcess,
        executable: Some(("gemini", &[], ProbeStrategy::Version)),
        level_models: [None, None, None],
        level_reasoning: [None, None, None],
        reasoning: &[],
        capabilities: vec![
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
        credential_requirement: "gemini-auth",
    })
}

fn opencode() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "opencode",
        aliases: &[],
        display_name: "Opencode",
        family: DriverFamily::CliProcess,
        executable: Some(("opencode", &["run"], ProbeStrategy::Version)),
        level_models: [None, None, None],
        level_reasoning: default_reasoning_levels(),
        reasoning: ALL_REASONING,
        capabilities: vec![
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
        credential_requirement: "opencode-auth",
    })
}

fn pi() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "pi",
        aliases: &[],
        display_name: "Pi",
        family: DriverFamily::CliProcess,
        executable: Some(("pi", &[], ProbeStrategy::Version)),
        level_models: [None, None, None],
        level_reasoning: default_reasoning_levels(),
        reasoning: ALL_REASONING,
        capabilities: vec![
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
            stable(WorkerCapability::ReasoningEffort),
        ],
        credential_requirement: "pi-auth",
    })
}

fn kiro() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "kiro",
        aliases: &[],
        display_name: "Kiro",
        family: DriverFamily::AcpStdio,
        executable: Some(("kiro-cli", &["acp"], ProbeStrategy::Version)),
        level_models: [None, None, None],
        level_reasoning: [None, None, None],
        reasoning: &[],
        capabilities: vec![
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential_requirement: "kiro-auth",
    })
}

fn copilot() -> ProviderDescriptor {
    provider(ProviderSource {
        id: "copilot",
        aliases: &[],
        display_name: "Copilot",
        family: DriverFamily::CliProcess,
        executable: Some(("copilot", &[], ProbeStrategy::HelpOrVersion)),
        level_models: [None, None, None],
        level_reasoning: [None, None, None],
        reasoning: &[],
        capabilities: vec![
            stable(WorkerCapability::ToolUse),
            stable(WorkerCapability::WorkspaceIsolation),
            stable(WorkerCapability::McpServers),
            stable(WorkerCapability::StreamEvents),
            stable(WorkerCapability::Thinking),
        ],
        credential_requirement: "copilot-auth",
    })
}

fn default_reasoning_levels() -> [Option<ReasoningEffort>; 3] {
    [
        Some(ReasoningEffort::Low),
        Some(ReasoningEffort::Medium),
        Some(ReasoningEffort::High),
    ]
}

type ExecutableSource = (&'static str, &'static [&'static str], ProbeStrategy);

struct ProviderSource {
    id: &'static str,
    aliases: &'static [&'static str],
    display_name: &'static str,
    family: DriverFamily,
    executable: Option<ExecutableSource>,
    level_models: [Option<&'static str>; 3],
    level_reasoning: [Option<ReasoningEffort>; 3],
    reasoning: &'static [ReasoningEffort],
    capabilities: Vec<(WorkerCapability, CapabilitySupport)>,
    credential_requirement: &'static str,
}

fn provider(source: ProviderSource) -> ProviderDescriptor {
    let levels = [ModelLevel::Level1, ModelLevel::Level2, ModelLevel::Level3]
        .into_iter()
        .zip(source.level_models)
        .zip(source.level_reasoning)
        .map(|((level, model), effort)| ModelSelection::new(level, model.map(model_id), effort));
    ProviderDescriptor::new(ProviderDescriptorSpec {
        id: provider_id(source.id),
        aliases: source.aliases.iter().copied().map(provider_alias).collect(),
        display_name: ProviderDisplayName::new(source.display_name)
            .expect("built-in display name is valid"),
        driver_family: source.family,
        models: ModelPolicy::new(ModelLevel::Level2, levels)
            .expect("built-in model policy is valid"),
        reasoning: ReasoningPolicy::new(source.reasoning.iter().copied())
            .expect("built-in reasoning policy is valid"),
        sessions: SessionPolicy::new([SessionScope::Execution])
            .expect("built-in session policy is valid"),
        capabilities: CapabilityPolicy::new(source.capabilities.iter().copied())
            .expect("built-in capability policy is valid"),
        executable: source.executable.map(|(name, arguments, probe)| {
            ExecutableMetadata::new(
                ExecutableName::new(name).expect("built-in executable name is valid"),
                arguments
                    .iter()
                    .map(|argument| {
                        ExecutableArgument::new(*argument).expect("built-in argument is valid")
                    })
                    .collect(),
                probe,
            )
            .expect("built-in executable metadata is valid")
        }),
        credential_requirements: vec![
            CredentialRequirementName::new(source.credential_requirement)
                .expect("built-in credential requirement is valid"),
        ],
    })
    .expect("built-in provider descriptor is valid")
}

const fn stable(capability: WorkerCapability) -> (WorkerCapability, CapabilitySupport) {
    (capability, CapabilitySupport::Stable)
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).expect("built-in provider id is valid")
}

fn provider_alias(value: &str) -> ProviderAlias {
    ProviderAlias::new(value).expect("built-in provider alias is valid")
}

fn model_id(value: &str) -> ModelId {
    ModelId::new(value).expect("built-in model id is valid")
}
