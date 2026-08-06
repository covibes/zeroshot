#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const LIFECYCLE_SCRIPTS = ['fix-node-pty-permissions.js', 'check-path.js'];
const SETUP_INVITATION = 'Run zeroshot to finish setup.\n';

function isTruthyEnvironmentFlag(value) {
  if (typeof value !== 'string') return false;
  return !['', '0', 'false'].includes(value.trim().toLowerCase());
}

function shouldPrintSetupInvitation(env) {
  const globalInstall = env.npm_config_global === 'true' || env.npm_config_location === 'global';
  return globalInstall && !isTruthyEnvironmentFlag(env.CI);
}

function runLifecycleScript(scriptName) {
  const result = spawnSync(process.execPath, [path.join(__dirname, scriptName)], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runPostinstall({
  env = process.env,
  stdout = process.stdout,
  runScript = runLifecycleScript,
} = {}) {
  for (const scriptName of LIFECYCLE_SCRIPTS) {
    const status = runScript(scriptName);
    if (status !== 0) return status;
  }
  if (shouldPrintSetupInvitation(env)) stdout.write(SETUP_INVITATION);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runPostinstall();
  } catch (error) {
    console.warn(`[postinstall] Warning: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  LIFECYCLE_SCRIPTS,
  SETUP_INVITATION,
  runPostinstall,
  shouldPrintSetupInvitation,
};
