'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findProviderRegistryEntry } = require('../../lib/agent-cli-provider/provider-registry');
const { loadHostedWorkerConfiguration, removeCredentialBundle } = require('./hosted-config');

function providerBinaryAvailable(provider, environment = process.env) {
  const entry = findProviderRegistryEntry(provider);
  if (!entry || typeof environment.PATH !== 'string') return false;
  return environment.PATH.split(path.delimiter).some((directory) => {
    try {
      fs.accessSync(path.join(directory, entry.binary), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

try {
  const configuration = loadHostedWorkerConfiguration();
  if (!providerBinaryAvailable(configuration.provider)) throw new Error('provider unavailable');
  removeCredentialBundle();
} catch {
  process.exitCode = 1;
}

module.exports = { providerBinaryAvailable };
