/**
 * First-run preferences.
 *
 * Provider and model configuration is deliberately excluded: operators edit
 * the canonical settings file and local auth source manually.
 */

const readline = require('readline');
const { loadSettings, mutateSettings } = require('../../lib/settings');

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
║   Provider setup remains manual and non-interactive.          ║
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
  • Auto-updates: ${settings.autoCheckUpdates ? 'enabled' : 'disabled'}

Provider/model configuration is manual-only. Edit
${process.env.ZEROSHOT_SETTINGS_FILE || '$HOME/.zeroshot/settings.json'} directly.

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

  printWelcome();
  const rl = createReadline();

  try {
    const autoUpdate = await promptAutoUpdate(rl);

    const savedSettings = mutateSettings((current) => {
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
};
