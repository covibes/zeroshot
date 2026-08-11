function piUsage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, optional = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    ...optional,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...(optional.cost || {}),
    },
  };
}

function piBasicSettledEvents(assistant) {
  return [
    { type: 'message_end', message: { role: 'user', content: 'Do the task.' } },
    {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'tool-1', content: [], isError: false },
    },
    { type: 'message_end', message: assistant },
    { type: 'agent_settled' },
  ];
}

module.exports = { piBasicSettledEvents, piUsage };
