export type ContextPackPriority = 'required' | 'high' | 'medium' | 'low';
export type ContextPackVariant = 'full' | 'compact';
export type ContextPackStatus = 'included' | 'skipped';

export interface ContextPack {
  id: string;
  section?: string | null;
  priority?: string;
  required?: boolean;
  order?: number;
  preserve?: boolean;
  render?: () => unknown;
  compact?: () => unknown;
}

export interface NormalizedContextPack extends ContextPack {
  priority: ContextPackPriority;
  required: boolean;
  order: number;
}

export interface RenderedVariant {
  text: string;
  chars: number;
  estimatedTokens: number;
}

export interface SelectedVariant extends RenderedVariant {
  variant: ContextPackVariant;
}

export interface IncludedSelection extends SelectedVariant {
  status: 'included';
}

export interface SkippedSelection {
  status: 'skipped';
  variant: null;
  reason: 'empty' | 'budget';
  chars: 0;
  estimatedTokens: 0;
}

export type PackSelection = IncludedSelection | SkippedSelection;

export interface ContextPackDecision {
  id: string;
  section: string | null;
  priority: ContextPackPriority;
  required: boolean;
  status: ContextPackStatus;
  variant: ContextPackVariant | null;
  chars: number;
  estimatedTokens: number;
  order: number;
  reason: string | null;
  truncated: boolean;
}

export interface MutableContextPackDecision extends Omit<ContextPackDecision, 'truncated'> {
  truncated?: boolean;
}

export interface PackSelectionState {
  renderCache: Map<string, RenderedVariant>;
  decisions: Map<string, MutableContextPackDecision>;
  selected: Map<string, SelectedVariant>;
  remainingTokens: number;
  overBudgetTokens: number;
}

export interface ContextPackBudget {
  maxTokens: number | undefined;
  remainingTokens: number | null;
  overBudgetTokens: number;
  finalTokens: number;
}

export interface ContextPackTruncationStage {
  applied: boolean;
  beforeChars: number;
  afterChars: number;
}

export interface ContextPackResult {
  context: string;
  packDecisions: ContextPackDecision[];
  budget: ContextPackBudget;
  truncation: {
    maxContextChars: ContextPackTruncationStage;
  };
}

export interface BuildContextPacksParams {
  packs: ContextPack[];
  maxTokens?: number | undefined;
  maxChars?: number | undefined;
}
