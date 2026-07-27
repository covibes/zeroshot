#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const RELEASE_ORDER = ['patch', 'minor', 'major'];
const REQUIRED_PLUGINS = [
  '@semantic-release/commit-analyzer',
  './scripts/semantic-release-notes.js',
  '@semantic-release/npm',
  '@semantic-release/github',
];
const FORBIDDEN_EFFECTIVE_PLUGINS = new Set([
  '@semantic-release/changelog',
  '@semantic-release/git',
]);

function normalizePlugin(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function releaseRank(type) {
  return RELEASE_ORDER.indexOf(type);
}

function maxReleaseType(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return releaseRank(candidate) > releaseRank(current) ? candidate : current;
}

function analyzeMessage(message) {
  const firstLine = String(message || '')
    .split(/\r?\n/, 1)[0]
    .trim();
  if (!firstLine) return null;
  if (/BREAKING CHANGE:|BREAKING-CHANGE:/m.test(message)) return 'major';

  const separator = firstLine.indexOf(': ');
  if (separator <= 0) return null;

  const header = firstLine.slice(0, separator);
  const breaking = header.endsWith('!');
  const typeAndScope = breaking ? header.slice(0, -1) : header;
  const scopeStart = typeAndScope.indexOf('(');
  const type = scopeStart === -1 ? typeAndScope : typeAndScope.slice(0, scopeStart);

  if (!/^[a-z][a-z0-9-]*$/i.test(type)) return null;
  if (breaking) return 'major';

  switch (type) {
    case 'feat':
      return 'minor';
    case 'fix':
    case 'perf':
      return 'patch';
    default:
      return null;
  }
}

function releaseTypeForMessages(messages) {
  let releaseType = null;
  for (const message of messages) {
    releaseType = maxReleaseType(releaseType, analyzeMessage(message));
  }
  return releaseType;
}

function getPluginNames(releaseConfig) {
  return (releaseConfig.plugins || []).map(normalizePlugin);
}

function validateReleaseConfig(packageJson) {
  const releaseConfig = packageJson.release;
  if (!releaseConfig || typeof releaseConfig !== 'object') {
    throw new Error('package.json#release is required as the single release configuration');
  }

  const branches = Array.isArray(releaseConfig.branches)
    ? releaseConfig.branches
    : [releaseConfig.branches].filter(Boolean);
  if (!branches.includes('main')) {
    throw new Error('package.json#release.branches must include main');
  }

  const pluginNames = getPluginNames(releaseConfig);
  for (const required of REQUIRED_PLUGINS) {
    if (!pluginNames.includes(required)) {
      throw new Error(`package.json#release.plugins is missing ${required}`);
    }
  }

  for (const forbidden of FORBIDDEN_EFFECTIVE_PLUGINS) {
    if (pluginNames.includes(forbidden)) {
      throw new Error(
        `${forbidden} must not be in the effective release config for protected main`
      );
    }
  }

  const npmPlugin = releaseConfig.plugins.find(
    (plugin) => normalizePlugin(plugin) === '@semantic-release/npm'
  );
  const npmOptions = Array.isArray(npmPlugin) ? npmPlugin[1] || {} : {};
  if (npmOptions.npmPublish !== true) {
    throw new Error('@semantic-release/npm must publish to npm');
  }

  const analyzerPlugin = releaseConfig.plugins.find(
    (plugin) => normalizePlugin(plugin) === '@semantic-release/commit-analyzer'
  );
  const analyzerOptions = Array.isArray(analyzerPlugin) ? analyzerPlugin[1] || {} : {};
  if (Array.isArray(analyzerOptions.releaseRules) && analyzerOptions.releaseRules.length > 0) {
    throw new Error(
      '@semantic-release/commit-analyzer must use the standard conventional release rules'
    );
  }

  return pluginNames;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function latestReleaseTag() {
  return git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
}

function commitMessagesSince(tag) {
  const output = git(['log', '--format=%B%x1e', `${tag}..HEAD`]);
  return output
    .split('\x1e')
    .map((message) => message.trim())
    .filter(Boolean);
}

function prTitleFromEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  const event = readJson(eventPath);
  return event.pull_request?.title || null;
}

function prNumberFromMergeQueueRef() {
  const refName = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || '';
  const match = refName.match(/(?:^|\/)pr-(\d+)-/);
  return match ? match[1] : null;
}

function githubJson(path) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${repository}${path}`,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'zeroshot-release-preflight',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub API ${path} returned ${response.statusCode}: ${body}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

async function prTitleFromMergeQueue() {
  const number = prNumberFromMergeQueueRef();
  if (!number) return null;
  const pull = await githubJson(`/pulls/${number}`);
  return pull?.title || null;
}

async function releaseSignal() {
  const tag = latestReleaseTag();
  const messages = commitMessagesSince(tag);
  let releaseType = releaseTypeForMessages(messages);

  let title = prTitleFromEvent();
  if (!title) title = await prTitleFromMergeQueue();
  releaseType = maxReleaseType(releaseType, analyzeMessage(title));

  return {
    latestTag: tag,
    commitCount: messages.length,
    prTitle: title,
    releaseType,
  };
}

async function main() {
  const packageJson = readJson('package.json');
  const pluginNames = validateReleaseConfig(packageJson);
  const signal = await releaseSignal();

  console.log(`Effective release plugins: ${pluginNames.join(', ')}`);
  console.log(`Latest release tag: ${signal.latestTag}`);
  console.log(`Commits since tag: ${signal.commitCount}`);
  if (signal.prTitle) console.log(`Release PR title: ${signal.prTitle}`);

  if (!signal.releaseType) {
    console.log('Release preflight passed: no publication expected');
    return;
  }

  console.log(`Release preflight passed: ${signal.releaseType}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release preflight failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  analyzeMessage,
  maxReleaseType,
  releaseTypeForMessages,
  validateReleaseConfig,
};
