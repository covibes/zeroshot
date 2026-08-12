import ledgerSequence = require('../ledger-sequence');

const GUIDANCE_BLOCK_START = '<<GUIDANCE_QUEUE_START>>';
const GUIDANCE_BLOCK_END = '<<GUIDANCE_QUEUE_END>>';
const { compareMessageSequences } = ledgerSequence;

interface GuidanceContent {
  text?: string;
  data?: unknown;
}

interface GuidanceMessage {
  sequence?: string;
  timestamp?: number;
  sender?: string;
  topic?: string;
  receiver?: string;
  target_agent_id?: string;
  content?: GuidanceContent;
}

interface GuidanceFormatOptions {
  orderBySequence?: boolean;
}

interface GuidanceMailboxQuery {
  cluster_id: string;
  target_agent_id: string;
  afterId: string | undefined;
  throughId: string | undefined;
  lastDeliveredAt: number | null | undefined;
  limit: number | undefined;
}

interface GuidanceMessageBus {
  queryGuidanceMailbox(query: GuidanceMailboxQuery): GuidanceMessage[];
}

interface CollectQueuedGuidanceOptions {
  messageBus?: GuidanceMessageBus | null;
  clusterId?: string | null;
  agentId?: string | null;
  afterId?: string;
  throughId?: string;
  lastDeliveredAt?: number | null;
  limit?: number;
}

interface QueuedGuidance {
  messages: GuidanceMessage[];
  latestSequence: string | null | undefined;
  latestTimestamp: number | null | undefined;
  guidanceBlock: string;
}

function formatGuidanceMessage(message: GuidanceMessage): string {
  const timestamp =
    typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
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

function orderGuidanceMessages(
  messages: GuidanceMessage[],
  orderBySequence: boolean
): GuidanceMessage[] {
  return messages.slice().sort((left, right) => {
    if (orderBySequence) {
      return compareMessageSequences(left.sequence || '0', right.sequence || '0');
    }
    return (left.timestamp || 0) - (right.timestamp || 0);
  });
}

function formatGuidanceBlock(
  messages: GuidanceMessage[] | null | undefined,
  { orderBySequence = false }: GuidanceFormatOptions = {}
): string {
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

function emptyQueuedGuidance(): QueuedGuidance {
  return { messages: [], latestSequence: null, latestTimestamp: null, guidanceBlock: '' };
}

function collectQueuedGuidance({
  messageBus,
  clusterId,
  agentId,
  afterId,
  throughId,
  lastDeliveredAt,
  limit,
}: CollectQueuedGuidanceOptions): QueuedGuidance {
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
    return emptyQueuedGuidance();
  }

  const sequenceBounded = afterId !== undefined || throughId !== undefined;
  const ordered = orderGuidanceMessages(messages, sequenceBounded);
  const latestMessage = ordered.at(-1);
  if (!latestMessage) {
    return emptyQueuedGuidance();
  }

  const latestSequence = latestMessage.sequence;
  const latestTimestamp = latestMessage.timestamp;
  const guidanceBlock = formatGuidanceBlock(ordered, { orderBySequence: sequenceBounded });

  return { messages: ordered, latestSequence, latestTimestamp, guidanceBlock };
}

export = {
  GUIDANCE_BLOCK_START,
  GUIDANCE_BLOCK_END,
  formatGuidanceBlock,
  collectQueuedGuidance,
};
