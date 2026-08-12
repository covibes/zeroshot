import { spawnSync } from 'child_process';

type CloseIssueMode = 'auto' | 'always' | 'never';

interface RunOptions extends Record<string, unknown> {
  closeIssue?: unknown;
  dockerImage?: unknown;
  isolation?: unknown;
  mergeQueue?: unknown;
  mount?: readonly string[] | null;
  noIsolation?: unknown;
  prBase?: unknown;
  prBody?: unknown;
}

interface MountSpec {
  host: string;
  container: string;
  readonly: boolean;
}

function firstTruthy<T>(...values: T[]): T | undefined {
  return values.find(Boolean);
}

function anyTruthy(...values: unknown[]): boolean {
  return values.some(Boolean);
}

function optionalValue<T>(value: T): T | undefined {
  return value || undefined;
}

function detectGitRepoRoot(): string {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      return process.cwd();
    }
    return result.stdout.trim();
  } catch {
    return process.cwd();
  }
}

function resolveTargetCwd(): string | undefined {
  return firstTruthy(process.env.ZEROSHOT_CWD, detectGitRepoRoot());
}

function resolveOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEnvBool(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '1' || trimmed === 'true' || trimmed === 'yes') return true;
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'no') return false;
  return undefined;
}

function resolveCloseIssueMode(value: unknown): CloseIssueMode | undefined {
  const trimmed = resolveOptionalString(value);
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
    return normalized;
  }
  return undefined;
}

function isRunOptions(value: unknown): value is RunOptions {
  return Boolean(value) && typeof value === 'object';
}

function parseRunOptionsEnv(): RunOptions | null {
  const raw = resolveOptionalString(process.env.ZEROSHOT_RUN_OPTIONS);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRunOptions(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseMountSpecs(specs: readonly string[]): MountSpec[] {
  return specs.map((spec) => {
    const parts = spec.split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid mount spec: "${spec}". Format: host:container[:ro]`);
    }
    const [host, container] = parts;
    if (host === undefined || container === undefined) {
      throw new Error(`Invalid mount spec: "${spec}". Format: host:container[:ro]`);
    }
    const readonly = parts[2] === 'ro';
    return { host, container, readonly };
  });
}

const RUN_MODE_KEYS = ['docker', 'worktree', 'pr', 'ship', 'noIsolation', 'isolation'] as const;

function hasExplicitRunMode(options: RunOptions): boolean {
  return RUN_MODE_KEYS.some(
    (key) => options[key] === true || (key === 'isolation' && options[key] === false)
  );
}

function mergeRunOptions(options: RunOptions): RunOptions {
  const envRunOptions = parseRunOptionsEnv();
  if (!envRunOptions) return options;
  if (!hasExplicitRunMode(options)) return { ...envRunOptions, ...options };
  const withoutEnvMode = { ...envRunOptions };
  for (const key of RUN_MODE_KEYS) delete withoutEnvMode[key];
  return { ...withoutEnvMode, ...options };
}

function resolveMergeQueue(options: RunOptions): boolean | undefined {
  if (typeof options.mergeQueue === 'boolean') {
    return options.mergeQueue;
  }
  return resolveEnvBool(process.env.ZEROSHOT_MERGE_QUEUE);
}

function resolvePrBase(options: RunOptions): string | undefined {
  return (
    resolveOptionalString(options.prBase) ||
    resolveOptionalString(process.env.ZEROSHOT_PR_BASE) ||
    undefined
  );
}

function resolveCloseIssue(options: RunOptions): CloseIssueMode | undefined {
  return (
    resolveCloseIssueMode(options.closeIssue) ||
    resolveCloseIssueMode(process.env.ZEROSHOT_CLOSE_ISSUE) ||
    undefined
  );
}

function resolveMounts(options: RunOptions): MountSpec[] | undefined {
  return options.mount ? parseMountSpecs(options.mount) : undefined;
}

export = {
  firstTruthy,
  anyTruthy,
  optionalValue,
  detectGitRepoRoot,
  resolveTargetCwd,
  resolveEnvBool,
  mergeRunOptions,
  resolveMergeQueue,
  resolvePrBase,
  resolveCloseIssue,
  resolveMounts,
};
