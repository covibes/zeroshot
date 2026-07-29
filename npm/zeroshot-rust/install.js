#!/usr/bin/env node
'use strict';

const { install } = require('./lib/install');

install().catch((error) => {
  process.stderr.write(`zeroshot-rust install failed: ${error.message}\n`);
  process.exitCode = 1;
});
