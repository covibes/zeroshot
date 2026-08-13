#!/usr/bin/env node
/**
 * Tier 5: can a real provider actually emit a designable topology?
 *
 * Runs ONLY the topology-designer agent (prompt + jsonSchema lifted straight out
 * of cluster-templates/topology-generator.json) against a real provider N times
 * for one task, then pushes each result through the same admission check the
 * orchestrator would apply.
 *
 * The number that matters is the cold-pass rate: how often a fresh generation is
 * admissible without repair. Everything else in the pipeline is already proven
 * token-free by check-generated-topology.js and the e2e test.
 *
 * Usage:
 *   node scripts/sample-topology-designs.js "<task text>" [--samples 3] [--out <dir>]
 *     [--provider <provider>] [--resume-task <task-id>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SEED_PATH = path.join(REPO_ROOT, 'cluster-templates', 'topology-generator.json');
const CLI = path.join(REPO_ROOT, 'cli', 'index.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function extractJson(text) {
  // Providers wrap structured output in prose or fences often enough that a
  // brace-matched scan beats a single regex.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * `zeroshot task run` spawns a background task and returns immediately, printing
 * the task id. The structured result lands in the task log as a single JSON
 * envelope whose `result` field holds the agent's output.
 */
function waitForTask(taskId, timeoutMs) {
  // Wall time can jump (NTP, sleep/wake, VM clock correction). A sampling task
  // that is still healthy must not be mislabeled as a 15-minute timeout because
  // the system clock moved. process.hrtime is monotonic.
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  while (elapsedMs() < timeoutMs) {
    const status = spawnSync('node', [CLI, 'status', taskId], { encoding: 'utf8' });
    const text = status.stdout || '';
    if (/^Status:\s+(completed|failed|killed)/m.test(text)) {
      const logMatch = text.match(/^Log File:\s+(.+)$/m);
      return { done: true, logPath: logMatch ? logMatch[1].trim() : null, statusText: text };
    }
    spawnSync('sleep', ['5']);
  }
  return { done: false };
}

function readTaskResult(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return null;
  const firstLine = fs.readFileSync(logPath, 'utf8').split('\n')[0];
  let envelope;
  try {
    envelope = JSON.parse(firstLine);
  } catch {
    return extractJson(fs.readFileSync(logPath, 'utf8'));
  }
  if (typeof envelope.result === 'string') {
    try {
      return JSON.parse(envelope.result);
    } catch {
      return extractJson(envelope.result);
    }
  }
  return envelope.result || null;
}

function main() {
  const taskText = process.argv[2];
  if (!taskText || taskText.startsWith('--')) {
    console.error('usage: sample-topology-designs.js "<task text>" [--samples N] [--out DIR]');
    process.exit(1);
  }
  const samples = Number(arg('--samples', '3'));
  const outDir = arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'topogen-samples-')));
  const resumeTask = arg('--resume-task', null);
  const provider = arg('--provider', null);
  if (resumeTask && samples !== 1) {
    console.error('--resume-task requires --samples 1');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const designer = seed.agents.find((a) => a.id === 'topology-designer');
  const prompt = `${designer.prompt.system}\n\n## TASK\n\n${taskText}`;
  const schema = JSON.stringify(designer.jsonSchema);

  console.log(`Sampling ${samples} design(s) for: ${taskText}\nOutput: ${outDir}\n`);

  const verdicts = [];
  for (let i = 1; i <= samples; i++) {
    let taskId = resumeTask;
    let raw = '';
    if (taskId) {
      process.stdout.write(`[${i}/${samples}] resuming ${taskId}... `);
    } else {
      process.stdout.write(`[${i}/${samples}] generating... `);
      const taskArgs = [
        CLI,
        'task',
        'run',
        prompt,
        '--model-level',
        designer.modelLevel,
        '--output-format',
        'json',
        '--json-schema',
        schema,
        '--silent-json-output',
      ];
      if (provider) taskArgs.push('--provider', provider);
      const run = spawnSync('node', taskArgs, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
      });

      raw = `${run.stdout || ''}\n${run.stderr || ''}`;
      const spawned = raw.match(/Task spawned:\s+(\S+)/);
      if (!spawned) {
        console.log('❌ task did not spawn');
        fs.writeFileSync(path.join(outDir, `sample-${i}.raw.txt`), raw);
        verdicts.push({ i, ok: false, reason: 'task did not spawn' });
        continue;
      }
      taskId = spawned[1];
    }

    const waited = waitForTask(taskId, 900000);
    if (!waited.done) {
      console.log(`❌ ${taskId} did not finish in 15m`);
      verdicts.push({ i, ok: false, reason: 'timeout' });
      continue;
    }

    const design = readTaskResult(waited.logPath);
    if (!design || !Array.isArray(design.agents)) {
      console.log('❌ no parseable design');
      fs.writeFileSync(path.join(outDir, `sample-${i}.raw.txt`), `${raw}\n${waited.statusText}`);
      verdicts.push({ i, ok: false, reason: 'unparseable output' });
      continue;
    }

    design.__taskText = taskText;
    const designPath = path.join(outDir, `sample-${i}.json`);
    fs.writeFileSync(designPath, JSON.stringify(design, null, 2));

    const check = spawnSync(
      'node',
      [path.join(__dirname, 'check-generated-topology.js'), designPath],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const admitted = check.status === 0;
    const validators = design.agents.filter((a) => a.role === 'validator').length;
    const stages = new Set(
      design.agents.filter((a) => a.role === 'validator').map((a) => a.stage || 1)
    ).size;
    console.log(
      `${admitted ? '✅' : '❌'} ${validators} verifier(s), ${stages} stage(s) -> ${designPath}`
    );
    if (!admitted) {
      const errLine = (check.stdout || '').split('\n').filter((l) => l.trim().startsWith('-'));
      for (const l of errLine) console.log(`      ${l.trim()}`);
    }
    verdicts.push({
      i,
      ok: admitted,
      validators,
      stages,
      provider: provider || 'default',
      path: designPath,
    });
  }

  const passed = verdicts.filter((v) => v.ok).length;
  console.log(`\nCold-pass rate: ${passed}/${samples}`);
  fs.writeFileSync(path.join(outDir, 'verdicts.json'), JSON.stringify(verdicts, null, 2));
  process.exit(passed === samples ? 0 : 1);
}

main();
