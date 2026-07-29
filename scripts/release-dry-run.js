#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function runGit(args) {
  execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function validationPlugins(releaseConfig) {
  const allowed = new Set([
    '@semantic-release/commit-analyzer',
    './scripts/semantic-release-notes.js',
  ]);
  return releaseConfig.plugins.filter((plugin) => allowed.has(pluginName(plugin)));
}

async function main() {
  const branch = process.env.GITHUB_REF_NAME?.trim();
  if (!branch) throw new Error('GITHUB_REF_NAME is required for a release dry run');
  runGit(['check-ref-format', `refs/heads/${branch}`]);

  const packageJson = require('../package.json');
  const releaseConfig = packageJson.release;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-release-dry-run-'));
  const mirrorPath = path.join(tempRoot, 'candidate.git');

  try {
    runGit(['init', '--bare', mirrorPath]);
    runGit([
      '--git-dir',
      mirrorPath,
      'fetch',
      projectRoot,
      `+HEAD:refs/heads/${branch}`,
      '+refs/tags/*:refs/tags/*',
    ]);
    runGit(['--git-dir', mirrorPath, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);

    const semanticRelease = (await import('semantic-release')).default;
    const result = await semanticRelease(
      {
        ...releaseConfig,
        branches: [branch],
        repositoryUrl: mirrorPath,
        plugins: validationPlugins(releaseConfig),
        dryRun: true,
        ci: false,
      },
      {
        cwd: projectRoot,
        env: process.env,
      }
    );

    const version = result?.nextRelease.version || '';
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    }
    console.log(`RELEASE_DRY_RUN_RESULT=${version || 'no-release'}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
