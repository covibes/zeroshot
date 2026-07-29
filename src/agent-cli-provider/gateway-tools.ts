import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { contractError, invalidField } from './contract-errors';
import { getString, isRecord, unknownToMessage } from './json';
import type {
  GatewayBuildOptions,
  GatewayProtocol,
  GatewayToolPolicy,
  ResolvedGatewayBuildOptions,
} from './types';

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export class GatewayPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayPolicyError';
  }
}

export interface GatewayToolExecutionResult {
  readonly content: unknown;
  readonly isError: boolean;
}

interface RunCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
}

interface ApplyPatchRequest {
  readonly path: string;
  readonly content?: string | undefined;
  readonly search?: string | undefined;
  readonly replace?: string | undefined;
  readonly replaceAll: boolean;
}

export function normalizeGatewayBuildOptions(
  value: unknown,
  field: string,
  cwd: string
): GatewayBuildOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    invalidField(field, `${field} must be an object.`);
  }

  const result: Record<string, unknown> = {};
  const protocol = optionalGatewayProtocol(value.protocol, `${field}.protocol`);
  const baseUrl = optionalString(value.baseUrl, `${field}.baseUrl`);
  const apiKey = optionalString(value.apiKey, `${field}.apiKey`);
  const model = optionalNullableString(value.model, `${field}.model`);
  const maxTokens = optionalNullablePositiveInteger(value.maxTokens, `${field}.maxTokens`);
  const headers = optionalStringRecord(value.headers, `${field}.headers`);
  const toolPolicy = optionalGatewayToolPolicy(value.toolPolicy, `${field}.toolPolicy`, cwd);

  if (protocol !== undefined) result.protocol = protocol;
  if (baseUrl !== undefined) result.baseUrl = baseUrl;
  if (typeof apiKey === 'string') result.apiKey = apiKey;
  if (model !== undefined) result.model = model;
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  if (headers !== undefined) result.headers = headers;
  if (toolPolicy !== undefined) result.toolPolicy = toolPolicy;

  return result as GatewayBuildOptions;
}

export function resolveGatewayConfiguration(
  value: GatewayBuildOptions | undefined,
  field: string,
  cwd: string
): ResolvedGatewayBuildOptions {
  if (value === undefined) {
    throw contractError({
      code: 'invalid-field',
      field,
      exitCode: 2,
      message: `${field} is required for the gateway provider.`,
    });
  }
  const protocol = value.protocol ?? 'openai';
  const baseUrl = requiredNonEmptyString(value.baseUrl, `${field}.baseUrl`);
  const apiKey = requiredNonEmptyString(value.apiKey, `${field}.apiKey`);
  const model = requiredNonEmptyString(value.model, `${field}.model`);
  const maxTokens = value.maxTokens;
  const headers = value.headers ?? {};
  const toolPolicy = requiredGatewayToolPolicy(value.toolPolicy, `${field}.toolPolicy`, cwd);

  if (protocol === 'anthropic' && maxTokens === undefined) {
    invalidField(
      `${field}.maxTokens`,
      `${field}.maxTokens is required when ${field}.protocol is "anthropic".`
    );
  }
  assertValidGatewayBaseUrl(baseUrl, `${field}.baseUrl`);
  return {
    protocol,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    headers,
    model,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    toolPolicy,
  };
}

export function validateGatewaySettings(settings: Record<string, unknown>): string | null {
  try {
    const protocol = optionalGatewayProtocol(
      settings.protocol,
      'providerSettings.gateway.protocol'
    );
    optionalString(settings.baseUrl, 'providerSettings.gateway.baseUrl');
    optionalString(settings.apiKey, 'providerSettings.gateway.apiKey');
    optionalNullableString(settings.model, 'providerSettings.gateway.model');
    const maxTokens = optionalNullablePositiveInteger(
      settings.maxTokens,
      'providerSettings.gateway.maxTokens'
    );
    if (protocol === 'anthropic' && maxTokens === undefined) {
      invalidField(
        'providerSettings.gateway.maxTokens',
        'providerSettings.gateway.maxTokens is required when providerSettings.gateway.protocol is "anthropic".'
      );
    }
    optionalStringRecord(settings.headers, 'providerSettings.gateway.headers');
    optionalGatewayToolPolicy(
      settings.toolPolicy,
      'providerSettings.gateway.toolPolicy',
      process.cwd()
    );
    return null;
  } catch (error) {
    return unknownToMessage(error);
  }
}

export function normalizeGatewayToolPolicy(
  value: GatewayToolPolicy,
  field: string,
  cwd: string
): GatewayToolPolicy {
  const roots = normalizeGatewayRoots(value.roots, `${field}.roots`, cwd);
  const commands = normalizeGatewayCommands(value.commands, `${field}.commands`);
  const timeoutMs = optionalFiniteInteger(value.commandTimeoutMs, `${field}.commandTimeoutMs`);
  return timeoutMs === undefined
    ? { roots, commands }
    : { roots, commands, commandTimeoutMs: timeoutMs };
}

export async function executeGatewayToolCall(
  toolName: string,
  input: unknown,
  policy: GatewayToolPolicy
): Promise<GatewayToolExecutionResult> {
  switch (toolName) {
    case 'read_file':
      return { content: await readGatewayFile(input, policy), isError: false };
    case 'apply_patch':
      return { content: await applyGatewayPatch(input, policy), isError: false };
    case 'run_command':
      return runGatewayCommand(input, policy);
    default:
      throw new GatewayPolicyError(`Unsupported gateway tool: ${toolName}`);
  }
}

function optionalGatewayToolPolicy(
  value: unknown,
  field: string,
  cwd: string
): GatewayToolPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    invalidField(field, `${field} must be an object.`);
  }

  return normalizeGatewayToolPolicy(
    {
      roots: stringArray(value.roots, `${field}.roots`),
      commands: stringArray(value.commands, `${field}.commands`),
      ...(value.commandTimeoutMs === undefined
        ? {}
        : {
            commandTimeoutMs: requiredFiniteInteger(
              value.commandTimeoutMs,
              `${field}.commandTimeoutMs`
            ),
          }),
    },
    field,
    cwd
  );
}

function requiredGatewayToolPolicy(
  value: GatewayToolPolicy | undefined,
  field: string,
  cwd: string
): GatewayToolPolicy {
  if (value === undefined) {
    throw contractError({
      code: 'invalid-field',
      field,
      exitCode: 2,
      message: `${field} is required for the gateway provider.`,
    });
  }
  return normalizeGatewayToolPolicy(value, field, cwd);
}

function normalizeGatewayRoots(value: readonly string[], field: string, cwd: string): readonly string[] {
  if (value.length === 0) {
    invalidField(field, `${field} must contain at least one root path.`);
  }
  return value.map((root, index) => {
    const normalized = root.trim();
    if (!normalized) {
      invalidField(`${field}[${index}]`, `${field}[${index}] must be a non-empty string.`);
    }
    return path.resolve(cwd, normalized);
  });
}

function normalizeGatewayCommands(value: readonly string[], field: string): readonly string[] {
  return value.map((command, index) => {
    const normalized = command.trim();
    if (!normalized) {
      invalidField(`${field}[${index}]`, `${field}[${index}] must be a non-empty string.`);
    }
    if (/\s/.test(normalized)) {
      invalidField(`${field}[${index}]`, `${field}[${index}] must not contain whitespace.`);
    }
    return normalized;
  });
}

async function assertWithinRoots(
  targetPath: string,
  roots: readonly string[],
  field: string,
  options: { readonly allowMissingLeaf?: boolean } = {}
): Promise<string> {
  const resolvedRoots = await resolveGatewayRoots(roots);
  if (resolvedRoots.length === 0) {
    throw new GatewayPolicyError('toolPolicy.roots must include at least one root.');
  }
  const candidates = getGatewayTargetCandidates(targetPath, resolvedRoots);
  const firstExistingMatch = await resolveFirstMatchingGatewayTarget(candidates, resolvedRoots, {
    throwOnMissing: !options.allowMissingLeaf,
  });
  if (firstExistingMatch !== undefined) return firstExistingMatch;
  if (options.allowMissingLeaf) {
    const missingLeafMatch = await resolveFirstMatchingGatewayTarget(candidates, resolvedRoots, {
      allowMissingLeaf: true,
    });
    if (missingLeafMatch !== undefined) return missingLeafMatch;
  }

  throw new GatewayPolicyError(`${field} must stay within toolPolicy.roots.`);
}

interface ResolvedGatewayRoot {
  readonly configuredPath: string;
  readonly realPath: string;
}

function resolveGatewayRoots(roots: readonly string[]): Promise<readonly ResolvedGatewayRoot[]> {
  return Promise.all(
    roots.map(async (configuredPath) => ({
      configuredPath,
      realPath: await realpath(configuredPath),
    }))
  );
}

function getGatewayTargetCandidates(
  targetPath: string,
  roots: readonly ResolvedGatewayRoot[]
): readonly string[] {
  if (path.isAbsolute(targetPath)) {
    return [path.resolve(targetPath)];
  }
  return roots.map((root) => path.resolve(root.configuredPath, targetPath));
}

async function resolveFirstMatchingGatewayTarget(
  candidates: readonly string[],
  resolvedRoots: readonly ResolvedGatewayRoot[],
  options: { readonly allowMissingLeaf?: boolean; readonly throwOnMissing?: boolean } = {}
): Promise<string | undefined> {
  let firstMissingError: NodeJS.ErrnoException | undefined;

  for (const candidate of candidates) {
    let resolvedTarget: string;
    try {
      resolvedTarget = options.allowMissingLeaf
        ? await resolveGatewayTargetPath(candidate)
        : await realpath(candidate);
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        firstMissingError ??= error;
        continue;
      }
      throw error;
    }

    if (resolvedRoots.some((root) => isWithinRoot(resolvedTarget, root.realPath))) {
      return resolvedTarget;
    }
  }

  if (firstMissingError !== undefined && options.throwOnMissing) {
    throw firstMissingError;
  }
  return undefined;
}

async function resolveGatewayTargetPath(candidatePath: string): Promise<string> {
  try {
    return await realpath(candidatePath);
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
  }

  const missingSegments: string[] = [];
  let current = candidatePath;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new GatewayPolicyError(`Unable to resolve ${candidatePath} within toolPolicy.roots.`);
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
    try {
      const realCurrent = await realpath(current);
      return path.join(realCurrent, ...missingSegments);
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
    }
  }
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === code;
}

function readGatewayFileInput(input: unknown): string {
  if (!isRecord(input)) {
    throw new Error('read_file input must be an object.');
  }
  const targetPath = getString(input, 'path');
  if (!targetPath || !targetPath.trim()) {
    throw new Error('read_file.path must be a non-empty string.');
  }
  return targetPath;
}

async function readGatewayFile(
  input: unknown,
  policy: GatewayToolPolicy
): Promise<Record<string, unknown>> {
  const targetPath = await assertWithinRoots(readGatewayFileInput(input), policy.roots, 'read_file.path');
  const content = await readFile(targetPath, 'utf8');
  return { path: targetPath, content };
}

function readApplyPatchInput(input: unknown): ApplyPatchRequest {
  if (!isRecord(input)) {
    throw new Error('apply_patch input must be an object.');
  }
  const targetPath = getString(input, 'path');
  if (!targetPath || !targetPath.trim()) {
    throw new Error('apply_patch.path must be a non-empty string.');
  }
  const content = optionalRuntimeString(input.content, 'apply_patch.content');
  const search = optionalRuntimeString(input.search, 'apply_patch.search');
  const replace = optionalRuntimeString(input.replace, 'apply_patch.replace');
  const replaceAll = optionalBoolean(input.replaceAll, 'apply_patch.replaceAll') ?? false;
  if (content === undefined) {
    if (search === undefined || replace === undefined) {
      throw new Error('apply_patch requires either content or both search and replace.');
    }
    if (search.length === 0) {
      throw new Error('apply_patch.search must be a non-empty string.');
    }
  }
  return { path: targetPath, content, search, replace, replaceAll };
}

async function applyGatewayPatch(
  input: unknown,
  policy: GatewayToolPolicy
): Promise<Record<string, unknown>> {
  const request = readApplyPatchInput(input);
  const targetPath = await assertWithinRoots(request.path, policy.roots, 'apply_patch.path', {
    allowMissingLeaf: true,
  });
  await mkdir(path.dirname(targetPath), { recursive: true });

  if (request.content !== undefined) {
    await writeFile(targetPath, request.content, 'utf8');
    return { path: targetPath, bytesWritten: Buffer.byteLength(request.content, 'utf8') };
  }

  const current = await readFile(targetPath, 'utf8');
  const search = request.search;
  const replace = request.replace;
  if (search === undefined || replace === undefined) {
    throw new Error('apply_patch requires either content or both search and replace.');
  }
  if (!current.includes(search)) {
    throw new Error('apply_patch.search did not match the target file.');
  }
  const next = request.replaceAll ? current.split(search).join(replace) : current.replace(search, replace);
  await writeFile(targetPath, next, 'utf8');
  return {
    path: targetPath,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
    replaced: request.replaceAll ? 'all' : 'first',
  };
}

function readRunCommandInput(input: unknown): RunCommandRequest {
  if (!isRecord(input)) {
    throw new Error('run_command input must be an object.');
  }
  const command = getString(input, 'command');
  if (!command || !command.trim()) {
    throw new Error('run_command.command must be a non-empty string.');
  }
  if (/\s/.test(command)) {
    throw new GatewayPolicyError('run_command.command must not contain whitespace.');
  }

  const rawArgs = requiredArrayIfPresent(input, 'args', 'run_command.args');
  const args = rawArgs.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`run_command.args[${index}] must be a string.`);
    }
    return item;
  });
  const cwd = optionalRuntimeString(input.cwd, 'run_command.cwd');
  return { command, args, cwd };
}

async function runGatewayCommand(
  input: unknown,
  policy: GatewayToolPolicy
): Promise<GatewayToolExecutionResult> {
  const request = readRunCommandInput(input);
  if (!policy.commands.includes(request.command)) {
    throw new GatewayPolicyError(
      `run_command.command "${request.command}" is not allowlisted by toolPolicy.commands.`
    );
  }

  const timeoutMs = policy.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const result = request.cwd
    ? await spawnGatewayCommand(
        request.command,
        request.args,
        await assertWithinRoots(request.cwd, policy.roots, 'run_command.cwd'),
        timeoutMs
      )
    : await spawnGatewayCommand(
        request.command,
        request.args,
        await resolveDefaultGatewayCommandCwd(policy.roots),
        timeoutMs
      );
  return {
    isError: result.exitCode !== 0 || result.signal !== null,
    content: result,
  };
}

async function resolveDefaultGatewayCommandCwd(roots: readonly string[]): Promise<string> {
  const resolvedRoots = await resolveGatewayRoots(roots);
  if (resolvedRoots.length === 0) {
    throw new GatewayPolicyError('toolPolicy.roots must include at least one root.');
  }
  const [firstRoot] = resolvedRoots;
  if (!firstRoot) {
    throw new GatewayPolicyError('toolPolicy.roots must include at least one root.');
  }
  return firstRoot.realPath;
}

function spawnGatewayCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        command,
        args,
        cwd,
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function requiredNonEmptyString(value: string | null | undefined, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw contractError({
    code: 'invalid-field',
    field,
    exitCode: 2,
    message: `${field} must be a non-empty string.`,
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  invalidField(field, `${field} must be a string.`);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${field} must be a boolean.`);
}

function optionalRuntimeString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`${field} must be a string.`);
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  invalidField(field, `${field} must be a string or null.`);
}

function optionalStringRecord(
  value: unknown,
  field: string
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    invalidField(field, `${field} must be an object with string values.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      invalidField(`${field}.${key}`, `${field}.${key} must be a string.`);
    }
    result[key] = item;
  }
  return result;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    invalidField(field, `${field} must be an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      invalidField(`${field}[${index}]`, `${field}[${index}] must be a string.`);
    }
    return item;
  });
}

function requiredArrayIfPresent(
  record: Record<string, unknown>,
  key: string,
  field: string
): readonly unknown[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

function optionalFiniteInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredFiniteInteger(value, field);
}

function optionalNullablePositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredFiniteInteger(value, field);
}

function optionalGatewayProtocol(value: unknown, field: string): GatewayProtocol | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'openai' || value === 'anthropic') return value;
  invalidField(field, `${field} must be "openai" or "anthropic".`);
}

function requiredFiniteInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  invalidField(field, `${field} must be a positive integer.`);
}

function assertValidGatewayBaseUrl(value: string, field: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalidField(field, `${field} must use http or https.`);
    }
  } catch {
    invalidField(field, `${field} must be a valid URL.`);
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
