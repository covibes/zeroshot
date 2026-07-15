import {
  createGatewayChatCompletion,
  type GatewayChatMessage,
  type GatewayChatToolDefinition,
  type GatewayToolCall,
} from './gateway-client';
import {
  type GatewayToolExecutionResult,
  executeGatewayToolCall,
  resolveGatewayConfiguration,
} from './gateway-tools';
import { isRecord, parseJson, stringifyJson, unknownToMessage } from './json';
import type { GatewayBuildOptions, GatewayToolPolicy, OutputEvent, ResolvedGatewayBuildOptions } from './types';

const MAX_GATEWAY_TURNS = 12;

export interface GatewayRunnerRequest {
  readonly context: string;
  readonly gateway: GatewayBuildOptions;
  readonly cwd: string;
}

const TOOL_DEFINITIONS: readonly GatewayChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one UTF-8 file within toolPolicy.roots.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Write a full file with content, or replace search text in a UTF-8 file within toolPolicy.roots.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run an allowlisted command without a shell.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
] as const;

export async function runGatewayRequest(request: GatewayRunnerRequest): Promise<readonly OutputEvent[]> {
  const events: OutputEvent[] = [];
  try {
    const gateway = resolveGatewayConfiguration(request.gateway, 'gateway', request.cwd);
    return await runGatewayLoop(request.context, gateway, request.cwd, events);
  } catch (error) {
    return [
      ...events,
      {
        type: 'result',
        success: false,
        error: unknownToMessage(error),
      },
    ];
  }
}

export function gatewayRunnerRequestFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GatewayRunnerRequest {
  const raw = env.ZEROSHOT_GATEWAY_REQUEST;
  if (!raw) {
    throw new Error('ZEROSHOT_GATEWAY_REQUEST is required.');
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    throw new Error('ZEROSHOT_GATEWAY_REQUEST must encode a JSON object.');
  }
  const context = parsed.context;
  const cwd = parsed.cwd;
  if (typeof context !== 'string' || !context.trim()) {
    throw new Error('ZEROSHOT_GATEWAY_REQUEST.context must be a non-empty string.');
  }
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('ZEROSHOT_GATEWAY_REQUEST.cwd must be a non-empty string.');
  }
  const headers = gatewayHeadersFromEnv(parsed.gatewayHeaderEnv, env);
  return {
    context,
    cwd,
    gateway: {
      ...(isRecord(parsed.gateway) ? (parsed.gateway as GatewayBuildOptions) : {}),
      ...(headers === undefined ? {} : { headers }),
      ...(env.ZEROSHOT_GATEWAY_API_KEY === undefined
        ? {}
        : { apiKey: env.ZEROSHOT_GATEWAY_API_KEY }),
    },
  };
}

function gatewayHeadersFromEnv(
  value: unknown,
  env: NodeJS.ProcessEnv
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, envKey] of Object.entries(value)) {
    if (typeof envKey !== 'string' || !envKey) {
      throw new Error('ZEROSHOT_GATEWAY_REQUEST.gatewayHeaderEnv entries must be non-empty strings.');
    }
    const headerValue = env[envKey];
    if (typeof headerValue !== 'string') {
      throw new Error(`Gateway header env ${envKey} is required.`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

async function runGatewayLoop(
  context: string,
  gateway: ResolvedGatewayBuildOptions,
  cwd: string,
  events: OutputEvent[]
): Promise<readonly OutputEvent[]> {
  const toolState: GatewayToolState = { lastError: null };
  const messages: GatewayChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(gateway.toolPolicy),
    },
    {
      role: 'user',
      content: context,
    },
  ];

  for (let turn = 0; turn < MAX_GATEWAY_TURNS; turn += 1) {
    const response = await createGatewayChatCompletion({
      protocol: gateway.protocol,
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      headers: gateway.headers,
      model: gateway.model,
      ...(gateway.maxTokens === undefined ? {} : { maxTokens: gateway.maxTokens }),
      messages,
      tools: TOOL_DEFINITIONS,
    });

    if (response.text.trim()) {
      events.push({ type: 'text', text: response.text });
    }

    if (response.toolCalls.length === 0) {
      events.push(finalGatewayResult(response.text, cwd, toolState));
      return events;
    }

    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    const errorResult = await executeGatewayToolCalls(
      response.toolCalls,
      gateway.toolPolicy,
      events,
      messages,
      toolState
    );
    if (errorResult !== null) {
      return [...events, errorResult];
    }
  }

  return [
    ...events,
    {
      type: 'result',
      success: false,
      error: `Gateway runner exceeded ${MAX_GATEWAY_TURNS} tool turns.`,
    },
  ];
}

interface GatewayToolState {
  lastError: string | null;
}

function finalGatewayResult(text: string, cwd: string, toolState: GatewayToolState): OutputEvent {
  if (toolState.lastError !== null) {
    return gatewayToolFailureResult(toolState.lastError);
  }
  return {
    type: 'result',
    success: true,
    result: {
      text,
      cwd,
    },
  };
}

async function executeGatewayToolCalls(
  toolCalls: readonly GatewayToolCall[],
  toolPolicy: GatewayToolPolicy,
  events: OutputEvent[],
  messages: GatewayChatMessage[],
  toolState: GatewayToolState
): Promise<OutputEvent | null> {
  for (const toolCall of toolCalls) {
    events.push({
      type: 'tool_call',
      toolName: toolCall.name,
      toolId: toolCall.id,
      input: tryParseJson(toolCall.argumentsText) ?? toolCall.argumentsText,
    });

    const toolResult = await executeGatewayTool(toolCall.name, toolCall.argumentsText, toolPolicy);

    events.push({
      type: 'tool_result',
      toolId: toolCall.id,
      content: toolResult.content,
      isError: toolResult.isError,
    });
    if (toolResult.isError) {
      toolState.lastError = toolResultErrorMessage(toolResult.content);
      return gatewayToolFailureResult(toolState.lastError);
    }
    messages.push({
      role: 'tool',
      toolCallId: toolCall.id,
      content: stringifyJson(toolResult.content),
    });
  }
  return null;
}

function toolResultErrorMessage(content: unknown): string {
  if (typeof content === 'string' && content.trim()) return content;
  if (isRecord(content)) {
    const message = content.message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return stringifyJson(content);
}

function gatewayToolFailureResult(message: string): OutputEvent {
  return {
    type: 'result',
    success: false,
    error: `Gateway runner observed a tool failure and cannot verify completion: ${message}`,
  };
}

async function executeGatewayTool(
  toolName: string,
  argumentsText: string,
  toolPolicy: GatewayToolPolicy
): Promise<GatewayToolExecutionResult> {
  let parsedArguments: unknown;
  try {
    parsedArguments = parseJson(argumentsText);
  } catch {
    return {
      content: { message: `Gateway tool "${toolName}" returned malformed JSON arguments.` },
      isError: true,
    };
  }

  try {
    return await executeGatewayToolCall(toolName, parsedArguments, toolPolicy);
  } catch (error) {
    return {
      content: { message: unknownToMessage(error) },
      isError: true,
    };
  }
}

function buildSystemPrompt(toolPolicy: GatewayToolPolicy): string {
  return [
    'You are a noninteractive coding agent.',
    'Use tools only when needed.',
    'Never request confirmation.',
    `Allowed roots: ${toolPolicy.roots.join(', ')}`,
    `Allowlisted commands: ${toolPolicy.commands.join(', ') || '(none)'}`,
    'Return a concise final answer when the task is complete.',
  ].join(' ');
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  try {
    const request = gatewayRunnerRequestFromEnv();
    const events = await runGatewayRequest(request);
    writeEvents(events);
    process.exitCode = 0;
  } catch (error) {
    writeEvents([
      {
        type: 'result',
        success: false,
        error: unknownToMessage(error),
      },
    ]);
    process.exitCode = 0;
  }
}

function writeEvents(events: readonly OutputEvent[]): void {
  for (const event of events) {
    process.stdout.write(`${stringifyJson(event)}\n`);
  }
}

if (require.main === module) {
  void main();
}
