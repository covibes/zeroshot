const PI_USAGE = {
  input: 7,
  output: 3,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function semanticTask(taskId, provider, logFile) {
  return {
    id: taskId,
    fullPrompt: `exact prompt for ${taskId}`,
    prompt: 'truncated',
    status: 'completed',
    provider,
    model: `${provider}-model`,
    logFile,
  };
}

function watcherFooter() {
  return `\n${'='.repeat(50)}\nFinished: 2026-08-14T12:01:00.000Z\nExit code: 0, Signal: null\n`;
}

function timestamped(lines, timestamp = 1800000000123) {
  return `[${timestamp}][ZEROSHOT][LOG_FORMAT] stderr-tagged-v1\n${lines
    .map((line) => `[${timestamp}]${JSON.stringify(line)}`)
    .join('\n')}\n`;
}

function semanticFixture(provider) {
  if (provider === 'codex') return codexFixture();
  if (provider === 'claude') return claudeFixture();
  return piFixture();
}

function codexFixture() {
  const events = [
    {
      type: 'item.started',
      item: { type: 'command_execution', id: 'codex-tool', command: 'pwd' },
    },
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'codex-tool',
        command: 'pwd',
        aggregated_output: '/tmp',
        exit_code: 0,
      },
    },
    { type: 'item.completed', item: { type: 'agent_message', text: 'codex done' } },
    { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } },
  ];
  const fabricated = { type: 'turn.failed', error: { message: 'stderr must stay native-only' } };
  return `${timestamped(events.slice(0, -1))}[1800000000345][ZEROSHOT][PROVIDER_STDERR] ${JSON.stringify(
    fabricated
  )}\n${timestamped(events.slice(-1), 1800000000456)}`;
}

function claudeFixture() {
  return timestamped([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'considering' },
          { type: 'tool_use', id: 'claude-tool', name: 'Read', input: { file_path: 'x' } },
          { type: 'text', text: 'claude done' },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'claude-tool', content: 'contents' }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'claude done',
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  ]);
}

function piFixture() {
  return `${timestamped([
    {
      type: 'tool_execution_start',
      toolCallId: 'pi-tool',
      toolName: 'bash',
      args: { command: 'pwd' },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'pi-tool',
      result: '/tmp/pi',
      isError: false,
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'pi done' },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'pi done' }],
        usage: PI_USAGE,
        stopReason: 'stop',
      },
    },
    { type: 'agent_settled' },
  ])}[1800000000456][ZEROSHOT][PROVIDER_STDERR] extension initialized\n${watcherFooter()}`;
}

function expectedSemanticEvents(provider) {
  if (provider === 'codex') {
    return [
      { type: 'tool_call', toolName: 'Bash', toolId: 'codex-tool', input: { command: 'pwd' } },
      { type: 'tool_result', toolId: 'codex-tool', content: '/tmp', isError: false },
      { type: 'text', text: 'codex done' },
      { type: 'result', success: true, inputTokens: 4, outputTokens: 2 },
    ];
  }
  if (provider === 'claude') {
    return [
      { type: 'thinking', text: 'considering' },
      { type: 'tool_call', toolName: 'Read', toolId: 'claude-tool', input: { file_path: 'x' } },
      { type: 'text', text: 'claude done' },
      { type: 'tool_result', toolId: 'claude-tool', content: 'contents', isError: false },
      {
        type: 'result',
        success: true,
        result: 'claude done',
        error: null,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        modelUsage: null,
      },
    ];
  }
  return [
    { type: 'tool_call', toolName: 'bash', toolId: 'pi-tool', input: { command: 'pwd' } },
    { type: 'tool_result', toolId: 'pi-tool', content: '/tmp/pi', isError: false },
    { type: 'text', text: 'pi done' },
    {
      type: 'result',
      success: true,
      result: 'pi done',
      error: null,
      cost: 0,
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 0,
      modelUsage: PI_USAGE,
    },
  ];
}

module.exports = {
  expectedSemanticEvents,
  PI_USAGE,
  semanticFixture,
  semanticTask,
  timestamped,
};
