import contextMetrics = require('./context-metrics');
import contextPackCore = require('./context-pack-core');

import type {
  ContextPackTruncationStage,
  MutableContextPackDecision,
  NormalizedContextPack,
  RenderedVariant,
  SelectedVariant,
} from './context-pack-types';

interface MaxCharsGuardParams {
  packs: NormalizedContextPack[];
  selected: Map<string, SelectedVariant>;
  decisions: Map<string, MutableContextPackDecision>;
  cache: Map<string, RenderedVariant>;
  maxChars: number | undefined;
  totalChars: number;
}

interface MaxCharsMutationParams {
  selected: Map<string, SelectedVariant>;
  decisions: Map<string, MutableContextPackDecision>;
  cache: Map<string, RenderedVariant>;
  maxChars: number;
}

interface RequiredTruncationParams {
  packs: readonly NormalizedContextPack[];
  selected: Map<string, SelectedVariant>;
  decisions: Map<string, MutableContextPackDecision>;
  currentChars: number;
  maxChars: number;
}

const { estimateTokensFromChars } = contextMetrics;
const { renderVariant, sortByPriorityDescThenOrderDesc } = contextPackCore;

const TRUNCATION_SUFFIX = '\n\n[Context truncated to fit limit]\n';

function truncateText(text: string, targetChars: number): { text: string; truncated: boolean } {
  if (text.length <= targetChars) {
    return { text, truncated: false };
  }

  if (targetChars <= 0) {
    return { text: '', truncated: true };
  }

  if (targetChars <= TRUNCATION_SUFFIX.length) {
    return { text: text.slice(0, targetChars), truncated: true };
  }

  const sliceLength = targetChars - TRUNCATION_SUFFIX.length;
  return {
    text: text.slice(0, sliceLength) + TRUNCATION_SUFFIX,
    truncated: true,
  };
}

function compactOptionalPacks(
  packs: readonly NormalizedContextPack[],
  { selected, decisions, cache, maxChars }: MaxCharsMutationParams,
  startingChars: number
): number {
  let currentChars = startingChars;
  for (const pack of packs) {
    if (currentChars <= maxChars) break;
    const decision = decisions.get(pack.id);
    if (!decision || decision.variant === 'compact' || !pack.compact) continue;

    const compact = renderVariant(pack, 'compact', cache);
    if (compact.chars === 0 || compact.chars >= decision.chars) continue;

    const previousChars = decision.chars;
    selected.set(pack.id, { ...compact, variant: 'compact' });
    decision.variant = 'compact';
    decision.chars = compact.chars;
    decision.estimatedTokens = compact.estimatedTokens;
    decision.reason = decision.reason || 'max_chars';

    currentChars -= previousChars - compact.chars;
    currentChars = Math.max(0, currentChars);
  }
  return currentChars;
}

function dropOptionalPacks(
  packs: readonly NormalizedContextPack[],
  { selected, decisions, maxChars }: MaxCharsMutationParams,
  startingChars: number
): number {
  let currentChars = startingChars;
  for (const pack of packs) {
    if (currentChars <= maxChars) break;
    if (!selected.has(pack.id)) continue;

    const decision = decisions.get(pack.id);
    currentChars -= decision?.chars || 0;
    selected.delete(pack.id);
    if (decision) {
      decision.status = 'skipped';
      decision.reason = decision.reason || 'max_chars';
      decision.chars = 0;
      decision.estimatedTokens = 0;
    }
  }
  return currentChars;
}

function sortRequiredTruncationCandidates(
  packs: readonly NormalizedContextPack[],
  selected: ReadonlyMap<string, SelectedVariant>
): NormalizedContextPack[] {
  return packs
    .filter((pack) => selected.has(pack.id) && pack.required)
    .sort((a, b) => {
      const preserveDelta = (a.preserve ? 1 : 0) - (b.preserve ? 1 : 0);
      if (preserveDelta !== 0) return preserveDelta;
      const sizeDelta = (selected.get(b.id)?.chars || 0) - (selected.get(a.id)?.chars || 0);
      if (sizeDelta !== 0) return sizeDelta;
      return b.order - a.order;
    });
}

function truncateRequiredPacks({
  packs,
  selected,
  decisions,
  currentChars,
  maxChars,
}: RequiredTruncationParams): void {
  let overage = currentChars - maxChars;
  const requiredCandidates = sortRequiredTruncationCandidates(packs, selected);

  for (const pack of requiredCandidates) {
    if (overage <= 0) break;
    const decision = decisions.get(pack.id);
    const selectedPack = selected.get(pack.id);
    if (!decision || !selectedPack) continue;

    const targetChars = Math.max(0, selectedPack.chars - overage);
    const truncated = truncateText(selectedPack.text, targetChars);
    if (truncated.text.length === selectedPack.chars) continue;

    const newChars = truncated.text.length;
    overage -= selectedPack.chars - newChars;
    selected.set(pack.id, {
      text: truncated.text,
      chars: newChars,
      estimatedTokens: estimateTokensFromChars(newChars),
      variant: selectedPack.variant,
    });

    decision.chars = newChars;
    decision.estimatedTokens = estimateTokensFromChars(newChars);
    decision.truncated = true;
    decision.reason = decision.reason || 'max_chars';
  }
}

function selectedChars(selected: ReadonlyMap<string, SelectedVariant>): number {
  return Array.from(selected.values()).reduce((sum, item) => sum + item.chars, 0);
}

function applyMaxCharsGuard({
  packs,
  selected,
  decisions,
  cache,
  maxChars,
  totalChars,
}: MaxCharsGuardParams): ContextPackTruncationStage {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || totalChars <= maxChars) {
    return {
      applied: false,
      beforeChars: totalChars,
      afterChars: totalChars,
    };
  }

  const includedOptional = packs
    .filter((pack) => selected.has(pack.id) && !pack.required)
    .sort(sortByPriorityDescThenOrderDesc);
  const mutationParams = { selected, decisions, cache, maxChars };
  let currentChars = compactOptionalPacks(includedOptional, mutationParams, totalChars);
  currentChars = dropOptionalPacks(includedOptional, mutationParams, currentChars);

  if (currentChars > maxChars) {
    truncateRequiredPacks({
      packs,
      selected,
      decisions,
      currentChars,
      maxChars,
    });
  }

  return {
    applied: true,
    beforeChars: totalChars,
    afterChars: selectedChars(selected),
  };
}

export = {
  applyMaxCharsGuard,
};
