#!/usr/bin/env node
/**
 * Dev harness for the topology generator.
 *
 * Takes a topology-designer output (the compact agent spec a model would emit),
 * runs the REAL transform from cluster-templates/topology-generator.json through
 * the REAL hook executor, and validates the resulting topology exactly the way
 * orchestrator._validateProposedConfig does before admission.
 *
 * Token-free. This is the loop to live in while tuning the designer prompt.
 *
 * Usage:
 *   node scripts/check-generated-topology.js <design.json> [--print]
 *   node scripts/check-generated-topology.js <design.json> --simulate
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { executeHook, executeTransform } = require('../src/agent/agent-hook-executor');
const configValidator = require('../src/config-validator');

const SEED_PATH = path.join(__dirname, '..', 'cluster-templates', 'topology-generator.json');

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/**
 * Mirrors orchestrator._prepareValidationAgentConfigs: the orchestrator adds a
 * synthetic completion handler when none is present. Our transform emits a real
 * one, so the merged set should already satisfy it - but we merge the same way
 * _buildProposedAgentConfigs does (existing seed agents + newly added ones).
 */
function mergeProposed(seedAgents, addedAgents) {
  const proposed = seedAgents.map((a) => JSON.parse(JSON.stringify(a)));
  for (const agent of addedAgents) {
    const idx = proposed.findIndex((a) => a.id === agent.id);
    const copy = JSON.parse(JSON.stringify(agent));
    if (idx === -1) proposed.push(copy);
    else proposed[idx] = copy;
  }
  return proposed;
}

function runDesignerTransform(seed, design) {
  const designer = seed.agents.find((a) => a.id === 'topology-designer');
  if (!designer) fail('seed has no topology-designer agent');

  const agent = {
    id: 'topology-designer',
    cluster: null,
    messageBus: null,
    currentTaskId: 'check-harness',
    iteration: 0,
    _log: () => {},
    _parseResultOutput: (output) => JSON.parse(output),
  };

  const context = {
    // parsedResult short-circuits provider output parsing (hasCachedParsedResult)
    result: { parsedResult: design, taskId: 'check-harness' },
    triggeringMessage: {
      id: 'msg_original_check_harness',
      timestamp: 1704067200000,
      topic: 'ISSUE_OPENED',
      content: {
        text: design.__taskText || 'harness task text',
        data: { attachmentRefs: ['attachment://proof-input'], structuredSentinel: 17 },
      },
      metadata: { source: 'check-harness' },
    },
    cluster: null,
  };

  return executeTransform({ transform: designer.hooks.onComplete.transform, context, agent });
}

async function runWorkerCompletionHook(worker, completed, userDeliverable) {
  let published = null;
  const cluster = { id: 'check-harness-cluster', agents: [] };
  const agent = {
    id: worker.id,
    role: worker.role,
    iteration: 1,
    currentTaskId: 'check-worker-hook',
    cluster,
    messageBus: null,
    _log: () => {},
    _parseResultOutput: (output) => JSON.parse(output),
    _publish: (message) => {
      published = message;
    },
  };
  await executeHook({
    hook: worker.hooks.onComplete,
    agent,
    message: { topic: 'ISSUE_OPENED', content: { text: 'task' } },
    result: { parsedResult: { completed, userDeliverable }, taskId: 'check-worker-hook' },
    cluster,
  });
  return published;
}

async function runValidatorCompletionHook(validator, parsedResult) {
  let published = null;
  const cluster = { id: 'check-harness-cluster', agents: [] };
  const agent = {
    id: validator.id,
    role: validator.role,
    iteration: 1,
    currentTaskId: 'check-validator-hook',
    cluster,
    messageBus: null,
    _log: () => {},
    _parseResultOutput: (output) => JSON.parse(output),
    _publish: (message) => {
      published = message;
    },
  };
  await executeHook({
    hook: validator.hooks.onComplete,
    agent,
    message: { topic: 'IMPLEMENTATION_READY', content: { text: 'ready' } },
    result: { parsedResult, taskId: 'check-validator-hook' },
    cluster,
  });
  return published;
}

function describe(agents) {
  const lines = [];
  for (const a of agents) {
    const triggers = (a.triggers || [])
      .map(
        (t) => `${t.topic}${t.logic ? '[gated]' : ''}${t.action === 'stop_cluster' ? '→STOP' : ''}`
      )
      .join(', ');
    const publishes =
      a.hooks?.onComplete?.config?.topic || (a.hooks?.onComplete?.transform ? '<transform>' : '-');
    lines.push(
      `  ${a.id.padEnd(28)} ${String(a.role).padEnd(15)} ${String(a.modelLevel || '-').padEnd(7)}` +
        ` in[${triggers}] out[${publishes}]`
    );
  }
  return lines.join('\n');
}

async function simulate(proposedAgents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topogen-sim-'));
  fs.writeFileSync(
    path.join(dir, 'generated-topology.json'),
    JSON.stringify({ name: 'Generated', description: 'harness', agents: proposedAgents }, null, 2)
  );

  const { validateTemplates } = require('../src/template-validation');
  const report = await validateTemplates({
    templatesDir: dir,
    deep: true,
    randomSampling: true,
    randomOptions: { samples: 20 },
  });

  fs.rmSync(dir, { recursive: true, force: true });
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const designPath = args.find((a) => !a.startsWith('--'));
  if (!designPath) fail('usage: check-generated-topology.js <design.json> [--print] [--simulate]');

  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const design = JSON.parse(fs.readFileSync(path.resolve(designPath), 'utf8'));

  // --- 1. seed itself must be admissible -----------------------------------
  const seedResult = configValidator.validateConfig(seed);
  if (!seedResult.valid) fail(`seed config invalid:\n  - ${seedResult.errors.join('\n  - ')}`);
  console.log('✅ seed config valid');

  // --- 2. transform must produce a well-formed operation chain -------------
  let message;
  try {
    message = await runDesignerTransform(seed, design);
  } catch (error) {
    fail(`transform threw: ${error.message}`);
  }

  const operations = message?.content?.data?.operations;
  if (!Array.isArray(operations)) fail('transform did not return an operations array');

  const addOp = operations.find((op) => op.action === 'add_agents');
  if (!addOp) fail('transform emitted no add_agents operation');
  const republish = operations.find((op) => op.action === 'publish');
  if (!republish) fail('transform emitted no republish - spawned agents would never wake');
  if (republish.metadata?._republished !== true) {
    fail('republish is missing metadata._republished: true - infinite loop risk');
  }
  if (
    republish.content?.data?.structuredSentinel !== 17 ||
    republish.content?.data?.attachmentRefs?.[0] !== 'attachment://proof-input'
  ) {
    fail('republish discarded structured task data - generated agents would lose non-text inputs');
  }
  if (republish.metadata?.source !== 'check-harness') {
    fail('republish discarded task-source metadata');
  }
  if (
    republish.metadata?._originalTimestamp !== 1704067200000 ||
    republish.metadata?._originalMessageId !== 'msg_original_check_harness'
  ) {
    fail('republish discarded original request time/id provenance');
  }
  console.log(
    `✅ transform emitted ${operations.length} operations, ${addOp.agents.length} agents`
  );

  const worker = addOp.agents.find((agent) => agent.role === 'implementation');
  if (!worker) fail('transform emitted no implementation agent');
  const readyMessage = await runWorkerCompletionHook(
    worker,
    true,
    'The complete user-facing harness result.'
  );
  const incompleteMessage = await runWorkerCompletionHook(
    worker,
    false,
    'Could not reach the required harness capability.'
  );
  if (readyMessage?.topic !== 'IMPLEMENTATION_READY') {
    fail('completed:true does not route to independent verification');
  }
  if (readyMessage?.content?.data?.userDeliverable !== 'The complete user-facing harness result.') {
    fail('completed task discarded the actual user-facing deliverable');
  }
  if (
    incompleteMessage?.topic !== 'CLUSTER_FAILED' ||
    incompleteMessage?.content?.data?.reason !== 'implementation_incomplete' ||
    incompleteMessage?.content?.data?.userDeliverable !==
      'Could not reach the required harness capability.' ||
    incompleteMessage?.content?.text !== 'Could not reach the required harness capability.'
  ) {
    fail('completed:false can still flow into verification/success or loses its blocker result');
  }
  console.log(
    '✅ worker outcome routing preserves the user deliverable and distinguishes honest inability'
  );

  const validator = addOp.agents.find((agent) => agent.role === 'validator');
  if (!validator) fail('transform emitted no validator agent');
  const evidence = [{ check: 'harness', method: 'fixture', output: 'ok', passed: true }];
  const approvedVerdict = await runValidatorCompletionHook(validator, {
    approved: false,
    disposition: 'approved',
    summary: 'approved',
    errors: [],
    evidence,
  });
  const defectVerdict = await runValidatorCompletionHook(validator, {
    approved: true,
    disposition: 'retryable_defect',
    summary: 'fixable defect',
    errors: ['fix this'],
    evidence,
  });
  const gapVerdict = await runValidatorCompletionHook(validator, {
    approved: true,
    disposition: 'evidence_gap',
    summary: 'oracle unavailable',
    errors: ['cannot observe'],
    evidence,
  });
  if (approvedVerdict?.content?.data?.approved !== true) {
    fail('disposition:approved does not normalize to approved:true');
  }
  if (
    defectVerdict?.topic === 'CLUSTER_FAILED' ||
    defectVerdict?.content?.data?.approved !== false
  ) {
    fail('retryable_defect does not route to worker-repair validation feedback');
  }
  if (
    gapVerdict?.topic !== 'CLUSTER_FAILED' ||
    gapVerdict?.content?.data?.reason !== 'evidence_gap' ||
    gapVerdict?.content?.data?.approved !== false
  ) {
    fail('evidence_gap does not route to explicit terminal non-success');
  }
  console.log(
    '✅ validator outcome routing separates approval, retryable defect, and evidence gap'
  );

  // --- 3. merged topology must pass admission ------------------------------
  const proposed = mergeProposed(seed.agents, addOp.agents);
  const merged = configValidator.validateConfig({ agents: proposed });

  console.log(`\nTopology (${message.content.text}):`);
  console.log(describe(addOp.agents));

  if (args.includes('--print')) {
    console.log('\n--- generated agents ---');
    console.log(JSON.stringify(addOp.agents, null, 2));
  }

  console.log('');
  if (merged.warnings.length) {
    console.log(`⚠️  ${merged.warnings.length} warning(s):`);
    for (const w of merged.warnings) console.log(`   ${w}`);
  }
  if (!merged.valid) {
    fail(`ADMISSION WOULD FAIL:\n  - ${merged.errors.join('\n  - ')}`);
  }
  console.log('✅ merged topology passes admission (_validateProposedConfig equivalent)');

  // --- 4. optional: fuzz the generated topology ----------------------------
  if (args.includes('--simulate')) {
    console.log('\nSimulating (deep + 20 random samples)...');
    const report = await simulate(proposed);
    const errors = report.results.flatMap((r) => r.result.errors || []);
    if (errors.length) fail(`SIMULATION FAILED:\n  - ${errors.join('\n  - ')}`);
    console.log(`✅ simulation clean (${report.validated} config(s) validated)`);
  }

  console.log('');
}

main().catch((error) => fail(error.stack || error.message));
