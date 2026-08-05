'use strict';

const fs = require('node:fs');

const CAPABILITY_ENV = 'ZEROSHOT_OECP_RUNTIME_CAPABILITY';
const CAPABILITY_FILE_ENV = 'ZEROSHOT_OECP_CAPABILITY_FILE';

function installRuntimeCapability(environment = process.env) {
  const capability = environment[CAPABILITY_ENV];
  const capabilityFile = environment[CAPABILITY_FILE_ENV];
  if (
    typeof capability !== 'string' ||
    !/^[0-9a-f]{64}$/.test(capability) ||
    typeof capabilityFile !== 'string' ||
    !capabilityFile.startsWith('/')
  ) {
    throw new Error('Hosted runtime capability configuration is invalid');
  }
  fs.writeFileSync(capabilityFile, capability, {
    encoding: 'ascii',
    flag: 'wx',
    mode: 0o400,
  });
  delete environment[CAPABILITY_ENV];
}

module.exports = { installRuntimeCapability };
