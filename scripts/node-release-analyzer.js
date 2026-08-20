'use strict';

const { nodeReleaseContext } = require('./node-release-commits');

async function analyzeNodeCommits(pluginConfig, context, options = {}) {
  const analyzer = options.analyzer || (await import('@semantic-release/commit-analyzer'));
  const releaseContext = nodeReleaseContext(context, {
    pathsForCommit: options.pathsForCommit,
  });
  return analyzer.analyzeCommits(pluginConfig, releaseContext);
}

function analyzeCommits(pluginConfig, context) {
  return analyzeNodeCommits(pluginConfig, context);
}

module.exports = { analyzeCommits, analyzeNodeCommits };
