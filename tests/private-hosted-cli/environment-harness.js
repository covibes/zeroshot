'use strict';

const assert = require('node:assert/strict');

async function withEnvironment(values, operation) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function assertSecretsAbsent(serialized, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(serialized.includes(name), false);
    assert.equal(serialized.includes(value), false);
  }
}

module.exports = { assertSecretsAbsent, withEnvironment };
