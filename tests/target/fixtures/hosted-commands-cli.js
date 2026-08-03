#!/usr/bin/env node
// Test-only harness for the internal hosted parser constructor. The stable CLI never
// imports this boundary, so hosted handler tests cannot weaken the production gate.
const { Command } = require('commander');
const { loadSettings, mutateSettings } = require('../../../lib/settings');
const { registerHostedCommands } = require('../../../lib/target/register-hosted-commands');

const program = new Command().name('zeroshot-hosted-test');
registerHostedCommands(program, { loadSettings, mutateSettings });

program.parseAsync(process.argv).catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
