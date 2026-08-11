export type SettingsMap = Record<string, unknown>;
export type DecisionScope = 'global' | 'repo';

export interface DecisionTarget {
  path: string;
  scope: DecisionScope;
}

export interface JournalEntry {
  appliedAt: string;
  appliedValue: unknown;
  path: string;
  priorValue: unknown;
  repoRoot: string | null;
  scope: string;
}

export interface SetupJournal {
  entries: JournalEntry[];
  version: number;
}

export interface ApplyDependencies {
  VALID_PROVIDERS: readonly string[];
  checkGhAuth(): { authenticated?: unknown } | null;
  listIssueProviders(): string[];
  loadSettings(): SettingsMap;
  mutateSettings<T>(mutator: (settings: SettingsMap) => T): T;
  now(): string;
  readFile(filePath: string): string;
  readRepoSettings(cwd: string): { repoRoot: string | null; settings: SettingsMap | null };
  writeRepoSettings(repoRoot: string | null, settings: SettingsMap): unknown;
}

export interface ResolvedDecision {
  decisionId: string;
  inputValue: unknown;
  target: DecisionTarget;
  writeValue: unknown;
}

export interface DecisionResult {
  applied: boolean;
  decisionId: string;
  from: unknown;
  skippedReason?: string;
  to: unknown;
}

export interface PendingWrite {
  path: string;
  priorValue: unknown;
  scope: DecisionScope;
  settingsObj: SettingsMap;
  writeValue: unknown;
}

interface SharedApplyParams {
  allowRiskyDefaults?: boolean;
  cwd: string;
  deps?: Partial<ApplyDependencies>;
}

export interface ApplyDecisionValuesParams extends SharedApplyParams {
  decisions: unknown;
}

export interface ApplyDecisionsParams extends SharedApplyParams {
  decisionsPath: string;
}
