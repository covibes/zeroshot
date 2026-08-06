import chalk from 'chalk';
import { shouldUseAttachableWatcher, spawnTask } from '../runner.js';

// Every field the agent's `providerSession.ompSession` snapshot carries, plus the outer tuple's
// session ID and the prior owner's task id. All are required: the descriptor is only ever built
// from a complete committed record, and task-lib/runner.js re-checks every one of them against
// that record before a task row exists. Missing/extra/mistyped fields fail closed here.
const OMP_RESUME_STRING_FIELDS = [
  'priorOwnerTaskId',
  'partitionId',
  'sessionFileName',
  'expectedSessionId',
  'expectedArtifactManifestDigest',
  'expectedExecutionFingerprint',
  'expectedSelectedProvider',
  'expectedSelectedModel',
];
const OMP_RESUME_IDENTITY_FIELDS = ['expectedSessionFileIdentity'];
const OMP_RESUME_OPTIONAL_IDENTITY_FIELDS = ['expectedPartitionIdentity'];
const OMP_RESUME_ALLOWED_FIELDS = new Set([
  ...OMP_RESUME_STRING_FIELDS,
  ...OMP_RESUME_IDENTITY_FIELDS,
  ...OMP_RESUME_OPTIONAL_IDENTITY_FIELDS,
]);

// Issue #866 fixes device/inode as *canonical unsigned decimal strings*. This descriptor arrives
// over argv from another process, so the type is checked, never coerced: `String(value.device)`
// would have accepted the JSON number 42, `new String('42')`, `['42']`, and anything else with a
// matching toString, then silently canonicalized it into a string the persisted record never
// contained. A descriptor that does not already carry the canonical form is a descriptor built by
// something other than this codebase's writer, and it fails closed rather than being repaired.
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const IDENTITY_KEYS = new Set(['device', 'inode']);

function isCanonicalDecimalString(value) {
  return typeof value === 'string' && CANONICAL_DECIMAL.test(value);
}

function isIdentityShape(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === IDENTITY_KEYS.size &&
    Object.keys(value).every((key) => IDENTITY_KEYS.has(key)) &&
    isCanonicalDecimalString(value.device) &&
    isCanonicalDecimalString(value.inode)
  );
}

export function parseOmpResumeDescriptor(raw) {
  if (!raw) return undefined;
  let descriptor;
  try {
    descriptor = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--omp-resume must be a JSON descriptor: ${error.message}`);
  }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('--omp-resume descriptor must be a JSON object.');
  }
  const unknown = Object.keys(descriptor).filter((key) => !OMP_RESUME_ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`--omp-resume descriptor has unknown field(s): ${unknown.join(', ')}.`);
  }
  const missing = [
    ...OMP_RESUME_STRING_FIELDS.filter(
      (field) => typeof descriptor[field] !== 'string' || descriptor[field].length === 0
    ),
    ...OMP_RESUME_IDENTITY_FIELDS.filter((field) => !isIdentityShape(descriptor[field])),
  ];
  if (missing.length > 0) {
    throw new Error(`--omp-resume descriptor is missing/invalid field(s): ${missing.join(', ')}.`);
  }
  for (const field of OMP_RESUME_OPTIONAL_IDENTITY_FIELDS) {
    if (descriptor[field] !== undefined && !isIdentityShape(descriptor[field])) {
      throw new Error(`--omp-resume descriptor field ${field} is not a device/inode identity.`);
    }
  }
  return descriptor;
}

export async function runTask(prompt, options = {}) {
  if (!prompt || prompt.trim().length === 0) {
    console.log(chalk.red('Error: Prompt is required'));
    process.exit(1);
  }

  const outputFormat = options.outputFormat || 'stream-json';
  const jsonSchema = options.jsonSchema;
  const silentJsonOutput = options.silentJsonOutput || false;

  console.log(chalk.dim('Spawning task...'));
  if (options.provider) {
    console.log(chalk.dim(`  Provider: ${options.provider}`));
  }
  if (options.model) {
    console.log(chalk.dim(`  Model: ${options.model}`));
  }
  if (options.modelLevel) {
    console.log(chalk.dim(`  Level: ${options.modelLevel}`));
  }
  if (jsonSchema && outputFormat === 'json') {
    console.log(chalk.dim(`  JSON Schema: enforced`));
    if (silentJsonOutput) {
      console.log(chalk.dim(`  Silent mode: log contains ONLY final JSON`));
    }
  }

  const task = await spawnTask(prompt, {
    cwd: options.cwd || process.cwd(),
    model: options.model,
    modelLevel: options.modelLevel,
    reasoningEffort: options.reasoningEffort,
    provider: options.provider,
    resume: options.resume,
    continue: options.continue,
    ompResume: parseOmpResumeDescriptor(options.ompResume),
    outputFormat,
    jsonSchema,
    mcpConfig: options.mcpConfig,
    silentJsonOutput,
    structuredOutputRecovery: options.structuredOutputRecovery === true,
  });

  console.log(chalk.green(`\n✓ Task spawned: ${chalk.cyan(task.id)}`));
  console.log(chalk.dim(`  Log: ${task.logFile}`));
  console.log(chalk.dim(`  CWD: ${task.cwd}`));

  const attachSupported = shouldUseAttachableWatcher(
    {
      jsonSchema: outputFormat === 'json' ? jsonSchema : null,
    },
    task.provider
  );

  console.log(chalk.dim('\nCommands:'));
  if (attachSupported) {
    console.log(chalk.dim(`  zeroshot attach ${task.id}    # Attach to task (Ctrl+B d to detach)`));
  } else {
    console.log(
      chalk.dim(
        `  Attach unavailable: ${task.provider} strict structured output uses a non-PTY watcher`
      )
    );
  }
  console.log(chalk.dim(`  zeroshot logs ${task.id}      # View output`));
  console.log(chalk.dim(`  zeroshot logs -f ${task.id}   # Follow output`));
  console.log(chalk.dim(`  zeroshot status ${task.id}    # Check status`));
  console.log(chalk.dim(`  zeroshot kill ${task.id}      # Stop task`));
  console.log();

  return task;
}
