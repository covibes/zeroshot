'use strict';

const { build, inspect } = require('./hosted-oecp-image-commands');
const { smoke } = require('./hosted-oecp-image-smoke');
const { check, write } = require('./hosted-oecp-manifest');

async function main() {
  const [mode = 'check', argument = 'zeroshot-oecp:private'] = process.argv.slice(2);
  if (mode === 'write') write();
  else if (mode === 'check') check();
  else if (mode === 'build') build(argument);
  else if (mode === 'inspect') inspect(argument);
  else if (mode === 'smoke') await smoke(argument);
  else throw new Error('Usage: hosted-oecp-image.js <write|check|build|inspect|smoke> [image-tag]');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
