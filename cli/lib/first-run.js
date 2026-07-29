/**
 * First-Run Setup Wizard
 *
 * Interactive setup on first use:
 * - Welcome banner
 * - Max model ceiling selection (sonnet/opus/haiku)
 * - Auto-update preference
 * - Marks setup as complete
 */

const readline = require('readline');
const { loadSettings, mutateSettings } = require('../../lib/settings');
const { listProviderMetadata } = require('../../lib/provider-names');
const { detectProviders } = require('../../src/providers');

/**
 * Print welcome banner
 */
function printWelcome() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   Welcome to Zeroshot!                                        ║
║   Multi-agent orchestration engine                            ║
║                                                               ║
║   Let's configure a few settings to get started.              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);
}

/**
 * Create readline interface
 * @returns {readline.Interface}
 */
function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function printProviderInstallChoices() {
  for (const provider of listProviderMetadata()) {
    const [firstLine, ...remainingLines] = provider.installInstructions.split('\n');
    console.log(`  - ${provider.displayName}: ${firstLine}`);
    for (const line of remainingLines) {
      console.log(`    ${line}`);
    }
  }
}

/**
 * Prompt for provider selection
 * @param {readline.Interface} rl
 * @param {object} detected
 * @returns {Promise<string>}
 */
function promptProvider(rl, detected) {
  console.log('\nWhich AI provider would you like to use by default?\n');

  const available = Object.entries(detected).filter(([_, status]) => status.available);

  if (available.length === 0) {
    console.log('No AI CLI tools detected. Please install one of:');
    printProviderInstallChoices();
    process.exit(1);
  }

  available.forEach(([name], i) => {
    console.log(`  ${i + 1}) ${name} (installed)`);
  });

  return new Promise((resolve) => {
    rl.question('\nChoice [1]: ', (answer) => {
      const idx = parseInt(answer) - 1 || 0;
      resolve(available[idx]?.[0] || available[0][0]);
    });
  });
}

/**
 * Prompt for model selection
 * @param {readline.Interface} rl
 * @returns {Promise<string>}
 */
function promptModel(rl) {
  return new Promise((resolve) => {
    console.log('What is the maximum Claude model agents can use? (cost ceiling)\n');
    console.log('  1) sonnet  - Agents can use sonnet or haiku (recommended)');
    console.log('  2) opus    - Agents can use opus, sonnet, or haiku');
    console.log('  3) haiku   - Agents can only use haiku (lowest cost)\n');

    rl.question('Enter 1, 2, or 3 [2]: ', (answer) => {
      const choice = answer.trim() || '2';
      switch (choice) {
        case '2':
          resolve('opus');
          break;
        case '3':
          resolve('haiku');
          break;
        default:
          resolve('sonnet');
      }
    });
  });
}

/**
 * Prompt for auto-update preference
 * @param {readline.Interface} rl
 * @returns {Promise<boolean>}
 */
function promptAutoUpdate(rl) {
  return new Promise((resolve) => {
    console.log('\nWould you like zeroshot to check for updates automatically?');
    console.log('(Checks npm registry every 24 hours)\n');

    rl.question('Enable auto-update checks? [Y/n]: ', (answer) => {
      const normalized = answer.trim().toLowerCase();
      // Default to yes if empty or starts with 'y'
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Print completion message
 * @param {object} settings - Saved settings
 */
function printComplete(settings) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  Setup complete!                                              ║
╚═══════════════════════════════════════════════════════════════╝

Your settings:
  • Provider:     ${settings.defaultProvider}
  • Max model:    ${settings.maxModel} (Claude ceiling)
  • Auto-updates: ${settings.autoCheckUpdates ? 'enabled' : 'disabled'}

Change anytime with: zeroshot settings set <key> <value>

Get started:
  zeroshot run "Fix the bug in auth.js"
  zeroshot run 123  (GitHub issue number)
  zeroshot --help

`);
}

/**
 * Check if first-run setup is needed
 * @param {object} settings - Current settings
 * @returns {boolean}
 */
function detectFirstRun(settings) {
  return !settings.firstRunComplete;
}

/**
 * Main entry point - run first-time setup if needed
 * @param {object} options
 * @param {boolean} options.quiet - Skip interactive prompts
 * @returns {Promise<boolean>} True if setup was run
 */
async function checkFirstRun(options = {}) {
  const settings = loadSettings();

  // Already completed setup
  if (!detectFirstRun(settings)) {
    return false;
  }

  // Quiet mode - use defaults, mark complete
  if (options.quiet) {
    mutateSettings((current) => {
      current.firstRunComplete = true;
    });
    return true;
  }

  // Interactive setup
  printWelcome();

  const rl = createReadline();

  try {
    const detected = await detectProviders();
    const provider = await promptProvider(rl, detected);
    // Model ceiling selection
    const model = await promptModel(rl);

    // Auto-update preference
    const autoUpdate = await promptAutoUpdate(rl);

    const savedSettings = mutateSettings((current) => {
      current.defaultProvider = provider;
      current.maxModel = model;
      current.autoCheckUpdates = autoUpdate;
      current.firstRunComplete = true;
      return current;
    });

    // Print completion
    printComplete(savedSettings);

    return true;
  } finally {
    rl.close();
  }
}

module.exports = {
  checkFirstRun,
  // Exported for testing
  detectFirstRun,
  printWelcome,
  printComplete,
  promptProvider,
  printProviderInstallChoices,
};
