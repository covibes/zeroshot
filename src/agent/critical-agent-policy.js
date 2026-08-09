// @ts-nocheck

// Validators publish a rejection when their task exhausts retries. Every other named role can
// execute provider work, including user-defined and orchestrator roles, so exhaustion must
// terminalize the cluster by default instead of requiring this policy to know each future role.
const NON_TERMINAL_AGENT_ROLES = new Set(['validator']);

function isCriticalAgent(agent) {
  if (agent?.id === 'consensus-coordinator') return true;
  return (
    typeof agent?.role === 'string' &&
    agent.role.length > 0 &&
    !NON_TERMINAL_AGENT_ROLES.has(agent.role)
  );
}

module.exports = { isCriticalAgent };
