interface AgentHookExecutorModule {
  executeHook(options: unknown): Promise<void>;
}

interface AgentTaskExecutorModule {
  parseResultOutput(agent: unknown, output: string): Promise<unknown>;
}

function isAgentHookExecutorModule(value: unknown): value is AgentHookExecutorModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'executeHook' in value &&
    typeof value.executeHook === 'function'
  );
}

function isAgentTaskExecutorModule(value: unknown): value is AgentTaskExecutorModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parseResultOutput' in value &&
    typeof value.parseResultOutput === 'function'
  );
}

const agentHookExecutorModule: unknown = require('../agent/agent-hook-executor');
const agentTaskExecutorModule: unknown = require('../agent/agent-task-executor');

if (!isAgentHookExecutorModule(agentHookExecutorModule)) {
  throw new TypeError('agent-hook-executor must export executeHook');
}
if (!isAgentTaskExecutorModule(agentTaskExecutorModule)) {
  throw new TypeError('agent-task-executor must export parseResultOutput');
}

export = {
  executeHook: agentHookExecutorModule.executeHook,
  parseResultOutput: agentTaskExecutorModule.parseResultOutput,
};
