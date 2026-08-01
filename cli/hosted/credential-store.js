'use strict';

const { execFileSync } = require('node:child_process');

const APPLICATION = 'zeroshot';

function automationRefreshToken(environment = process.env) {
  const value = environment.ZEROSHOT_TARGET_REFRESH_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function secretTool(args, options = {}) {
  return execFileSync('secret-tool', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    ...options,
  });
}

function loadRefreshToken(targetName, environment = process.env) {
  const automation = automationRefreshToken(environment);
  if (automation) return { token: automation, persistent: false };
  try {
    const token = secretTool(['lookup', 'application', APPLICATION, 'target', targetName]).trim();
    if (token) return { token, persistent: true };
  } catch {
    // Missing entry and unavailable Secret Service are handled by one actionable error.
  }
  throw new Error(
    `target ${targetName} is not logged in; run "zeroshot target login ${targetName}" ` +
      'or set ZEROSHOT_TARGET_REFRESH_TOKEN for one non-interactive run'
  );
}

function storeRefreshToken(targetName, token) {
  if (!token || typeof token !== 'string') throw new Error('refusing to store an empty token');
  try {
    secretTool(
      [
        'store',
        `--label=Zeroshot target ${targetName}`,
        'application',
        APPLICATION,
        'target',
        targetName,
      ],
      { input: token }
    );
  } catch {
    throw new Error(
      'a Secret Service credential store is required for persistent target login; ' +
        'install secret-tool/libsecret or use ZEROSHOT_TARGET_REFRESH_TOKEN for automation'
    );
  }
}

function removeRefreshToken(targetName) {
  try {
    secretTool(['clear', 'application', APPLICATION, 'target', targetName]);
  } catch {
    // Removing a target is idempotent with respect to an absent keyring entry.
  }
}

module.exports = {
  loadRefreshToken,
  removeRefreshToken,
  storeRefreshToken,
};
