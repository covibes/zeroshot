#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractToolRequest, isRecord, overlaysForTool } = require('./opcore-agent-tool-overlays');

const validationTimeoutMs = 120_000;
const maxFeedbackChars = 4000;
const preWriteChecks = [
  'typescript.syntax',
  'typescript.types',
  'typescript.lint',
  'typescript.function-metrics',
  'typescript.file-length',
  'rust.source-hygiene',
  'rust.fmt',
  'rust.file-length',
  'rust.function-metrics',
  'docs.staleness',
  'docs.freshness',
  'docs.length',
  'docs.dry',
  'docs.content-quality',
  'docs.code-blocks',
  'docs.rules-why',
];

function parseArgs(argv) {
  const args = { harness: 'unknown' };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--harness') args.harness = next || 'unknown';
    else if (arg.startsWith('--harness=')) args.harness = arg.slice('--harness='.length);
    else if (arg === '--repo') args.repo = next;
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    index += arg === '--harness' || arg === '--repo' ? 2 : 1;
  }
  return args;
}

function resolveRepoRoot(explicitRepo, cwd) {
  if (explicitRepo) return path.resolve(explicitRepo);
  const start = path.resolve(cwd || process.cwd());
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: start,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : start;
}

function runValidation(request) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opcore-prewrite-'));
  const requestPath = path.join(tempDir, 'validation-request.json');
  try {
    fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
    const opcoreEntrypoint = require.resolve('opcore');
    const result = spawnSync(
      process.execPath,
      [
        opcoreEntrypoint,
        'validate',
        'pre-write',
        '--request-file',
        requestPath,
        '--timeout-ms',
        String(validationTimeoutMs),
        '--json',
      ],
      {
        cwd: request.repo.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (result.error) throw result.error;
    const payload = JSON.parse((result.stdout || '').trim());
    if (!payload.receipt) {
      throw new Error(result.stderr || result.stdout || `Opcore exited ${result.status}`);
    }
    return payload.receipt;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function feedback(toolName, receipt) {
  const summary = receipt.failureSummary?.message || 'Pre-write validation failed';
  const checks = receipt.checks?.length ? ` checks=${receipt.checks.join(',')}` : '';
  const paths = receipt.overlays?.paths?.length ? ` paths=${receipt.overlays.paths.join(',')}` : '';
  const message = `Opcore write gate blocked ${toolName}: ${summary} status=${receipt.validationStatus}${checks}${paths}\n`;
  return message.length <= maxFeedbackChars
    ? message
    : `${message.slice(0, maxFeedbackChars - 15).trimEnd()} [truncated]\n`;
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk.toString();
  return input;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let mapped;
  try {
    const raw = await readStdin();
    if (!raw.trim()) return 0;
    const envelope = JSON.parse(raw);
    if (!isRecord(envelope)) throw new Error('hook payload must be a JSON object');
    const tool = extractToolRequest(envelope);
    if (!tool) return 0;
    const repoRoot = resolveRepoRoot(args.repo, tool.cwd);
    const overlays = await overlaysForTool(repoRoot, tool);
    if (overlays.length === 0) return 0;
    mapped = {
      toolName: tool.toolName,
      request: {
        requestId: `zeroshot-opcore-agent-gate-${Date.now()}`,
        repo: { repoRoot },
        scope: { kind: 'files', files: overlays.map((overlay) => overlay.path) },
        graph: { mode: 'optional', provider: 'opcore-graph' },
        overlays,
        checks: preWriteChecks,
        reportMode: 'introduced',
      },
    };
  } catch (error) {
    process.stderr.write(
      `Opcore write gate skipped: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 0;
  }

  try {
    const receipt = runValidation(mapped.request);
    if (receipt.ok) return 0;
    process.stderr.write(feedback(mapped.toolName, receipt));
    return 2;
  } catch (error) {
    process.stderr.write(
      `Opcore write gate blocked ${mapped.toolName}: validation command failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
