use std::collections::BTreeMap;

use crate::execution::WorkspaceAccessMode;
use crate::native_v2_capsule::provider_process::effort_token;
use crate::native_v2_contract::CodexProvider;
use crate::native_v2_runner::{NodeRole, NodeRunnerError, ResolvedEnvironment};
use crate::worker_catalog::ReasoningEffort;

const CODEX_HOME: &str = "CODEX_HOME";
const CODEX_API_KEY: &str = "CODEX_API_KEY";
const HOME: &str = "HOME";
const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
const PATH: &str = "PATH";
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

pub(super) fn process_environment(
    environment: &ResolvedEnvironment,
    home: String,
    codex_home: String,
    search_path: String,
) -> Result<BTreeMap<String, String>, NodeRunnerError> {
    let mut values = environment
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value.to_owned()))
        .collect::<BTreeMap<_, _>>();
    if search_path.is_empty() || search_path.contains('\0') {
        return Err(NodeRunnerError::Driver);
    }
    if values.contains_key(CODEX_HOME) || values.contains_key(HOME) || values.contains_key(PATH) {
        return Err(NodeRunnerError::Driver);
    }
    values.insert(CODEX_HOME.to_owned(), codex_home);
    values.insert(HOME.to_owned(), home);
    values.insert(PATH.to_owned(), search_path);
    Ok(values)
}

pub(super) fn configure_provider_auth(
    values: &mut BTreeMap<String, String>,
    provider: CodexProvider,
    has_local_user: bool,
) -> Result<(), NodeRunnerError> {
    match provider {
        CodexProvider::OpenAi => configure_openai_auth(values, has_local_user),
        CodexProvider::OpenRouter => values
            .get("OPENROUTER_API_KEY")
            .is_some_and(|value| !value.is_empty())
            .then_some(())
            .ok_or(NodeRunnerError::Driver),
    }
}

fn configure_openai_auth(
    values: &mut BTreeMap<String, String>,
    has_local_user: bool,
) -> Result<(), NodeRunnerError> {
    let openai = values.remove(OPENAI_API_KEY);
    if values.contains_key(CODEX_API_KEY) || has_local_user && openai.is_none() {
        return Ok(());
    }
    let value = openai.ok_or(NodeRunnerError::Driver)?;
    values.insert(CODEX_API_KEY.to_owned(), value);
    Ok(())
}

pub(super) fn add_provider_args(argv: &mut Vec<String>, provider: CodexProvider) {
    argv.extend([
        "--config".to_owned(),
        match provider {
            CodexProvider::OpenAi => "model_provider=\"openai\"".to_owned(),
            CodexProvider::OpenRouter => "model_provider=\"openrouter\"".to_owned(),
        },
    ]);
    if provider == CodexProvider::OpenRouter {
        argv.extend([
            "--config".to_owned(),
            "model_providers.openrouter.name=\"OpenRouter\"".to_owned(),
            "--config".to_owned(),
            format!("model_providers.openrouter.base_url=\"{OPENROUTER_BASE_URL}\""),
            "--config".to_owned(),
            "model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"".to_owned(),
            "--config".to_owned(),
            "model_providers.openrouter.wire_api=\"responses\"".to_owned(),
        ]);
    }
}

pub(super) fn add_local_execution_policy(argv: &mut Vec<String>, role: NodeRole, sandbox: &str) {
    argv.extend(["--sandbox".to_owned(), sandbox.to_owned()]);
    argv.extend([
        "--config".to_owned(),
        "approval_policy=\"never\"".to_owned(),
    ]);
    if role == NodeRole::Worker {
        argv.extend([
            "--config".to_owned(),
            "sandbox_workspace_write.network_access=true".to_owned(),
        ]);
    }
}

pub(super) fn add_resume_command(argv: &mut Vec<String>, resume: Option<&str>) {
    if resume.is_some() {
        argv.push("resume".to_owned());
    }
}

pub(super) fn provider_model(provider: CodexProvider, model: &str) -> String {
    match provider {
        CodexProvider::OpenAi => model.to_owned(),
        CodexProvider::OpenRouter => format!("openai/{model}"),
    }
}

pub(super) fn add_node_args(argv: &mut Vec<String>, model: &str, effort: Option<ReasoningEffort>) {
    argv.extend(["--json".to_owned(), "--model".to_owned(), model.to_owned()]);
    if let Some(effort) = effort {
        argv.extend([
            "--config".to_owned(),
            format!("model_reasoning_effort=\"{}\"", effort_token(effort)),
        ]);
    }
    argv.extend([
        "--skip-git-repo-check".to_owned(),
        "--config".to_owned(),
        "web_search=\"disabled\"".to_owned(),
    ]);
}

pub(super) fn add_session_target(argv: &mut Vec<String>, resume: Option<&str>) {
    if let Some(session_id) = resume {
        argv.push(session_id.to_owned());
    }
    argv.push("-".to_owned());
}

pub(super) fn role_settings(
    role: NodeRole,
) -> Result<(&'static str, WorkspaceAccessMode), NodeRunnerError> {
    match role {
        NodeRole::Worker => Ok(("workspace-write", WorkspaceAccessMode::Exclusive)),
        NodeRole::Verifier => Ok(("read-only", WorkspaceAccessMode::ReadOnly)),
        NodeRole::GitDelivery => Err(NodeRunnerError::Driver),
    }
}
