'use strict';

const production = require('./workspace-ship-production');

function createCertificationPullRequest(config, branch, headRevision) {
  if (!/^zeroshot\/hosted-[a-f0-9]{20}$/.test(branch)) {
    throw new Error('Certification received an invalid hosted branch');
  }
  if (!/^[a-f0-9]{40}$/.test(headRevision) || headRevision === config.baseRevision) {
    throw new Error('Certification received an invalid hosted revision');
  }
  return `https://github.com/${config.repository}/pull/1`;
}

function shipWorkspace(config, branch) {
  return production.shipWorkspace(config, branch, {
    createPullRequest: createCertificationPullRequest,
  });
}

module.exports = { ...production, shipWorkspace };
