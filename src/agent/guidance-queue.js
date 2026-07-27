const GUIDANCE_BLOCK_START = '<<GUIDANCE_QUEUE_START>>';
const GUIDANCE_BLOCK_END = '<<GUIDANCE_QUEUE_END>>';

function formatGuidanceMessage(message) {
  const timestamp = Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : new Date().toISOString();
  const sender = message.sender || 'unknown';
  const topic = message.topic || 'GUIDANCE';
  const target = message.receiver || message.target_agent_id;
  const targetSuffix = target ? ` -> ${target}` : '';

  let formatted = `[${timestamp}] ${sender} (${topic}${targetSuffix})\n`;
  if (message.content?.text) {
    formatted += `${message.content.text}\n`;
  }
  if (message.content?.data) {
    formatted += `${JSON.stringify(message.content.data, null, 2)}\n`;
  }

  return formatted.trimEnd();
}

function orderGuidanceMessages(messages, orderBySequence) {
  return messages.slice().sort((a, b) => {
    if (orderBySequence) {
      return (a.sequence || 0) - (b.sequence || 0);
    }
    return (a.timestamp || 0) - (b.timestamp || 0);
  });
}

function formatGuidanceBlock(messages, { orderBySequence = false } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const ordered = orderGuidanceMessages(messages, orderBySequence);

  let block = '## Guidance (Queued)\n\n';
  block += `${GUIDANCE_BLOCK_START}\n`;

  ordered.forEach((message, index) => {
    block += `${formatGuidanceMessage(message)}\n`;
    if (index < ordered.length - 1) {
      block += '\n';
    }
  });

  block += `\n${GUIDANCE_BLOCK_END}\n\n`;
  return block;
}

function collectQueuedGuidance({
  messageBus,
  clusterId,
  agentId,
  afterId,
  throughId,
  lastDeliveredAt,
  limit,
}) {
  if (!messageBus) {
    throw new Error('collectQueuedGuidance: messageBus is required');
  }
  if (!clusterId) {
    throw new Error('collectQueuedGuidance: clusterId is required');
  }
  if (!agentId) {
    throw new Error('collectQueuedGuidance: agentId is required');
  }

  const messages = messageBus.queryGuidanceMailbox({
    cluster_id: clusterId,
    target_agent_id: agentId,
    afterId,
    throughId,
    lastDeliveredAt,
    limit,
  });

  if (!messages.length) {
    return { messages: [], latestSequence: null, latestTimestamp: null, guidanceBlock: '' };
  }

  const sequenceBounded = afterId !== undefined || throughId !== undefined;
  const ordered = orderGuidanceMessages(messages, sequenceBounded);
  const latestSequence = ordered[ordered.length - 1].sequence;
  const latestTimestamp = ordered[ordered.length - 1].timestamp;
  const guidanceBlock = formatGuidanceBlock(ordered, { orderBySequence: sequenceBounded });

  return { messages: ordered, latestSequence, latestTimestamp, guidanceBlock };
}

module.exports = {
  GUIDANCE_BLOCK_START,
  GUIDANCE_BLOCK_END,
  formatGuidanceBlock,
  collectQueuedGuidance,
};
