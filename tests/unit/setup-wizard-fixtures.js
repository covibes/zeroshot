const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function planFixture(overrides = {}) {
  const plan = {
    facts: {
      node: { version: 'v24.0.0', packageVersion: '1.2.3' },
      git: {
        isRepo: true,
        branch: 'main',
        remote: 'https://github.com/acme/repo.git',
        ghAvailable: true,
        ghAuthed: true,
      },
      docker: { available: true },
      providers: {
        codex: {
          available: true,
          displayName: 'Codex',
          path: '/usr/bin/codex',
          installInstructions: 'npm install -g @openai/codex',
        },
      },
    },
    decisions: [],
    recommended: {
      defaultProvider: 'codex',
      'providerLevel.codex': {
        minLevel: 'level1',
        defaultLevel: 'level2',
        maxLevel: 'level3',
      },
      defaultIsolation: 'worktree',
      defaultIssueSource: 'github',
      defaultDelivery: 'none',
      updatePolicy: 'notify',
      dockerMounts: ['gh', 'git', 'ssh'],
      dockerEnvPassthrough: [],
    },
  };
  return {
    ...plan,
    ...overrides,
    facts: { ...plan.facts, ...overrides.facts },
    recommended: { ...plan.recommended, ...overrides.recommended },
  };
}

function terminalHarness({ columns = 80, colorDepth = 8 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  const rawModes = [];
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
    rawModes.push(value);
  };
  const chunks = [];
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.getColorDepth = () => colorDepth;
  stdout.write = (value) => {
    chunks.push(String(value));
    return true;
  };
  return { stdin, stdout, rawModes, output: () => chunks.join('') };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyToSettings(settings, decisions) {
  for (const [decisionId, value] of Object.entries(decisions)) {
    if (decisionId.startsWith('providerLevel.')) {
      const provider = decisionId.slice('providerLevel.'.length);
      settings.providerSettings ||= {};
      settings.providerSettings[provider] = {
        ...(settings.providerSettings[provider] || {}),
        ...value,
      };
    } else {
      settings[decisionId] = value;
    }
  }
}

function wizardDeps(plan, calls, options = {}) {
  const stored = { providerSettings: {} };
  return {
    buildSetupPlan: () => plan,
    getSettingsFile: () => '/home/test/.zeroshot/settings.json',
    loadSettings: () => clone(stored),
    settingsFileExists: () => false,
    readRepoSettings: () => ({ settings: null }),
    applyDecisionValues: (request) => {
      calls.applies.push(request);
      if (options.applyError) throw options.applyError;
      applyToSettings(stored, request.decisions);
      return Object.entries(request.decisions).map(([decisionId, to]) => ({
        decisionId,
        from: null,
        to,
        applied: true,
      }));
    },
    runPreflight: (request) => {
      calls.preflights.push(request);
      return options.preflight || { valid: true, errors: [], warnings: [] };
    },
    mutateSettings: (mutator) => {
      mutator(stored);
      calls.mutations.push(clone(stored));
    },
    motion: false,
  };
}

function emptyCalls() {
  return { applies: [], mutations: [], preflights: [] };
}

module.exports = { emptyCalls, planFixture, terminalHarness, wizardDeps };
