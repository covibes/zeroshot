'use strict';

const { build, inspect } = require('./hosted-oecp-image-commands');
const { smoke } = require('./hosted-oecp-image-smoke');

async function main() {
  const [mode, argument = 'zeroshot-oecp:private'] = process.argv.slice(2);
  if (mode === 'build') build(argument);
  else if (mode === 'inspect') inspect(argument);
  else if (mode === 'smoke') await smoke(argument);
  else throw new Error('Usage: hosted-oecp-image.js <build|inspect|smoke> [image-tag]');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
