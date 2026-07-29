const readline = require('readline');
const { loadSettings, mutateSettings } = require('../../lib/settings');
const {
  VALID_PROVIDERS,
  normalizeProviderName,
  providerSupportsCapability,
} = require('../../lib/provider-names');
const { detectProviders, getProvider } = require('../../src/providers');

const PROVIDER_CHOICES = VALID_PROVIDERS.join(', ');

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function providersCommand() {
  const detected = await detectProviders();
  const settings = loadSettings();

  console.log('\nProvider     Status       Default Level  Model             CLI Path');
  console.log('─'.repeat(70));

  for (const [name, status] of Object.entries(detected)) {
    const provider = getProvider(name);
    const statusIcon = status.available ? '✓ found' : '✗ not found';
    const providerSettings = settings.providerSettings?.[name] || {};
    const defaultLevel = providerSettings.defaultLevel || provider.getDefaultLevel();
    const levelOverrides = providerSettings.levelOverrides || {};
    const modelSpec = provider.resolveModelSpec(defaultLevel, levelOverrides);
    const modelLabel = modelSpec?.model || '-';
    const cliPath = status.available ? await provider.getCliPath() : '-';
    const isDefault = settings.defaultProvider === name ? ' (default)' : '';

    console.log(
      `${provider.displayName.padEnd(12)} ${statusIcon.padEnd(12)} ${defaultLevel.padEnd(
        14
      )} ${modelLabel.padEnd(16)} ${cliPath}${isDefault}`
    );
  }

  console.log('\nCommands:');
  console.log('  zeroshot providers set-default <provider>  Set default provider');
  console.log('  zeroshot providers setup <provider>        Configure a provider');
  console.log(
    '\nNote: Authentication is managed by each CLI; zeroshot does not validate login or API keys.'
  );
}

function setDefaultCommand(args) {
  const provider = normalizeProviderName(args[0]);
  if (!VALID_PROVIDERS.includes(provider)) {
    console.error(`Invalid provider: ${args[0]}. Valid: ${PROVIDER_CHOICES}`);
    process.exit(1);
  }

  mutateSettings((settings) => {
    settings.defaultProvider = provider;
  });

  console.log(`Default provider set to: ${provider}`);
}

async function setupCommand(args) {
  const provider = normalizeProviderName(args[0]);
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    console.error(`Provider is required (${PROVIDER_CHOICES})`);
    process.exit(1);
  }

  const providerModule = getProvider(provider);

  console.log(`\n${providerModule.displayName} Setup\n`);

  const available = await providerModule.isAvailable();
  if (!available) {
    console.log(`✗ ${providerModule.cliCommand} CLI not found`);
    console.log('\nInstall with:');
    console.log(providerModule.getInstallInstructions());
    return;
  }
  console.log(`✓ ${providerModule.cliCommand} CLI found`);

  console.log('\nAuth is user-managed; run the CLI login flow if needed:');
  console.log(providerModule.getAuthInstructions());

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const levels = providerModule.getLevelMapping();
    const levelKeys = Object.keys(levels).sort((a, b) => levels[a].rank - levels[b].rank);

    console.log('\nAvailable levels (cheapest to most capable):');
    levelKeys.forEach((level, i) => {
      const spec = levels[level];
      const reasoning = spec.reasoningEffort ? ` (reasoning: ${spec.reasoningEffort})` : '';
      console.log(`  ${i + 1}) ${level} -> ${spec.model}${reasoning}`);
    });

    const maxIdxRaw = await question(rl, `\nMax level (cost ceiling) [${levelKeys.length}]: `);
    const minIdxRaw = await question(rl, 'Min level (floor) [1]: ');
    const maxIdxNum = Math.min(
      levelKeys.length,
      Math.max(1, parseInt(maxIdxRaw) || levelKeys.length)
    );
    const minIdxNum = Math.min(levelKeys.length, Math.max(1, parseInt(minIdxRaw) || 1));
    const minIdx = Math.min(minIdxNum, maxIdxNum);
    const maxIdx = Math.max(minIdxNum, maxIdxNum);

    const defaultIdxRaw = await question(
      rl,
      `Default level (between ${minIdx}-${maxIdx}) [${maxIdx}]: `
    );
    const defaultIdxNum = Math.min(maxIdx, Math.max(minIdx, parseInt(defaultIdxRaw) || maxIdx));

    const levelOverrides = {};
    const wantsOverrides = await question(rl, 'Override models per level? [y/N]: ');
    if (wantsOverrides.toLowerCase() === 'y') {
      const catalog = Object.keys(providerModule.getModelCatalog());
      for (const level of levelKeys) {
        const modelChoice = await question(rl, `Model for ${level} (${catalog.join(', ')}): `);
        if (modelChoice) levelOverrides[level] = { model: modelChoice };
        if (!providerSupportsCapability(provider, 'reasoningEffort')) continue;
        const reasoning = await question(
          rl,
          `Reasoning for ${level} (low|medium|high|xhigh|max): `
        );
        if (reasoning) {
          levelOverrides[level] = {
            ...(levelOverrides[level] || {}),
            reasoningEffort: reasoning,
          };
        }
      }
    }

    mutateSettings((settings) => {
      settings.providerSettings = settings.providerSettings || {};
      settings.providerSettings[provider] = {
        maxLevel: levelKeys[maxIdx - 1],
        minLevel: levelKeys[minIdx - 1],
        defaultLevel: levelKeys[defaultIdxNum - 1],
        levelOverrides,
      };
    });

    console.log(`\n✓ ${providerModule.displayName} configured successfully`);
  } finally {
    rl.close();
  }
}

module.exports = {
  providersCommand,
  setDefaultCommand,
  setupCommand,
};
