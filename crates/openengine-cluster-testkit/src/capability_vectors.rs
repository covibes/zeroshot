//! Assertion helpers for verifying advertised graph profiles against a caller-supplied
//! expectation. This module holds no backend-to-profile registry: callers supply the
//! expected set, so a scripted vector here makes no claim about any production backend.

use openengine_cluster_protocol::{GraphProfile, ServerCapabilities};

pub fn assert_advertised_profiles(capabilities: &ServerCapabilities, expected: &[GraphProfile]) {
    assert_eq!(
        capabilities.graph_profiles.values(),
        expected,
        "advertised graph profiles did not match expected vector"
    );
}

/// Asserts the advertised `logs` capability flag matches `expected`. No backend-to-capability
/// registry lives here: callers supply the expectation, so a scripted vector here makes no claim
/// about any production backend.
pub fn assert_logs_capability(capabilities: &ServerCapabilities, expected: bool) {
    assert_eq!(
        capabilities.logs, expected,
        "advertised logs capability did not match expected value"
    );
}

/// Asserts the advertised `agentAttach` capability flag matches `expected`. No backend-to-capability
/// registry lives here: callers supply the expectation, so a scripted vector here makes no claim
/// about any production backend.
pub fn assert_agent_attach_capability(capabilities: &ServerCapabilities, expected: bool) {
    assert_eq!(
        capabilities.agent_attach, expected,
        "advertised agent_attach capability did not match expected value"
    );
}
