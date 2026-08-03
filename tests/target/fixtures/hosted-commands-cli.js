#!/usr/bin/env node
// Test-only harness for the internal hosted parser constructor. The stable CLI never
// imports this boundary, so hosted handler tests cannot weaken the production gate.
const { Command } = require('commander');
const { URL } = require('node:url');
const { loadSettings, mutateSettings } = require('../../../lib/settings');
const registry = require('../../../lib/target/target-registry');
const credentials = require('../../../lib/target/credential-store');
const { registerHostedCommands } = require('../../../lib/target/register-hosted-commands');

const program = new Command().name('zeroshot-hosted-test');
const services = {
  ...registry,
  targetLogin: () => Promise.reject(new Error('login is not exercised by this parser fixture')),
  revokeAndCleanup: () => Promise.resolve(),
  KeyringCredentialStore: {
    create: () =>
      Promise.resolve({
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      }),
  },
  targetServiceKey: credentials.targetServiceKey,
  TARGET_ACCOUNT: credentials.TARGET_ACCOUNT,
  acquireTargetLock: () => Promise.resolve(() => Promise.resolve()),
  discoverTarget: (url) =>
    Promise.resolve({
      origin: new URL(url).origin,
      adapter: { majorVersion: 1 },
    }),
  discoverTargetSessionEndpoints: () => Promise.reject(new Error('offline parser fixture')),
};
registerHostedCommands(program, { loadSettings, mutateSettings, services });

program.parseAsync(process.argv).catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
