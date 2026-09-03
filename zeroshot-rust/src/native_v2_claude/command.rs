use std::collections::BTreeMap;

use crate::execution::WorkspaceAccessMode;
use crate::native_v2_capsule::provider_process::{effort_token, with_driver_detail};
use crate::native_v2_runner::{
    render_agent_prompt, DriverInvocation, NodeRole, NodeRunnerError, ResolvedEnvironment,
};
use crate::worker_catalog::ReasoningEffort;

pub(super) const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api";
pub(super) const OPENROUTER_KEY: &str = "OPENROUTER_API_KEY";
const ANTHROPIC_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";
pub(super) const ANTHROPIC_KEY: &str = "ANTHROPIC_API_KEY";
const ANTHROPIC_BASE_URL: &str = "ANTHROPIC_BASE_URL";

pub(super) struct ClaudeTurnArguments<'a> {
    pub(super) model: &'a str,
    pub(super) effort: Option<ReasoningEffort>,
    pub(super) role: NodeRole,
    pub(super) resume_id: Option<&'a str>,
    pub(super) json_schema: String,
}

pub(super) fn claude_arguments(
    mut argv: Vec<String>,
    turn: ClaudeTurnArguments<'_>,
) -> Result<Vec<String>, NodeRunnerError> {
    argv.extend([
        "--print".to_owned(),
        "--input-format".to_owned(),
        "text".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--verbose".to_owned(),
        "--include-partial-messages".to_owned(),
        "--model".to_owned(),
        turn.model.to_owned(),
        "--json-schema".to_owned(),
        turn.json_schema,
    ]);
    if let Some(effort) = turn.effort {
        argv.extend(["--effort".to_owned(), effort_token(effort).to_owned()]);
    }
    match turn.role {
        NodeRole::Worker => argv.push("--dangerously-skip-permissions".to_owned()),
        NodeRole::Verifier => {
            argv.extend(["--permission-mode".to_owned(), "plan".to_owned()]);
        }
        NodeRole::GitDelivery => return Err(NodeRunnerError::Driver),
    }
    if let Some(resume_id) = turn.resume_id {
        argv.extend(["--resume".to_owned(), resume_id.to_owned()]);
    }
    Ok(argv)
}

pub(super) fn workspace_access(role: NodeRole) -> Result<WorkspaceAccessMode, NodeRunnerError> {
    match role {
        NodeRole::Verifier => Ok(WorkspaceAccessMode::ReadOnly),
        NodeRole::Worker => Ok(WorkspaceAccessMode::Exclusive),
        NodeRole::GitDelivery => Err(NodeRunnerError::Driver),
    }
}

pub(super) fn extend_declared_environment(
    environment: &mut BTreeMap<String, String>,
    resolved: &ResolvedEnvironment,
) -> Result<(), NodeRunnerError> {
    for (name, value) in resolved.iter() {
        if value.contains('\0') || environment.contains_key(name.as_str()) {
            return Err(NodeRunnerError::Driver);
        }
        environment.insert(name.as_str().to_owned(), value.to_owned());
    }
    Ok(())
}

pub(super) fn reject_provider_controls(
    environment: &BTreeMap<String, String>,
) -> Result<(), NodeRunnerError> {
    const CONTROLS: [&str; 5] = [
        ANTHROPIC_BASE_URL,
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ];
    CONTROLS
        .iter()
        .all(|name| !environment.contains_key(*name))
        .then_some(())
        .ok_or(NodeRunnerError::Driver)
}

pub(super) fn configure_openrouter(
    environment: &mut BTreeMap<String, String>,
) -> Result<(), NodeRunnerError> {
    let token = environment
        .get(OPENROUTER_KEY)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or(NodeRunnerError::Driver)?;
    if [ANTHROPIC_TOKEN, ANTHROPIC_KEY]
        .iter()
        .any(|name| environment.contains_key(*name))
    {
        return Err(NodeRunnerError::Driver);
    }
    environment.insert(ANTHROPIC_TOKEN.to_owned(), token);
    environment.insert(ANTHROPIC_KEY.to_owned(), String::new());
    environment.insert(
        ANTHROPIC_BASE_URL.to_owned(),
        OPENROUTER_BASE_URL.to_owned(),
    );
    Ok(())
}

pub(super) fn prompt(invocation: &DriverInvocation) -> Result<String, NodeRunnerError> {
    render_agent_prompt(
        invocation.agent_instructions()?,
        &invocation.node.input,
        &invocation.response,
    )
    .map_err(|error| with_driver_detail(error, "Claude prompt could not be serialized"))
}
