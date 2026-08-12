import replayPolicy = require('./context-replay-policy');

type MessageTimestamp = string | number;

interface ReplayFields {
  readonly contextSafe?: unknown;
  readonly replayPolicy?: unknown;
  readonly [key: string]: unknown;
}

interface ContextMessage {
  readonly id?: unknown;
  readonly topic?: unknown;
  readonly timestamp: MessageTimestamp;
  readonly sender: string;
  readonly metadata?: ReplayFields | null;
  readonly content?: {
    readonly text?: string | null;
    readonly data?: ReplayFields | null;
  } | null;
}

interface ContextSource {
  topic: string;
  sender?: unknown;
  since?: unknown;
  amount?: number;
  limit?: number;
  strategy?: string;
  compactAmount?: number;
  compactStrategy?: string;
  priority?: string;
}

interface SourceCluster {
  id: string;
  createdAt: number;
}

interface MessageQuery {
  cluster_id: string;
  topic: string;
  sender?: unknown;
  since?: unknown;
  afterId?: unknown;
  throughId?: unknown;
}

interface SourceMessageBus {
  query(criteria: MessageQuery): ContextMessage[];
}

interface SourceSelectionOptions {
  compact?: boolean;
}

interface SourceSelection {
  amount: number | undefined;
  strategy: string;
}

interface SourceMessageParams {
  source: ContextSource;
  messageBus: SourceMessageBus;
  cluster: SourceCluster;
  lastTaskEndTime?: number | null | undefined;
  lastAgentStartTime?: number | null | undefined;
  afterId?: unknown;
  throughId?: unknown;
  triggeringMessageId?: unknown;
  compact?: boolean;
}

interface SourcePackParams extends Omit<SourceMessageParams, 'compact'> {
  index: number;
}

interface SourcePack {
  id: string;
  section: 'sources';
  priority: string;
  render(): string;
  compact(): string;
}

const { isReplayableMessage } = replayPolicy;

function resolveSourceSince(
  source: ContextSource,
  cluster: SourceCluster,
  lastTaskEndTime: number | null | undefined,
  lastAgentStartTime: number | null | undefined
): unknown {
  const sinceValue = source.since;

  if (sinceValue === 'cluster_start') {
    return cluster.createdAt;
  }

  if (sinceValue === 'last_task_end') {
    return lastTaskEndTime || cluster.createdAt;
  }

  if (sinceValue === 'last_agent_start') {
    return lastAgentStartTime ? lastAgentStartTime + 1 : cluster.createdAt;
  }

  if (typeof sinceValue === 'string') {
    const parsed = Date.parse(sinceValue);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `Unknown context source "since" value "${sinceValue}" for topic ${source.topic}. ` +
          'Use cluster_start, last_task_end, last_agent_start, or an ISO timestamp.'
      );
    }
    return parsed;
  }

  return sinceValue;
}

function formatSourceMessagesSection(source: ContextSource, messages: ContextMessage[]): string {
  let context = `\n## Messages from topic: ${source.topic}\n\n`;

  for (const msg of messages) {
    context += `[${new Date(msg.timestamp).toISOString()}] ${msg.sender}:\n`;
    if (msg.content?.text) {
      context += `${msg.content.text}\n`;
    }
    if (msg.content?.data) {
      context += `Data: ${JSON.stringify(msg.content.data, null, 2)}\n`;
    }
    context += '\n';
  }

  return context;
}

function resolveSourceSelection(
  source: ContextSource,
  { compact = false }: SourceSelectionOptions = {}
): SourceSelection {
  const baseAmount = source.amount ?? source.limit;
  const baseStrategy = source.strategy ?? (baseAmount !== undefined ? 'latest' : 'all');

  if (!compact) {
    return { amount: baseAmount, strategy: baseStrategy };
  }

  return {
    amount: source.compactAmount ?? 1,
    strategy: source.compactStrategy ?? (baseStrategy === 'all' ? 'latest' : baseStrategy),
  };
}

function resolveSourceMessages({
  source,
  messageBus,
  cluster,
  lastTaskEndTime,
  lastAgentStartTime,
  afterId,
  throughId,
  triggeringMessageId,
  compact = false,
}: SourceMessageParams): ContextMessage[] {
  const sinceTimestamp = resolveSourceSince(source, cluster, lastTaskEndTime, lastAgentStartTime);
  const { amount, strategy } = resolveSourceSelection(source, { compact });
  const messages = messageBus.query({
    cluster_id: cluster.id,
    topic: source.topic,
    sender: source.sender,
    since: sinceTimestamp,
    afterId,
    throughId,
  });
  const replayableMessages = messages.filter(
    (message) => isReplayableMessage(message) && message.id !== triggeringMessageId
  );

  if (amount === undefined) {
    return replayableMessages;
  }

  if (strategy === 'latest') {
    return replayableMessages.slice(-amount);
  }

  return replayableMessages.slice(0, amount);
}

const REQUIRED_TOPICS = new Set(['STATE_SNAPSHOT', 'ISSUE_OPENED', 'PLAN_READY']);
const HIGH_PRIORITY_TOPICS = new Set(['VALIDATION_RESULT', 'IMPLEMENTATION_READY']);

function resolveSourcePriority(source: ContextSource): string {
  if (source.priority) {
    return source.priority;
  }

  if (REQUIRED_TOPICS.has(source.topic)) {
    return 'required';
  }

  if (HIGH_PRIORITY_TOPICS.has(source.topic)) {
    return 'high';
  }

  return 'medium';
}

function buildSourcePack({
  source,
  index,
  messageBus,
  cluster,
  lastTaskEndTime,
  lastAgentStartTime,
  afterId,
  throughId,
  triggeringMessageId,
}: SourcePackParams): SourcePack {
  const render = (compact: boolean): string => {
    const messages = resolveSourceMessages({
      source,
      messageBus,
      cluster,
      lastTaskEndTime,
      lastAgentStartTime,
      afterId,
      throughId,
      triggeringMessageId,
      compact,
    });

    if (messages.length === 0) {
      return '';
    }

    return formatSourceMessagesSection(source, messages);
  };

  return {
    id: `source:${source.topic}:${index}`,
    section: 'sources',
    priority: resolveSourcePriority(source),
    render: () => render(false),
    compact: () => render(true),
  };
}

export = {
  buildSourcePack,
};
