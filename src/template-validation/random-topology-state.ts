import type { RandomAgentConfig, RandomSimulationState } from './random-topology-contracts';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRandomAgentConfig(value: unknown): value is RandomAgentConfig {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === undefined || typeof value.role === 'string')
  );
}

export function cloneAgentConfigs(agents: RandomAgentConfig[]): RandomAgentConfig[] {
  const cloned: unknown = JSON.parse(JSON.stringify(agents));
  return Array.isArray(cloned) ? cloned.filter(isRandomAgentConfig) : [];
}

export function addAgentsToState(state: RandomSimulationState, agents: unknown): void {
  if (!Array.isArray(agents)) return;
  for (const agent of agents) {
    if (!isRandomAgentConfig(agent)) continue;
    if (state.agentConfigs.some((existing) => existing.id === agent.id)) continue;
    state.agentConfigs.push(agent);
    state.cluster.agents.push({ id: agent.id, role: agent.role });
  }
}
