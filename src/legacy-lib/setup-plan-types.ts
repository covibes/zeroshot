export type SettingsMap = Record<string, unknown>;
export type DecisionScope = 'global' | 'repo';

export interface DecisionTarget {
  path: string;
  scope: DecisionScope;
}

export interface SetupEnvironment {
  CI?: string;
  __isTTY?: boolean;
  npm_config_global?: string;
  npm_execpath?: string;
}

interface ProviderMetadata {
  binary: string;
  displayName: string;
  installInstructions: string;
}

interface ProviderAdapter {
  cliCommand?: string;
  isAvailable(): boolean;
}

export interface ProviderLevelDefaults {
  defaultLevel?: unknown;
  maxLevel?: unknown;
  minLevel?: unknown;
}

export interface SetupPlanDependencies {
  checkDocker(): { available: unknown };
  checkGhAuth(): { authenticated: unknown };
  commandExists(command: string): boolean;
  execSync(command: string, options: { cwd: string; encoding: 'utf8'; stdio: 'pipe' }): string;
  getCommandPath(command: string): string | null;
  getDefaultProviderId(): string;
  getNodeVersion(): string;
  getPackageVersion(): string;
  getProvider(name: string): ProviderAdapter;
  getProviderDefaults(): Record<string, ProviderLevelDefaults | undefined>;
  getProviderMetadata(name: string): ProviderMetadata;
  listProviders(): string[];
}

export interface ProviderFact {
  available: boolean;
  displayName: string;
  installInstructions: string;
  path: string | null;
}

export interface SetupFacts {
  docker: { available: boolean };
  git: {
    branch: string | null;
    ghAuthed: boolean | null;
    ghAvailable: boolean;
    isRepo: boolean;
    remote: string | null;
  };
  node: { installSource: string; packageVersion: string; version: string };
  providers: Record<string, ProviderFact>;
  settings: { hasGlobal: boolean; hasRepo: boolean };
}

export interface SetupDecision {
  currentValue: unknown;
  decisionId: string;
  domain: string;
}

export interface ProposedWrite extends DecisionTarget {
  decisionId: string;
  from: unknown;
  to: unknown;
}

export interface BuildSetupPlanParams {
  cwd?: string;
  deps?: Partial<SetupPlanDependencies>;
  env?: SetupEnvironment;
  repoSettings?: SettingsMap | null;
  settings?: SettingsMap;
}

export interface SetupPlan {
  decisions: SetupDecision[];
  facts: SetupFacts;
  proposedWrites: ProposedWrite[];
  recommended: Record<string, unknown>;
  risk: Record<string, string>;
  schemaVersion: number;
}
