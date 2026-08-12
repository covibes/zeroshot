import contextMetrics = require('./context-metrics');
import contextPackCore = require('./context-pack-core');
import contextPackSelection = require('./context-pack-selection');
import contextPackTruncation = require('./context-pack-truncation');

import type {
  BuildContextPacksParams,
  ContextPackDecision,
  ContextPackResult,
  MutableContextPackDecision,
  NormalizedContextPack,
  SelectedVariant,
} from './context-pack-types';

const { estimateTokensFromChars } = contextMetrics;
const { normalizePack, sortByOrder } = contextPackCore;
const { selectPacks } = contextPackSelection;
const { applyMaxCharsGuard } = contextPackTruncation;

function renderSelectedContext(
  packs: readonly NormalizedContextPack[],
  selected: ReadonlyMap<string, SelectedVariant>
): string {
  let context = '';
  for (const pack of packs) {
    const selectedPack = selected.get(pack.id);
    if (selectedPack) {
      context += selectedPack.text;
    }
  }
  return context;
}

function finalizePackDecisions(
  packs: readonly NormalizedContextPack[],
  decisions: ReadonlyMap<string, MutableContextPackDecision>
): ContextPackDecision[] {
  return packs.map((pack): ContextPackDecision => {
    const decision = decisions.get(pack.id);
    if (!decision) {
      throw new Error(`Missing context-pack decision for "${pack.id}"`);
    }
    return {
      id: decision.id,
      section: decision.section,
      priority: decision.priority,
      required: decision.required,
      status: decision.status,
      variant: decision.variant,
      chars: decision.chars,
      estimatedTokens: decision.estimatedTokens,
      order: decision.order,
      reason: decision.reason,
      truncated: decision.truncated || false,
    };
  });
}

function buildContextPacks({
  packs,
  maxTokens,
  maxChars,
}: BuildContextPacksParams): ContextPackResult {
  const normalized = packs.map(normalizePack);
  const ordered = normalized.slice().sort(sortByOrder);
  const selection = selectPacks(normalized, maxTokens);
  const initialContext = renderSelectedContext(ordered, selection.selected);
  const truncation = applyMaxCharsGuard({
    packs: ordered,
    selected: selection.selected,
    decisions: selection.decisions,
    cache: selection.renderCache,
    maxChars,
    totalChars: initialContext.length,
  });
  const context = truncation.applied
    ? renderSelectedContext(ordered, selection.selected)
    : initialContext;
  const finalChars = context.length;
  const finalTokens = estimateTokensFromChars(finalChars);

  return {
    context,
    packDecisions: finalizePackDecisions(ordered, selection.decisions),
    budget: {
      maxTokens,
      remainingTokens: Number.isFinite(selection.remainingTokens)
        ? selection.remainingTokens
        : null,
      overBudgetTokens: selection.overBudgetTokens,
      finalTokens,
    },
    truncation: {
      maxContextChars: {
        applied: truncation.applied,
        beforeChars: truncation.beforeChars,
        afterChars: truncation.afterChars,
      },
    },
  };
}

export = {
  buildContextPacks,
};
