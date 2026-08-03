'use strict';

const { MAX_SECRET_BYTES, spawnBounded, trimmedSecret } = require('./secret-input');

const GITHUB_HOST = 'github.com';
const HANDLE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const METADATA_TEMPLATE =
  '{{range .hosts}}{{range .}}{{if .active}}{{.host}}{{printf "\\x00"}}{{.login}}' +
  '{{end}}{{end}}{{end}}';
const STATUS_TEMPLATE =
  METADATA_TEMPLATE.replace('{{end}}{{end}}{{end}}', '') +
  '{{printf "\\x00"}}{{.token}}{{end}}{{end}}{{end}}';

function parseGithubMetadata(buffer) {
  const separator = buffer.indexOf(0);
  if (separator < 1 || buffer.indexOf(0, separator + 1) !== -1) {
    throw new Error('GitHub CLI returned invalid account metadata');
  }
  const host = buffer.subarray(0, separator).toString('ascii');
  const account = buffer.subarray(separator + 1).toString('ascii');
  if (host !== GITHUB_HOST || !HANDLE_PATTERN.test(account)) {
    throw new Error('GitHub CLI has no active github.com account');
  }
  return Object.freeze({ source: 'gh-cli', host: GITHUB_HOST, account });
}

function parseAcquiredGithub(buffer) {
  const first = buffer.indexOf(0);
  const second = first === -1 ? -1 : buffer.indexOf(0, first + 1);
  if (first < 1 || second <= first + 1 || buffer.indexOf(0, second + 1) !== -1) {
    throw new Error('GitHub CLI returned invalid atomic credential metadata');
  }
  const host = buffer.subarray(0, first).toString('ascii');
  const account = buffer.subarray(first + 1, second).toString('ascii');
  if (host !== GITHUB_HOST || !HANDLE_PATTERN.test(account)) {
    throw new Error('GitHub CLI returned an invalid active account');
  }
  const token = trimmedSecret(buffer.subarray(second + 1), 'GitHub token');
  if (token.length > MAX_SECRET_BYTES) {
    token.fill(0);
    throw new Error('GitHub CLI token is outside the safety bound');
  }
  return {
    metadata: Object.freeze({ source: 'gh-cli', host: GITHUB_HOST, account }),
    token,
  };
}

const defaultGithub = Object.freeze({
  async inspect() {
    const result = await spawnBounded('gh', [
      'auth',
      'status',
      '--active',
      '--hostname',
      GITHUB_HOST,
      '--json',
      'hosts',
      '--template',
      METADATA_TEMPLATE,
    ]);
    try {
      if (result.code !== 0) throw new Error('GitHub CLI is not authenticated for github.com');
      return parseGithubMetadata(result.stdout);
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  },

  async acquire() {
    const result = await spawnBounded('gh', [
      'auth',
      'status',
      '--active',
      '--hostname',
      GITHUB_HOST,
      '--show-token',
      '--json',
      'hosts',
      '--template',
      STATUS_TEMPLATE,
    ]);
    try {
      if (result.code !== 0) throw new Error('GitHub CLI could not acquire its active credential');
      return parseAcquiredGithub(result.stdout);
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  },
});

module.exports = { defaultGithub, parseAcquiredGithub, parseGithubMetadata };
