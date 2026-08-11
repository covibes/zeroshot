type RunIsolation = 'none' | 'worktree' | 'docker';
type RunDelivery = 'none' | 'pr' | 'ship';

interface RunPlan {
  isolation: RunIsolation;
  delivery: RunDelivery;
  autoMerge: boolean;
}

interface Settings extends Record<string, unknown> {
  defaultIsolation?: string;
  defaultDelivery?: string;
}

interface RunOptions extends Record<string, unknown> {
  autoMerge?: unknown;
  autoPush?: unknown;
  closeIssue?: unknown;
  containerHome?: unknown;
  cwd?: unknown;
  docker?: unknown;
  dockerImage?: unknown;
  isolation?: unknown;
  mergeQueue?: unknown;
  mount?: readonly string[] | null;
  mounts?: unknown;
  noIsolation?: unknown;
  noMounts?: unknown;
  pr?: unknown;
  prBase?: unknown;
  preparedWorktree?: unknown;
  requiredQualityGates?: unknown;
  ship?: unknown;
  worktree?: unknown;
}

interface RunPlanFacade {
  resolveRunPlan(options?: RunOptions): Readonly<RunPlan>;
}

interface RunModeFacade {
  runModeFromPlan(plan: RunPlan): string | null;
}

interface EnvironmentFacade {
  firstTruthy<T>(...values: T[]): T | undefined;
  anyTruthy(...values: unknown[]): boolean;
  optionalValue<T>(value: T): T | undefined;
  detectGitRepoRoot(): string;
  resolveTargetCwd(): string | undefined;
  resolveEnvBool(value: unknown): boolean | undefined;
  mergeRunOptions(options: RunOptions): RunOptions;
  resolveMergeQueue(options: RunOptions): boolean | undefined;
  resolvePrBase(options: RunOptions): string | undefined;
  resolveCloseIssue(options: RunOptions): 'auto' | 'always' | 'never' | undefined;
  resolveMounts(options: RunOptions):
    | Array<{ host: string; container: string; readonly: boolean }>
    | undefined;
}

interface BuildStartOptionsArgs {
  clusterId?: unknown;
  options?: RunOptions;
  settings?: Settings;
  providerOverride?: unknown;
  modelOverride?: unknown;
  forceProvider?: unknown;
}

interface BuildTrustedStartOptionsArgs extends BuildStartOptionsArgs {
  plan?: RunPlan | null;
}

interface BuildStartOptionsFromPlanArgs extends BuildStartOptionsArgs {
  plan: RunPlan;
  options: RunOptions;
  settings: Settings;
  preparedWorktree?: unknown;
  environment: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const runPlan: RunPlanFacade = require('./run-plan');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const runMode: RunModeFacade = require('./run-mode');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const environmentHelpers: EnvironmentFacade = require('./start-cluster-environment');

const { resolveRunPlan } = runPlan;
const { runModeFromPlan } = runMode;
const {
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
} = environmentHelpers;

function isRunIsolation(value: string): value is RunIsolation {
  return value === 'none' || value === 'worktree' || value === 'docker';
}

function isRunDelivery(value: string): value is RunDelivery {
  return value === 'none' || value === 'pr' || value === 'ship';
}

function validateSavedRunModes(settings: Settings): {
  isolation: RunIsolation;
  delivery: RunDelivery;
} {
  const isolation = settings.defaultIsolation || 'none';
  const delivery = settings.defaultDelivery || 'none';
  if (!isRunIsolation(isolation)) {
    throw new Error(`Invalid saved isolation mode: ${isolation}`);
  }
  if (!isRunDelivery(delivery)) {
    throw new Error(`Invalid saved delivery mode: ${delivery}`);
  }
  return { isolation, delivery };
}

function resolveEffectiveIsolation(options: RunOptions, savedIsolation: RunIsolation): RunIsolation {
  if (options.noIsolation === true || options.isolation === false) return 'none';
  if (options.docker === true) return 'docker';
  if (options.worktree === true || options.pr === true || options.ship === true) return 'worktree';
  if (resolveEnvBool(process.env.ZEROSHOT_DOCKER) === true) return 'docker';
  if (resolveEnvBool(process.env.ZEROSHOT_WORKTREE) === true) return 'worktree';
  return savedIsolation;
}

function resolveEffectiveDelivery(options: RunOptions, savedDelivery: RunDelivery): RunDelivery {
  if (options.ship === true || options.autoMerge === true) return 'ship';
  if (options.pr === true || resolveEnvBool(process.env.ZEROSHOT_PR) === true) return 'pr';
  return savedDelivery;
}

function resolveEffectiveRunPlan(
  options: RunOptions = {},
  settings: Settings = {}
): Readonly<RunPlan> {
  const mergedOptions = mergeRunOptions(options);
  const noIsolation = mergedOptions.noIsolation === true || mergedOptions.isolation === false;
  const conflicts = ['docker', 'worktree', 'pr', 'ship'].filter(
    (key) => mergedOptions[key] === true
  );
  if (noIsolation && conflicts.length > 0) {
    throw new Error(`--no-isolation conflicts with --${conflicts.join(', --')}`);
  }

  const saved = validateSavedRunModes(settings);
  let isolation = resolveEffectiveIsolation(mergedOptions, saved.isolation);
  const delivery = resolveEffectiveDelivery(mergedOptions, saved.delivery);
  if (delivery !== 'none' && isolation === 'none') {
    if (noIsolation) {
      throw new Error(`--no-isolation conflicts with saved delivery mode "${delivery}"`);
    }
    isolation = 'worktree';
  }
  return resolveRunPlan({
    docker: isolation === 'docker',
    worktree: isolation === 'worktree',
    pr: delivery === 'pr',
    ship: delivery === 'ship',
  });
}

function buildStartOptionsFromPlan({
  clusterId,
  plan,
  options,
  settings,
  providerOverride,
  modelOverride,
  forceProvider,
  preparedWorktree,
  environment,
}: BuildStartOptionsFromPlanArgs): Readonly<Record<string, unknown>> {
  const targetCwd = environment ? resolveTargetCwd() : options.cwd;
  return Object.freeze({
    clusterId,
    cwd: targetCwd,
    isolation: plan.isolation === 'docker',
    isolationImage: environment
      ? firstTruthy(options.dockerImage, process.env.ZEROSHOT_DOCKER_IMAGE)
      : optionalValue(options.dockerImage),
    worktree: plan.isolation === 'worktree',
    preparedWorktree: preparedWorktree || undefined,
    autoPr: plan.delivery !== 'none',
    autoMerge: plan.autoMerge,
    autoPush: environment ? process.env.ZEROSHOT_PUSH === '1' : options.autoPush === true,
    modelOverride: optionalValue(modelOverride),
    providerOverride: optionalValue(providerOverride),
    noMounts: anyTruthy(options.mounts === false, options.noMounts === true),
    mounts: resolveMounts(options),
    containerHome: optionalValue(options.containerHome),
    forceProvider: optionalValue(forceProvider),
    prBase: environment ? resolvePrBase(options) : optionalValue(options.prBase),
    mergeQueue: environment ? resolveMergeQueue(options) : optionalValue(options.mergeQueue),
    closeIssue: environment ? resolveCloseIssue(options) : optionalValue(options.closeIssue),
    ship: plan.delivery === 'ship',
    runMode: runModeFromPlan(plan),
    requiredQualityGates: options.requiredQualityGates,
    settings,
  });
}

function buildStartOptions({
  clusterId,
  options = {},
  settings = {},
  providerOverride,
  modelOverride,
  forceProvider,
}: BuildStartOptionsArgs): Readonly<Record<string, unknown>> {
  const mergedOptions = mergeRunOptions(options);
  const plan = resolveEffectiveRunPlan(options, settings);
  return buildStartOptionsFromPlan({
    clusterId,
    plan,
    options: mergedOptions,
    settings,
    providerOverride,
    modelOverride,
    forceProvider,
    environment: true,
  });
}

function buildTrustedStartOptions({
  clusterId,
  plan,
  options = {},
  settings = {},
  providerOverride,
  modelOverride,
  forceProvider,
}: BuildTrustedStartOptionsArgs): Readonly<Record<string, unknown>> {
  if (!plan || !Object.isFrozen(plan)) {
    throw new Error('Trusted start requires a frozen canonical run plan');
  }
  const canonical = resolveRunPlan({
    docker: plan.isolation === 'docker',
    worktree: plan.isolation === 'worktree',
    pr: plan.delivery === 'pr',
    ship: plan.delivery === 'ship',
  });
  if (
    canonical.isolation !== plan.isolation ||
    canonical.delivery !== plan.delivery ||
    canonical.autoMerge !== plan.autoMerge
  ) {
    throw new Error('Trusted start plan is not canonical');
  }
  if (canonical.isolation === 'none') {
    throw new Error('Trusted worker start requires worktree or docker isolation');
  }
  if (options.preparedWorktree && canonical.isolation !== 'worktree') {
    throw new Error('Prepared worktree requires canonical worktree isolation');
  }
  return buildStartOptionsFromPlan({
    clusterId,
    plan: canonical,
    options,
    settings,
    providerOverride,
    modelOverride,
    forceProvider,
    preparedWorktree: options.preparedWorktree,
    environment: false,
  });
}

export = { buildStartOptions, buildTrustedStartOptions, resolveEffectiveRunPlan, detectGitRepoRoot };
