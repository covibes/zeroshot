import contextMetrics = require('./context-metrics');

import type {
  ContextPack,
  ContextPackPriority,
  ContextPackVariant,
  NormalizedContextPack,
  RenderedVariant,
} from './context-pack-types';

const { estimateTokensFromChars } = contextMetrics;

const PRIORITY_RANK: Readonly<Record<ContextPackPriority, number>> = {
  required: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DEFAULT_PRIORITY: ContextPackPriority = 'medium';

function isContextPackPriority(priority: string): priority is ContextPackPriority {
  return (
    priority === 'required' || priority === 'high' || priority === 'medium' || priority === 'low'
  );
}

function normalizePriority(
  priority: string | undefined,
  required: boolean | undefined
): ContextPackPriority {
  if (required) return 'required';
  if (priority && isContextPackPriority(priority)) return priority;
  return DEFAULT_PRIORITY;
}

function normalizePack(pack: ContextPack, index: number): NormalizedContextPack {
  const priority = normalizePriority(pack.priority, pack.required);
  return {
    ...pack,
    priority,
    required: pack.required || priority === 'required',
    order: pack.order ?? index,
  };
}

function renderVariant(
  pack: NormalizedContextPack,
  variant: ContextPackVariant,
  cache: Map<string, RenderedVariant>
): RenderedVariant {
  const cacheKey = `${pack.id}:${variant}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let text: unknown = '';
  if (variant === 'full') {
    text = typeof pack.render === 'function' ? pack.render() : '';
  } else if (variant === 'compact') {
    text = typeof pack.compact === 'function' ? pack.compact() : '';
  }

  const safeText = typeof text === 'string' ? text : '';
  const chars = safeText.length;
  const estimatedTokens = estimateTokensFromChars(chars);
  const rendered = { text: safeText, chars, estimatedTokens };
  cache.set(cacheKey, rendered);
  return rendered;
}

function sortByPriorityThenOrder(a: NormalizedContextPack, b: NormalizedContextPack): number {
  const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return a.order - b.order;
}

function sortByOrder(a: NormalizedContextPack, b: NormalizedContextPack): number {
  return a.order - b.order;
}

function sortByPriorityDescThenOrderDesc(
  a: NormalizedContextPack,
  b: NormalizedContextPack
): number {
  const priorityDelta = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return b.order - a.order;
}

export = {
  normalizePack,
  renderVariant,
  sortByPriorityThenOrder,
  sortByOrder,
  sortByPriorityDescThenOrderDesc,
};
