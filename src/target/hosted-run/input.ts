import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { HostedOptions, ResolvedInput } from './contracts.js';

const SUBMISSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const CAPSULE_SIZES = new Set(['tiny', 'small', 'standard', 'large']);

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

export function githubToken(environment: NodeJS.ProcessEnv): string {
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

export function providerKey(environment: NodeJS.ProcessEnv): string {
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
