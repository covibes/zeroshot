'use strict';

const fs = require('fs');
const {
  createAdapterFacade,
  declaredFailureEvent,
  frozenResourceStatus,
  requestText,
} = require('../../lib/cluster-worker/engine-adapter-common');
const { executeTool, TOOLS, WORKSPACE } = require('./workspace-tools');
const { OPENAI_BASE_URL, OPENAI_API_KEY, ZEROSHOT_MODEL } = Object.freeze({
  OPENAI_BASE_URL: 'http://127.0.0.1:8081/v1',
  OPENAI_API_KEY: 'zeroshot-capsule-sentinel',
  ZEROSHOT_MODEL: 'zeroshot-capsule-model',
});
const MAX_PROXY_RESPONSE_BYTES = 64 * 1024;
const MAX_PROXY_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_TOOL_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_TURNS = 32;

function rejectInheritedSockets() {
  for (const descriptor of fs.readdirSync('/proc/self/fd')) {
    if (Number(descriptor) <= 2) continue;
    let target;
    try {
      target = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (target.startsWith('socket:[')) {
      throw new Error('Capsule worker inherited a trusted service descriptor');
    }
  }
}

function requireFixedEnvironment() {
  const expected = { OPENAI_BASE_URL, OPENAI_API_KEY, ZEROSHOT_MODEL };
  for (const [name, value] of Object.entries(expected)) {
    if (process.env[name] !== value) throw new Error(`Invalid fixed capsule setting: ${name}`);
  }
  if (process.env.ZEROSHOT_ISOLATION_PROFILE !== 'isolation.prepared-worktree@1') {
    throw new Error('Invalid fixed capsule setting: ZEROSHOT_ISOLATION_PROFILE');
  }
  if (process.env.ZEROSHOT_PROVIDER_PROFILE !== 'provider.fixed-proxy@1') {
    throw new Error('Invalid fixed capsule setting: ZEROSHOT_PROVIDER_PROFILE');
  }
  if (process.cwd() !== WORKSPACE) throw new Error('Invalid fixed capsule workspace');
  rejectInheritedSockets();
}

function promptFromRequest(request) {
  return requestText(
    request,
    'Complete the task represented by the prepared artifact inputs in this workspace.'
  );
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('Fixed proxy response body is unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_PROXY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Fixed proxy response exceeded its bound');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes
  ).toString('utf8');
  return JSON.parse(body);
}

function messageFromDocument(document) {
  const message = document?.choices?.[0]?.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Fixed proxy returned a malformed result');
  }
  return message;
}

function toolCallsFromMessage(message) {
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.length === 0)) {
    throw new Error('Fixed proxy returned malformed tool calls');
  }
  return toolCalls;
}

function contentFromMessage(message, toolCalls) {
  const content = message.content;
  if (toolCalls === undefined && (typeof content !== 'string' || content.trim().length === 0)) {
    throw new Error('Fixed proxy returned an empty result');
  }
  return typeof content === 'string' ? content : null;
}

function responseMessage(document) {
  const message = messageFromDocument(document);
  const toolCalls = toolCallsFromMessage(message);
  return { content: contentFromMessage(message, toolCalls), toolCalls };
}

class FixedProxyEngineAdapter {
  constructor() {
    requireFixedEnvironment();
    this.resource = null;
    this.execution = null;
    this.controller = null;
    this.closed = false;
    this.changed = false;
    this.toolBytes = 0;
  }

  start({ request, clusterId, onEvent }) {
    if (this.resource) throw new Error('Fixed proxy adapter owns exactly one run');
    this.resource = { clusterId, onEvent };
    this.controller = new AbortController();
    this.execution = this.execute(request);
    onEvent({ type: 'running' });
    return Object.freeze({ clusterId, artifactsStaged: true });
  }

  async requestCompletion(messages) {
    const body = JSON.stringify({
      model: ZEROSHOT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });
    if (Buffer.byteLength(body) > MAX_PROXY_REQUEST_BYTES) {
      throw new Error('Fixed proxy request exceeded its bound');
    }
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body,
      signal: this.controller.signal,
    });
    if (!response.ok) throw new Error('Fixed proxy rejected the worker request');
    return responseMessage(await readBoundedJson(response));
  }

  complete() {
    if (!this.changed) throw new Error('Fixed proxy completed without a workspace change');
    if (!this.closed) {
      this.resource.onEvent({
        type: 'complete',
        result: { summary: 'Hosted worker completed', status: 'succeeded', artifacts: [] },
      });
    }
  }

  applyToolCalls(messages, completion) {
    messages.push({
      role: 'assistant',
      content: completion.content,
      tool_calls: completion.toolCalls,
    });
    for (const call of completion.toolCalls) {
      const result = executeTool(call);
      this.changed ||= result.changed;
      this.toolBytes += Buffer.byteLength(result.content);
      if (this.toolBytes > MAX_TOTAL_TOOL_BYTES) {
        throw new Error('Tool output exceeded its total bound');
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }

  async execute(request) {
    const messages = [
      {
        role: 'system',
        content:
          'Modify the prepared workspace to complete the task. Use only the provided file tools. A successful turn requires at least one real file change.',
      },
      { role: 'user', content: promptFromRequest(request) },
    ];
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
        const completion = await this.requestCompletion(messages);
        if (!completion.toolCalls) {
          this.complete();
          return;
        }
        this.applyToolCalls(messages, completion);
      }
      throw new Error('Fixed proxy exceeded its tool-turn bound');
    } catch {
      if (!this.closed && !this.controller.signal.aborted) {
        this.resource.onEvent(declaredFailureEvent());
      }
    }
  }

  status() {
    return frozenResourceStatus(this.resource, this.closed ? 'released' : 'running');
  }

  async stop() {
    if (!this.resource) throw new Error('Fixed proxy adapter has no run');
    this.closed = true;
    this.controller.abort();
    await this.execution;
    return Object.freeze({ effective: true });
  }

  async waitForCleanup() {
    await this.execution;
  }

  close() {
    this.closed = true;
    this.controller?.abort();
  }
}

function createFixedProxyEngineAdapter() {
  return createAdapterFacade(new FixedProxyEngineAdapter());
}

module.exports = { createFixedProxyEngineAdapter };
