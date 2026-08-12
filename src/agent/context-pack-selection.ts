import contextPackCore = require('./context-pack-core');

import type {
  IncludedSelection,
  MutableContextPackDecision,
  NormalizedContextPack,
  PackSelection,
  PackSelectionState,
  RenderedVariant,
  SelectedVariant,
} from './context-pack-types';

type SkippedSelection = Extract<PackSelection, { status: 'skipped' }>;

interface TokenBudgetState {
  remainingTokens: number;
  overBudgetTokens: number;
}

const { renderVariant, sortByPriorityThenOrder } = contextPackCore;

function includedSelection(
  variant: IncludedSelection['variant'],
  rendered: RenderedVariant
): IncludedSelection {
  return {
    status: 'included',
    variant,
    chars: rendered.chars,
    estimatedTokens: rendered.estimatedTokens,
    text: rendered.text,
  };
}

function skippedSelection(reason: SkippedSelection['reason']): SkippedSelection {
  return {
    status: 'skipped',
    variant: null,
    reason,
    chars: 0,
    estimatedTokens: 0,
  };
}

function shouldCompactRequired(
  full: RenderedVariant,
  compact: RenderedVariant | null,
  remainingTokens: number
): compact is RenderedVariant {
  return (
    Number.isFinite(remainingTokens) &&
    compact !== null &&
    compact.chars > 0 &&
    full.estimatedTokens > remainingTokens &&
    (compact.estimatedTokens <= remainingTokens || compact.estimatedTokens < full.estimatedTokens)
  );
}

function selectRequiredVariant(
  full: RenderedVariant,
  compact: RenderedVariant | null,
  remainingTokens: number
): IncludedSelection {
  if (full.chars === 0 && compact && compact.chars > 0) {
    return includedSelection('compact', compact);
  }

  if (shouldCompactRequired(full, compact, remainingTokens)) {
    return includedSelection('compact', compact);
  }

  return includedSelection('full', full);
}

function selectOptionalVariant(
  full: RenderedVariant,
  compact: RenderedVariant | null,
  remainingTokens: number
): PackSelection {
  if (!Number.isFinite(remainingTokens) || full.estimatedTokens <= remainingTokens) {
    return includedSelection('full', full);
  }

  if (compact && compact.chars > 0 && compact.estimatedTokens <= remainingTokens) {
    return includedSelection('compact', compact);
  }

  return skippedSelection('budget');
}

function selectVariant(
  pack: NormalizedContextPack,
  remainingTokens: number,
  cache: Map<string, RenderedVariant>
): PackSelection {
  const full = renderVariant(pack, 'full', cache);
  const compact = pack.compact ? renderVariant(pack, 'compact', cache) : null;

  if (full.chars === 0 && (!compact || compact.chars === 0)) {
    return skippedSelection('empty');
  }

  return pack.required
    ? selectRequiredVariant(full, compact, remainingTokens)
    : selectOptionalVariant(full, compact, remainingTokens);
}

function buildDecision(
  pack: NormalizedContextPack,
  selection: PackSelection
): MutableContextPackDecision {
  return {
    id: pack.id,
    section: pack.section || null,
    priority: pack.priority,
    required: pack.required,
    status: selection.status,
    variant: selection.variant,
    chars: selection.chars,
    estimatedTokens: selection.estimatedTokens,
    order: pack.order,
    reason: 'reason' in selection ? selection.reason : null,
  };
}

function consumeSelectionBudget(
  selection: IncludedSelection,
  budget: TokenBudgetState
): TokenBudgetState {
  if (!Number.isFinite(budget.remainingTokens)) {
    return budget;
  }

  if (selection.estimatedTokens > budget.remainingTokens) {
    return {
      remainingTokens: 0,
      overBudgetTokens:
        budget.overBudgetTokens + selection.estimatedTokens - budget.remainingTokens,
    };
  }

  return {
    remainingTokens: budget.remainingTokens - selection.estimatedTokens,
    overBudgetTokens: budget.overBudgetTokens,
  };
}

function selectPacks(
  normalized: readonly NormalizedContextPack[],
  maxTokens: number | undefined
): PackSelectionState {
  const renderCache = new Map<string, RenderedVariant>();
  const decisions = new Map<string, MutableContextPackDecision>();
  const selected = new Map<string, SelectedVariant>();
  let budget: TokenBudgetState = {
    remainingTokens:
      typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? maxTokens : Infinity,
    overBudgetTokens: 0,
  };
  const selectionOrder = normalized.slice().sort(sortByPriorityThenOrder);
  for (const pack of selectionOrder) {
    const selection = selectVariant(pack, budget.remainingTokens, renderCache);
    decisions.set(pack.id, buildDecision(pack, selection));
    if (selection.status !== 'included') {
      continue;
    }
    selected.set(pack.id, {
      text: selection.text,
      chars: selection.chars,
      estimatedTokens: selection.estimatedTokens,
      variant: selection.variant,
    });
    budget = consumeSelectionBudget(selection, budget);
  }

  return {
    renderCache,
    decisions,
    selected,
    remainingTokens: budget.remainingTokens,
    overBudgetTokens: budget.overBudgetTokens,
  };
}

export = {
  selectPacks,
};
