'use strict';

const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function createTempDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeTempDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}

module.exports = { createTempDirectory, removeTempDirectory };
