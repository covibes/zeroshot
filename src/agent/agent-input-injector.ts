type InjectionStatus = 'unsupported' | 'injected';
type InjectionMethod = 'pty';

interface InjectionResult {
  status: InjectionStatus;
  reason: string | null;
  method: InjectionMethod | null;
  taskId: string | null;
}

interface BuildResultParams {
  status: InjectionStatus;
  reason?: string | null | undefined;
  method?: InjectionMethod | null | undefined;
  taskId?: string | null | undefined;
}

interface AgentInputTarget {
  currentTaskId?: string | null;
  isolation?: {
    enabled?: unknown;
  } | null;
}

interface TaskInfo {
  socketPath?: string | null;
  attachable?: unknown;
}

interface TaskStoreModule {
  getTask(taskId: string): TaskInfo | null | undefined;
}

interface InjectInputOptions {
  timeoutMs?: number;
}

function isTaskStoreModule(value: unknown): value is TaskStoreModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getTask' in value &&
    typeof value.getTask === 'function'
  );
}

const taskStoreModule: unknown = require('../../task-lib/store.js');
if (!isTaskStoreModule(taskStoreModule)) {
  throw new TypeError('task store must export getTask');
}
const getTask = taskStoreModule.getTask;

import sendInputModule from '../attach/send-input';

const { sendInput } = sendInputModule;

import socketDiscovery from '../attach/socket-discovery';

const { isSocketAlive } = socketDiscovery;

const DEFAULT_TIMEOUT_MS = 1500;

function buildResult({
  status,
  reason = null,
  method = null,
  taskId = null,
}: BuildResultParams): InjectionResult {
  return {
    status,
    reason,
    method,
    taskId,
  };
}

function ensureValidInputs(
  agent: AgentInputTarget | null | undefined,
  text: unknown
): { agent: AgentInputTarget; text: string } {
  if (!agent) {
    throw new Error('AgentInputInjector: agent is required');
  }
  if (typeof text !== 'string') {
    throw new Error('AgentInputInjector: text must be a string');
  }
  if (!text.trim()) {
    throw new Error('AgentInputInjector: text cannot be empty');
  }
  return { agent, text };
}

function buildUnsupported(reason: string, taskId: string | null): InjectionResult {
  return buildResult({
    status: 'unsupported',
    reason,
    taskId,
  });
}

function getTaskId(agent: AgentInputTarget): string | null {
  return agent.currentTaskId || null;
}

function checkIsolation(agent: AgentInputTarget, taskId: string | null): InjectionResult | null {
  if (agent.isolation?.enabled) {
    return buildUnsupported('isolation-enabled', taskId);
  }
  return null;
}

async function checkSocketAlive(
  socketPath: string,
  taskId: string
): Promise<InjectionResult | null> {
  const socketAlive = await isSocketAlive(socketPath);
  if (!socketAlive) {
    return buildUnsupported('socket-not-alive', taskId);
  }
  return null;
}

function normalizePayload(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function resolveTimeout(options: InjectInputOptions): number {
  return options.timeoutMs || DEFAULT_TIMEOUT_MS;
}

function buildInjected(taskId: string): InjectionResult {
  return buildResult({
    status: 'injected',
    method: 'pty',
    taskId,
  });
}

function buildSendFailure(reason: string | null | undefined, taskId: string): InjectionResult {
  return buildResult({
    status: 'unsupported',
    reason: reason || 'send-failed',
    method: 'pty',
    taskId,
  });
}

async function injectInput(
  agentValue: AgentInputTarget | null | undefined,
  textValue: unknown,
  options: InjectInputOptions = {}
): Promise<InjectionResult> {
  const { agent, text } = ensureValidInputs(agentValue, textValue);

  const taskId = getTaskId(agent);
  const isolationResult = checkIsolation(agent, taskId);
  if (isolationResult) return isolationResult;

  if (!taskId) {
    return buildUnsupported('no-current-task', null);
  }

  const taskInfo = getTask(taskId);
  if (!taskInfo) {
    return buildUnsupported('task-not-found', taskId);
  }
  if (!taskInfo.socketPath) {
    return buildUnsupported('no-socket', taskId);
  }
  if (!taskInfo.attachable) {
    return buildUnsupported('task-not-attachable', taskId);
  }

  const socketPath = taskInfo.socketPath;
  const socketResult = await checkSocketAlive(socketPath, taskId);
  if (socketResult) return socketResult;

  const payload = normalizePayload(text);
  const timeoutMs = resolveTimeout(options);
  const result = await sendInput({
    socketPath,
    data: payload,
    timeoutMs,
  });

  if (!result.ok) {
    return buildSendFailure(result.error, taskId);
  }

  return buildInjected(taskId);
}

export = {
  injectInput,
};
