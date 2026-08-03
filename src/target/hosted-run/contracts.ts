// Shared hosted-run command contracts.

import type { SettingsPort } from '../target-registry.ts';

export interface HostedOptions {
  readonly target?: string;
  readonly repository?: string;
  readonly model?: string;
  readonly size?: string;
  readonly submissionKey?: string;
  readonly detach?: boolean;
  readonly pr?: boolean;
  readonly provider?: string;
  readonly config?: string;
  readonly docker?: boolean;
  readonly worktree?: boolean;
  readonly dockerImage?: string;
  readonly strictSchema?: boolean;
  readonly ship?: boolean;
  readonly prBase?: string;
  readonly mergeQueue?: boolean;
  readonly closeIssue?: string;
  readonly workers?: number;
  readonly gitlab?: boolean;
  readonly jira?: boolean;
  readonly devops?: boolean;
  readonly linear?: boolean;
  readonly mount?: readonly string[];
  readonly noMounts?: boolean;
  readonly containerHome?: string;
}

export interface HostedRunIntent {
  readonly intent_id: string;
  readonly state: string;
  readonly waiting_reason: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error_code: string | null;
  readonly [key: string]: unknown;
}

export interface HostedRunDependencies {
  readonly settings: SettingsPort;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly stdout?: { write(value: string): void };
}

export interface ResolvedInput {
  readonly repository: string;
  readonly request: Record<string, unknown>;
}
