const TOKENS_PER_CHAR_ESTIMATE = 4;

interface SectionMetric {
  chars: number;
  estimatedTokens: number;
}

type SectionMetrics = Record<string, SectionMetric>;

interface ContextPackMetric {
  id?: string;
  section?: string | null;
  status?: string;
  chars?: unknown;
}

interface ContextStrategy {
  maxTokens?: number;
  sources?: unknown[];
  [key: string]: unknown;
}

interface TriggeringMessage {
  topic?: string;
  sender?: string;
}

interface ContextBudgetInput {
  maxTokens?: number | undefined;
  remainingTokens?: number | null;
  overBudgetTokens?: number;
  finalTokens?: number;
}

interface ContextTruncationStage {
  applied: boolean;
  beforeChars: number;
  afterChars: number;
}

interface ContextTruncationInput {
  maxContextChars?: ContextTruncationStage;
}

interface BuildContextMetricsOptions {
  clusterId?: string;
  agentId?: string;
  role?: string;
  iteration?: number;
  triggeringMessage?: TriggeringMessage | null;
  strategy?: ContextStrategy | null;
  sections?: Record<string, unknown> | null;
  packs?: ContextPackMetric[] | null;
  budget?: ContextBudgetInput | null;
  truncation?: ContextTruncationInput | null;
}

interface ContextMetrics {
  clusterId: string | undefined;
  agentId: string | undefined;
  role: string | undefined;
  iteration: number | undefined;
  triggeredBy: string | null;
  triggerFrom: string | null;
  strategy: {
    maxTokens: number;
    sourcesCount: number;
  };
  budget: {
    maxTokens: number;
    remainingTokens: number | null;
    overBudgetTokens: number;
    finalTokens: number;
  };
  packs: ContextPackMetric[];
  sections: SectionMetrics;
  total: SectionMetric;
  truncation: {
    maxContextChars: ContextTruncationStage;
  };
}

interface ContextMessageBus {
  publish(message: {
    cluster_id: string | undefined;
    topic: string;
    sender: string | undefined;
    receiver: string;
    content: { data: ContextMetrics };
  }): unknown;
}

interface EmitContextMetricsOptions {
  messageBus?: ContextMessageBus | null;
  clusterId?: string;
  agentId?: string;
}

function estimateTokensFromChars(chars: unknown): number {
  if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) {
    return 0;
  }

  return Math.ceil(chars / TOKENS_PER_CHAR_ESTIMATE);
}

function buildSectionMetrics(sections: Record<string, unknown>): {
  sectionMetrics: SectionMetrics;
  totalChars: number;
} {
  const sectionMetrics: SectionMetrics = {};
  let totalChars = 0;

  for (const [sectionName, text] of Object.entries(sections)) {
    const safeText = typeof text === 'string' ? text : '';
    const chars = safeText.length;
    const estimatedTokens = estimateTokensFromChars(chars);
    sectionMetrics[sectionName] = { chars, estimatedTokens };
    totalChars += chars;
  }

  return { sectionMetrics, totalChars };
}

function buildSectionMetricsFromPacks(packs: ContextPackMetric[]): {
  sectionMetrics: SectionMetrics;
  totalChars: number;
} {
  const sectionMetrics: SectionMetrics = {};
  let totalChars = 0;

  for (const pack of packs) {
    if (pack.status !== 'included') continue;
    const sectionName = pack.section || pack.id || 'unknown';
    const chars = typeof pack.chars === 'number' && Number.isFinite(pack.chars) ? pack.chars : 0;
    let section = sectionMetrics[sectionName];
    if (!section) {
      section = { chars: 0, estimatedTokens: 0 };
      sectionMetrics[sectionName] = section;
    }
    section.chars += chars;
    totalChars += chars;
  }

  for (const section of Object.values(sectionMetrics)) {
    section.estimatedTokens = estimateTokensFromChars(section.chars);
  }

  return { sectionMetrics, totalChars };
}

function resolveLegacyMaxTokens(strategy: ContextStrategy | null | undefined): number {
  if (!strategy) {
    return 100000;
  }

  return strategy.maxTokens || 100000;
}

function buildContextMetrics({
  clusterId,
  agentId,
  role,
  iteration,
  triggeringMessage,
  strategy,
  sections,
  packs,
  budget,
  truncation,
}: BuildContextMetricsOptions): ContextMetrics {
  const maxTokens = resolveLegacyMaxTokens(strategy);
  const sourcesCount = Array.isArray(strategy?.sources) ? strategy.sources.length : 0;
  const packMetrics = Array.isArray(packs) ? packs : [];

  let sectionMetrics: SectionMetrics = {};
  let totalChars = 0;
  if (packMetrics.length > 0) {
    const packTotals = buildSectionMetricsFromPacks(packMetrics);
    sectionMetrics = packTotals.sectionMetrics;
    totalChars = packTotals.totalChars;
  } else if (sections) {
    const sectionTotals = buildSectionMetrics(sections);
    sectionMetrics = sectionTotals.sectionMetrics;
    totalChars = sectionTotals.totalChars;
  }

  return {
    clusterId,
    agentId,
    role,
    iteration,
    triggeredBy: triggeringMessage?.topic || null,
    triggerFrom: triggeringMessage?.sender || null,
    strategy: {
      maxTokens,
      sourcesCount,
    },
    budget: {
      maxTokens: budget?.maxTokens ?? maxTokens,
      remainingTokens: budget?.remainingTokens === undefined ? null : budget.remainingTokens,
      overBudgetTokens: budget?.overBudgetTokens ?? 0,
      finalTokens: budget?.finalTokens ?? estimateTokensFromChars(totalChars),
    },
    packs: packMetrics,
    sections: sectionMetrics,
    total: {
      chars: totalChars,
      estimatedTokens: estimateTokensFromChars(totalChars),
    },
    truncation: {
      maxContextChars: truncation?.maxContextChars || {
        applied: false,
        beforeChars: totalChars,
        afterChars: totalChars,
      },
    },
  };
}

function updateTotalMetrics(metrics: ContextMetrics | null | undefined, chars: unknown): void {
  if (!metrics || typeof chars !== 'number' || !Number.isFinite(chars)) {
    return;
  }

  metrics.total = {
    chars,
    estimatedTokens: estimateTokensFromChars(chars),
  };
  metrics.budget.finalTokens = estimateTokensFromChars(chars);
  metrics.truncation.maxContextChars.afterChars = chars;
}

function emitContextMetrics(
  metrics: ContextMetrics,
  { messageBus, clusterId, agentId }: EmitContextMetricsOptions
): void {
  if (process.env.ZEROSHOT_CONTEXT_METRICS === '1') {
    console.log('[ContextMetrics]', JSON.stringify(metrics));
  }

  if (process.env.ZEROSHOT_CONTEXT_METRICS_LEDGER === '1' && messageBus?.publish) {
    messageBus.publish({
      cluster_id: clusterId,
      topic: 'CONTEXT_METRICS',
      sender: agentId,
      receiver: 'system',
      content: {
        data: metrics,
      },
    });
  }
}

export = {
  estimateTokensFromChars,
  resolveLegacyMaxTokens,
  buildContextMetrics,
  updateTotalMetrics,
  emitContextMetrics,
};
