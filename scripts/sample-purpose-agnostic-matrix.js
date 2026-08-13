#!/usr/bin/env node
/**
 * Run the real-provider topology sampler over one cohort in the purpose-agnostic
 * Phase 1 matrix. This coordinates existing sample-topology-designs.js runs; it
 * does not execute any generated topology or run a full Zeroshot cluster.
 *
 * Usage:
 *   node scripts/sample-purpose-agnostic-matrix.js --cohort calibration \
 *     --out phase1-evidence/iteration-09-calibration [--concurrency 3]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const MATRIX_PATH = path.join(REPO_ROOT, 'phase1-evidence', 'purpose-agnostic-matrix.json');
const SAMPLER_PATH = path.join(__dirname, 'sample-topology-designs.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function streamLines(stream, prefix) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) console.log(`[${prefix}] ${line}`);
  });
  stream.on('end', () => {
    if (pending) console.log(`[${prefix}] ${pending}`);
  });
}

function runTask(entry, outRoot, provider) {
  const outDir = path.join(outRoot, entry.id);
  const verdictPath = path.join(outDir, 'verdicts.json');

  if (fs.existsSync(verdictPath)) {
    const verdicts = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
    if (
      verdicts.length === 1 &&
      verdicts[0].ok &&
      fs.existsSync(path.join(outDir, 'sample-1.json'))
    ) {
      console.log(`[${entry.id}] already has an admitted sample; skipping`);
      return Promise.resolve({ id: entry.id, ok: true, skipped: true, outDir });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const args = [SAMPLER_PATH, entry.task, '--samples', '1', '--out', outDir];
  if (provider) args.push('--provider', provider);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    streamLines(child.stdout, entry.id);
    streamLines(child.stderr, `${entry.id}:err`);
    child.on('error', (error) =>
      resolve({ id: entry.id, ok: false, error: error.message, outDir })
    );
    child.on('exit', (code, signal) => {
      let admitted = false;
      if (fs.existsSync(verdictPath)) {
        try {
          const verdicts = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
          admitted = verdicts.length === 1 && verdicts[0].ok === true;
        } catch {
          admitted = false;
        }
      }
      resolve({ id: entry.id, ok: code === 0 && admitted, code, signal, outDir });
    });
  });
}

async function main() {
  const cohort = arg('--cohort', null);
  const outArg = arg('--out', null);
  const provider = arg('--provider', null);
  const concurrency = Number(arg('--concurrency', '3'));
  const idsArg = arg('--ids', null);

  if (!cohort || !outArg) {
    fail('usage: sample-purpose-agnostic-matrix.js --cohort <name> --out <dir> [--concurrency N]');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    fail('--concurrency must be an integer from 1 to 6');
  }

  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const selectedIds = idsArg ? new Set(idsArg.split(',').filter(Boolean)) : null;
  const entries = matrix.tasks.filter(
    (entry) => entry.cohort === cohort && (!selectedIds || selectedIds.has(entry.id))
  );
  if (entries.length === 0) fail(`no matrix tasks matched cohort ${cohort}`);
  if (selectedIds && entries.length !== selectedIds.size)
    fail('one or more --ids were not found in the cohort');

  const outRoot = path.resolve(REPO_ROOT, outArg);
  fs.mkdirSync(outRoot, { recursive: true });
  console.log(`Sampling ${entries.length} ${cohort} matrix cells with concurrency ${concurrency}`);
  console.log(`Output: ${outRoot}`);

  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      results.push(await runTask(entry, outRoot, provider));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    cohort,
    generatedAt: new Date().toISOString(),
    provider: provider || 'default',
    seedSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(REPO_ROOT, 'cluster-templates', 'topology-generator.json')))
      .digest('hex'),
    passed: results.filter((result) => result.ok).length,
    total: results.length,
    results,
  };
  fs.writeFileSync(path.join(outRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Cold admission: ${summary.passed}/${summary.total}`);
  process.exit(summary.passed === summary.total ? 0 : 1);
}

main().catch((error) => fail(error.stack || error.message));
