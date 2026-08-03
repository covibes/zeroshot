import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { acquireTargetLock } from './credential-lock.ts';
import { KeyringCredentialStore } from './credential-store.ts';
import { discoverTargetSessionEndpoints } from './discovery.ts';
import { getTarget, type SettingsPort } from './target-registry.ts';
import { getAccessTokenProvider, type TargetAccessTokenProvider } from './target-session.ts';

const DEFAULT_MODEL = 'openai/gpt-5.4';
const RUN_INTENT_VERSION = 'zeroshot.run-intent/v1';
const MAX_RUN_INTENT_BYTES = 1024 * 1024 + 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUN_INTENT_POLL_MS = 500;
const SUBMISSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPSULE_SIZES = new Set(['tiny', 'small', 'standard', 'large']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const RUN_INTENT_STATES = new Set([
  'queued',
  'provisioning',
  'running',
  'cancelling',
  ...TERMINAL_STATES,
]);

interface HostedOptions {
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

interface HostedRunIntent {
  readonly intent_id: string;
  readonly state: string;
  readonly waiting_reason: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error_code: string | null;
  readonly [key: string]: unknown;
}

interface HostedRunDependencies {
  readonly settings: SettingsPort;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly stdout?: { write(value: string): void };
}

interface HostedContext {
  readonly targetName: string;
  readonly organization: string;
  readonly client: RunIntentClient;
}

interface ResolvedInput {
  readonly repository: string;
  readonly request: Record<string, unknown>;
}

export class HostedRunHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'HostedRunHttpError';
    this.status = status;
    this.code = code;
  }
}

function output(deps: HostedRunDependencies, value: string): void {
  (deps.stdout ?? process.stdout).write(`${value}\n`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validRepository(value: string): boolean {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function validModel(value: string): boolean {
  return (
    value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function repositoryFromRemote(cwd = process.cwd()): string | null {
  let remote: string;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const match = remote.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/
  );
  const repository = match?.[1];
  return repository && validRepository(repository) ? repository : null;
}

function isolationProfile(options: HostedOptions): string {
  return options.pr ? 'isolation.pr@1' : 'isolation.worktree@1';
}

function providerProfile(options: HostedOptions): string {
  return options.pr ? 'provider.codex-openrouter-pr@1' : 'provider.codex-openrouter@1';
}

function promptRequest(prompt: string, options: HostedOptions): Record<string, unknown> {
  return {
    source: 'prompt',
    prompt,
    artifacts: [],
    isolationProfile: isolationProfile(options),
    providerProfile: providerProfile(options),
  };
}

function issueRequest(issue: string, options: HostedOptions): Record<string, unknown> {
  return {
    source: 'issue',
    issue,
    artifacts: [],
    isolationProfile: isolationProfile(options),
    providerProfile: providerProfile(options),
  };
}

function issueInput(value: string, options: HostedOptions): ResolvedInput | null {
  const shorthand = value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/);
  if (shorthand?.[1] && shorthand[2] && validRepository(shorthand[1])) {
    const issue = `https://github.com/${shorthand[1]}/issues/${shorthand[2]}`;
    return { repository: shorthand[1], request: issueRequest(issue, options) };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/);
  const repository = match?.[1] && match[2] ? `${match[1]}/${match[2]}` : '';
  if (url.hostname !== 'github.com' || !match || !validRepository(repository)) return null;
  return { repository, request: issueRequest(url.href, options) };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('zeroshot run - requires piped input');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 1024 * 1024) throw new Error('hosted task input exceeds 1 MiB');
    chunks.push(value);
  }
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (!value) throw new Error('hosted task input is empty');
  return value;
}

function readTaskFile(filename: string): string | null {
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filename, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    if (code === 'ELOOP') throw new Error(`hosted task file must not be a symlink: ${filename}`);
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) return null;
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function resolveHostedInput(
  input: string,
  options: HostedOptions,
  environment: NodeJS.ProcessEnv = process.env
): Promise<ResolvedInput> {
  const explicitIssue = issueInput(input, options);
  if (explicitIssue) return explicitIssue;
  const repository =
    options.repository ?? environment['ZEROSHOT_REPOSITORY'] ?? repositoryFromRemote();
  if (!validRepository(repository ?? '')) {
    throw new Error(
      'hosted runs need a GitHub repository; use org/repo#123, --repository owner/name, ' +
        'ZEROSHOT_REPOSITORY, or run inside a GitHub checkout'
    );
  }
  if (/^[1-9][0-9]*$/.test(input)) {
    return { repository: repository!, request: issueRequest(input, options) };
  }
  const prompt = input === '-' ? await readStdin() : (readTaskFile(path.resolve(input)) ?? input);
  if (!prompt.trim()) throw new Error('hosted task input is empty');
  return { repository: repository!, request: promptRequest(prompt.trim(), options) };
}

function githubToken(environment: NodeJS.ProcessEnv): string {
  const configured = environment['GH_TOKEN'] ?? environment['GITHUB_TOKEN'];
  if (configured?.trim()) return configured.trim();
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return token;
  } catch {
    // The actionable error below covers missing and unauthenticated gh alike.
  }
  throw new Error('hosted runs require GH_TOKEN/GITHUB_TOKEN or an authenticated gh CLI');
}

function providerKey(environment: NodeJS.ProcessEnv): string {
  const key = environment['OPENROUTER_API_KEY'];
  if (!key?.trim()) throw new Error('hosted Codex runs require OPENROUTER_API_KEY');
  return key.trim();
}

export function validateHostedOptions(options: HostedOptions): void {
  const unsupported: ReadonlyArray<readonly [keyof HostedOptions, string]> = [
    ['config', '--config'],
    ['docker', '--docker'],
    ['worktree', '--worktree'],
    ['dockerImage', '--docker-image'],
    ['strictSchema', '--strict-schema'],
    ['ship', '--ship'],
    ['prBase', '--pr-base'],
    ['mergeQueue', '--merge-queue'],
    ['closeIssue', '--close-issue'],
    ['workers', '--workers'],
    ['gitlab', '--gitlab'],
    ['jira', '--jira'],
    ['devops', '--devops'],
    ['linear', '--linear'],
    ['mount', '--mount'],
    ['noMounts', '--no-mounts'],
    ['containerHome', '--container-home'],
  ];
  const selected = unsupported
    .filter(([name]) => options[name] !== undefined && options[name] !== false)
    .map(([, flag]) => flag);
  if (options.provider && options.provider !== 'codex') selected.push('--provider');
  if (selected.length) throw new Error(`hosted runs do not support ${selected.join(', ')}`);
  if (!options.target) throw new Error('hosted runs require --target');
  if (options.model !== undefined && !validModel(options.model)) {
    throw new Error('hosted runs require an exact provider/model slug');
  }
  if (!CAPSULE_SIZES.has(options.size ?? 'standard')) {
    throw new Error('hosted runs require --size tiny, small, standard, or large');
  }
  if (options.submissionKey !== undefined && !SUBMISSION_KEY.test(options.submissionKey)) {
    throw new Error('hosted runs require --submission-key to be a random UUID');
  }
}

function validateIntent(value: unknown): HostedRunIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Zero Cloud returned an invalid run intent');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['intent_id'] !== 'string' ||
    !UUID.test(record['intent_id']) ||
    typeof record['state'] !== 'string' ||
    !RUN_INTENT_STATES.has(record['state'])
  ) {
    throw new Error('Zero Cloud returned an invalid run intent');
  }
  const result = record['result'];
  if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
    throw new Error('Zero Cloud returned an invalid run intent result');
  }
  return record as unknown as HostedRunIntent;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error('Zero Cloud response exceeded 1 MiB');
  }
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Zero Cloud response exceeded 1 MiB');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Zero Cloud returned invalid JSON');
  }
}

class RunIntentClient {
  private readonly baseUrl: string;
  private readonly organization: string;
  private readonly tokenProvider: TargetAccessTokenProvider;
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    organization: string,
    tokenProvider: TargetAccessTokenProvider,
    fetchImplementation: typeof globalThis.fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.organization = organization;
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImplementation;
  }

  async submit(body: Record<string, unknown>, submissionKey: string): Promise<HostedRunIntent> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.request('', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Idempotency-Key': submissionKey },
        });
      } catch (error) {
        failure = error;
        if (error instanceof HostedRunHttpError && error.status < 500) throw error;
        if (attempt === 0) await wait(250);
      }
    }
    throw failure;
  }

  get(intentId: string): Promise<HostedRunIntent> {
    return this.request(`/${encodeURIComponent(intentId)}`, { method: 'GET' });
  }

  cancel(intentId: string): Promise<HostedRunIntent> {
    return this.request(`/${encodeURIComponent(intentId)}`, { method: 'DELETE' });
  }

  private async request(
    suffix: string,
    options: { method: string; body?: string; headers?: Record<string, string> }
  ): Promise<HostedRunIntent> {
    const token = await this.tokenProvider.getAccessToken();
    const url = `${this.baseUrl}/orgs/${encodeURIComponent(this.organization)}/run-intents${suffix}`;
    const init: RequestInit & { redirect: 'error' } = {
      method: options.method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };
    if (options.body !== undefined) init.body = options.body;
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      throw new Error(
        `Zero Cloud request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const body = await readBoundedJson(response);
    if (!response.ok) {
      const problem = body as Record<string, unknown>;
      const code = typeof problem['code'] === 'string' ? problem['code'] : null;
      const message =
        typeof problem['message'] === 'string' ? problem['message'] : 'request failed';
      throw new HostedRunHttpError(
        response.status,
        `Zero Cloud ${response.status}: ${message}`,
        code
      );
    }
    return validateIntent(body);
  }
}

async function context(targetName: string, deps: HostedRunDependencies): Promise<HostedContext> {
  const environment = deps.environment ?? process.env;
  const target = getTarget(targetName, deps.settings);
  if (!target) throw new Error(`Target "${targetName}" not found.`);
  const http = {
    fetch: (url: string, init: RequestInit & { redirect: 'error' }) =>
      (deps.fetch ?? globalThis.fetch)(url, init),
  };
  const discovery = await discoverTargetSessionEndpoints(target.url, http);
  const ephemeralToken = environment['ZEROSHOT_TARGET_ACCESS_TOKEN']?.trim();
  const ephemeralOrganization = environment['ZEROSHOT_TARGET_ORGANIZATION']?.trim();
  if ((ephemeralToken && !ephemeralOrganization) || (!ephemeralToken && ephemeralOrganization)) {
    throw new Error(
      'ZEROSHOT_TARGET_ACCESS_TOKEN and ZEROSHOT_TARGET_ORGANIZATION must be provided together'
    );
  }

  let organization: string;
  let tokenProvider: TargetAccessTokenProvider;
  if (ephemeralToken && ephemeralOrganization) {
    organization = ephemeralOrganization;
    tokenProvider = { getAccessToken: async () => ephemeralToken };
  } else {
    if (!target.organization) {
      throw new Error(`Login required. Run: zeroshot target login ${targetName}`);
    }
    organization = target.organization.id;
    const credentials = await KeyringCredentialStore.create();
    tokenProvider = getAccessTokenProvider(
      targetName,
      target,
      credentials,
      () => acquireTargetLock(target.id),
      { http, discoveryEndpoints: discovery }
    );
  }

  return {
    targetName,
    organization,
    client: new RunIntentClient(
      discovery.capsuleApiBaseUrl,
      organization,
      tokenProvider,
      deps.fetch ?? globalThis.fetch
    ),
  };
}

function displayState(intent: HostedRunIntent): string {
  return intent.waiting_reason ? `${intent.state} (${intent.waiting_reason})` : intent.state;
}

function resumeCommand(value: HostedContext, intentId: string): string {
  return `zeroshot target status ${value.targetName} ${intentId} --follow`;
}

async function follow(
  value: HostedContext,
  initial: HostedRunIntent,
  deps: HostedRunDependencies
): Promise<Record<string, unknown> | null> {
  let intent = initial;
  let displayed: string | null = null;
  for (;;) {
    const state = displayState(intent);
    if (state !== displayed) {
      output(deps, `Run ${intent.intent_id}: ${state}`);
      displayed = state;
    }
    if (TERMINAL_STATES.has(intent.state)) break;
    await (deps.delay ?? wait)(RUN_INTENT_POLL_MS);
    intent = await value.client.get(intent.intent_id);
  }
  if (intent.state === 'succeeded') {
    const summary = intent.result?.['summary'];
    if (typeof summary === 'string' && summary) output(deps, summary);
    return intent.result;
  }
  const detail = intent.error_code ? ` (${intent.error_code})` : '';
  throw new Error(`hosted run ${intent.state}${detail}`);
}

export async function runHosted(
  input: string,
  options: HostedOptions,
  deps: HostedRunDependencies
): Promise<HostedRunIntent | Record<string, unknown> | null> {
  validateHostedOptions(options);
  const environment = deps.environment ?? process.env;
  const resolved = await resolveHostedInput(input, options, environment);
  const value = await context(options.target!, deps);
  const body = {
    label: 'zeroshot-cli',
    size: options.size ?? 'standard',
    intent: {
      version: RUN_INTENT_VERSION,
      credentials: {
        githubToken: githubToken(environment),
        openrouterApiKey: providerKey(environment),
        repository: resolved.repository,
        model: options.model ?? DEFAULT_MODEL,
      },
      request: resolved.request,
    },
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_RUN_INTENT_BYTES) {
    throw new Error('hosted run intent exceeds the 1088 KiB upload limit');
  }
  const submissionKey = options.submissionKey ?? crypto.randomUUID();
  let created: HostedRunIntent;
  try {
    created = await value.client.submit(body, submissionKey);
  } catch (error) {
    if (error instanceof HostedRunHttpError) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Recover this submission by rerunning ` +
        `the same command with --submission-key ${submissionKey}`,
      { cause: error }
    );
  }
  output(deps, `Run ${created.intent_id} queued`);
  output(deps, `Resume: ${resumeCommand(value, created.intent_id)}`);
  if (options.detach) return created;
  output(deps, 'Ctrl+C disconnects without cancelling.');
  return follow(value, created, deps);
}

export async function statusHostedRun(
  targetName: string,
  intentId: string,
  shouldFollow: boolean,
  deps: HostedRunDependencies
): Promise<HostedRunIntent | Record<string, unknown> | null> {
  if (!UUID.test(intentId)) throw new Error('run intent id must be a UUID');
  const value = await context(targetName, deps);
  const intent = await value.client.get(intentId);
  if (!shouldFollow) {
    output(deps, JSON.stringify(intent, null, 2));
    return intent;
  }
  if (!TERMINAL_STATES.has(intent.state)) {
    output(deps, `Following ${intentId}; Ctrl+C disconnects without cancelling.`);
    output(deps, `Resume: ${resumeCommand(value, intentId)}`);
  }
  return follow(value, intent, deps);
}

export async function cancelHostedRun(
  targetName: string,
  intentId: string,
  deps: HostedRunDependencies
): Promise<HostedRunIntent> {
  if (!UUID.test(intentId)) throw new Error('run intent id must be a UUID');
  const value = await context(targetName, deps);
  const intent = await value.client.cancel(intentId);
  output(deps, `Run ${intent.intent_id}: ${displayState(intent)}`);
  return intent;
}

export type { HostedOptions, HostedRunDependencies, HostedRunIntent };
