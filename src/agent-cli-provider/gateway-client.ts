import { getArray, getRecord, getString, isRecord, unknownToMessage } from './json';
import type { GatewayProtocol } from './types';

export interface GatewayChatToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface GatewayToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

export interface GatewayChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCalls?: readonly GatewayToolCall[];
  readonly toolCallId?: string;
}

export interface GatewayChatResponse {
  readonly text: string;
  readonly toolCalls: readonly GatewayToolCall[];
}

class GatewayHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GatewayHttpError';
    this.status = status;
  }
}

interface GatewayChatCompletionInput {
  readonly protocol: GatewayProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly model: string;
  readonly maxTokens?: number;
  readonly messages: readonly GatewayChatMessage[];
  readonly tools: readonly GatewayChatToolDefinition[];
}

export function createGatewayChatCompletion(
  input: GatewayChatCompletionInput
): Promise<GatewayChatResponse> {
  if (input.protocol === 'anthropic') {
    if (input.maxTokens === undefined) {
      throw new Error('Gateway Anthropic requests require maxTokens.');
    }
    return createAnthropicChatCompletion({ ...input, maxTokens: input.maxTokens });
  }
  return createOpenAIChatCompletion(input);
}

async function createOpenAIChatCompletion(
  input: GatewayChatCompletionInput
): Promise<GatewayChatResponse> {
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
      ...input.headers,
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages.map((message) => serializeOpenAIMessage(message)),
      tools: input.tools,
      tool_choice: 'auto',
      temperature: 0,
    }),
  });

  const bodyText = await response.text();
  const parsed = tryParseJson(bodyText);
  if (!response.ok) {
    throw httpError(response.status, parsed ?? bodyText);
  }
  if (!isRecord(parsed)) {
    throw new Error('Gateway returned a non-JSON response.');
  }

  const choice = getArray(parsed, 'choices')[0];
  if (!isRecord(choice)) {
    throw new Error('Gateway response did not include choices[0].');
  }
  const message = getRecord(choice, 'message');
  if (message === null) {
    throw new Error('Gateway response did not include choices[0].message.');
  }

  return {
    text: getGatewayMessageText(message),
    toolCalls: getGatewayToolCalls(message),
  };
}

async function createAnthropicChatCompletion(
  input: GatewayChatCompletionInput & { readonly maxTokens: number }
): Promise<GatewayChatResponse> {
  const system = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const response = await fetch(`${input.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      ...input.headers,
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      ...(system ? { system } : {}),
      messages: serializeAnthropicMessages(input.messages),
      tools: input.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      })),
    }),
  });

  const bodyText = await response.text();
  const parsed = tryParseJson(bodyText);
  if (!response.ok) {
    throw httpError(response.status, parsed ?? bodyText);
  }
  if (!isRecord(parsed)) {
    throw new Error('Gateway returned a non-JSON response.');
  }
  return {
    text: getAnthropicMessageText(parsed),
    toolCalls: getAnthropicToolCalls(parsed),
  };
}

function serializeOpenAIMessage(message: GatewayChatMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsText,
        },
      })),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function serializeAnthropicMessages(
  messages: readonly GatewayChatMessage[]
): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: tryParseJson(toolCall.argumentsText) ?? {},
          })),
        ],
      });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function getGatewayMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let text = '';
  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = getString(item, 'type');
    if (type === 'text') {
      text += getString(item, 'text') ?? '';
    }
  }
  return text;
}

function getGatewayToolCalls(message: Record<string, unknown>): readonly GatewayToolCall[] {
  const result: GatewayToolCall[] = [];
  for (const item of getArray(message, 'tool_calls')) {
    if (!isRecord(item)) continue;
    const id = getString(item, 'id');
    const fn = getRecord(item, 'function');
    const name = fn === null ? null : getString(fn, 'name');
    const argumentsText = fn === null ? null : getString(fn, 'arguments');
    if (!id || !name || argumentsText === null) continue;
    result.push({ id, name, argumentsText });
  }
  return result;
}

function getAnthropicMessageText(message: Record<string, unknown>): string {
  return getArray(message, 'content')
    .filter((item) => isRecord(item) && getString(item, 'type') === 'text')
    .map((item) => (isRecord(item) ? getString(item, 'text') ?? '' : ''))
    .join('');
}

function getAnthropicToolCalls(message: Record<string, unknown>): readonly GatewayToolCall[] {
  const result: GatewayToolCall[] = [];
  for (const item of getArray(message, 'content')) {
    if (!isRecord(item) || getString(item, 'type') !== 'tool_use') continue;
    const id = getString(item, 'id');
    const name = getString(item, 'name');
    if (!id || !name) continue;
    result.push({
      id,
      name,
      argumentsText: JSON.stringify(isRecord(item.input) ? item.input : {}),
    });
  }
  return result;
}

function httpError(status: number, body: unknown): GatewayHttpError {
  return new GatewayHttpError(status, buildGatewayErrorMessage(status, body));
}

function buildGatewayErrorMessage(status: number, body: unknown): string {
  if (isRecord(body)) {
    const nested = getRecord(body, 'error');
    if (nested) {
      const message = getString(nested, 'message');
      if (message) return `Gateway request failed with status ${status}: ${message}`;
      return `Gateway request failed with status ${status}: ${unknownToMessage(nested)}`;
    }
    const message = getString(body, 'message');
    if (message) return `Gateway request failed with status ${status}: ${message}`;
  }
  return `Gateway request failed with status ${status}: ${unknownToMessage(body)}`;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
