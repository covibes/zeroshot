#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const severityRank = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);
const approvedLeafAdvisories = new Map([
  ['brace-expansion', new Set(['1123898', '1130591'])],
  ['smol-toml', new Set(['1115393'])],
]);
const approvedLeafPaths = new Map([
  ['brace-expansion', 'node_modules/opcore/node_modules/brace-expansion'],
  ['smol-toml', 'node_modules/opcore/node_modules/smol-toml'],
]);
const approvedVersions = new Map([
  ['node_modules/opcore', '0.2.1'],
  ['node_modules/opcore/node_modules/brace-expansion', '5.0.6'],
  ['node_modules/opcore/node_modules/smol-toml', '1.6.0'],
]);

function isRelevant(vulnerability) {
  return (severityRank.get(vulnerability.severity) ?? Number.POSITIVE_INFINITY) >= 2;
}

function hasExpectedNodes(name, vulnerability) {
  const nodes = vulnerability.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  const leafPath = approvedLeafPaths.get(name);
  if (leafPath !== undefined) return nodes.length === 1 && nodes[0] === leafPath;
  if (name === 'opcore') return nodes.length === 1 && nodes[0] === 'node_modules/opcore';
  return nodes.every((node) => node.startsWith('node_modules/opcore/node_modules/'));
}

function isApprovedLeaf(name, vulnerability) {
  const approvedSources = approvedLeafAdvisories.get(name);
  if (approvedSources === undefined || !hasExpectedNodes(name, vulnerability)) return false;
  if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) return false;
  return vulnerability.via.every(
    (advisory) =>
      advisory !== null &&
      typeof advisory === 'object' &&
      approvedSources.has(String(advisory.source))
  );
}

function isApprovedVulnerability(name, vulnerabilities, memo, active) {
  if (memo.has(name)) return memo.get(name);
  if (active.has(name)) return false;
  const vulnerability = vulnerabilities[name];
  if (vulnerability === undefined || !hasExpectedNodes(name, vulnerability)) return false;
  if (isApprovedLeaf(name, vulnerability)) {
    memo.set(name, true);
    return true;
  }
  if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) return false;
  if (!vulnerability.via.every((dependency) => typeof dependency === 'string')) return false;

  active.add(name);
  const approved = vulnerability.via.every((dependency) =>
    isApprovedVulnerability(dependency, vulnerabilities, memo, active)
  );
  active.delete(name);
  memo.set(name, approved);
  return approved;
}

function exceptionVersionsMatch(lock) {
  if (lock?.packages?.['']?.dependencies?.opcore !== '0.2.1') return false;
  return Array.from(approvedVersions).every(
    ([packagePath, version]) => lock?.packages?.[packagePath]?.version === version
  );
}

function evaluateAudit(payload, lock) {
  if (payload === null || typeof payload !== 'object' || payload.error !== undefined) {
    throw new Error('npm audit did not return a valid vulnerability report');
  }
  const vulnerabilities = payload.vulnerabilities;
  if (vulnerabilities === null || typeof vulnerabilities !== 'object') {
    throw new Error('npm audit report is missing vulnerabilities');
  }

  const relevant = Object.entries(vulnerabilities).filter(([, vulnerability]) =>
    isRelevant(vulnerability)
  );
  const memo = new Map();
  const allowed = relevant.filter(([name]) =>
    isApprovedVulnerability(name, vulnerabilities, memo, new Set())
  );
  if (allowed.length > 0 && !exceptionVersionsMatch(lock)) {
    return { allowed: [], blocked: relevant, versionMismatch: true };
  }
  const allowedNames = new Set(allowed.map(([name]) => name));
  return {
    allowed,
    blocked: relevant.filter(([name]) => !allowedNames.has(name)),
    versionMismatch: false,
  };
}

function runAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['audit', '--audit-level=moderate', '--omit=dev', '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      result.stderr || result.stdout || `npm audit exited with status ${result.status}`
    );
  }
  const lock = require('../package-lock.json');
  return evaluateAudit(payload, lock);
}

function main() {
  const result = runAudit();
  if (result.blocked.length > 0) {
    const suffix = result.versionMismatch ? ' (Opcore exception version mismatch)' : '';
    console.error(
      `Production dependency audit failed${suffix}: ${result.blocked.map(([name]) => name).join(', ')}`
    );
    process.exitCode = 1;
    return;
  }
  if (result.allowed.length > 0) {
    console.warn(
      `Production dependency audit passed with pinned Opcore advisories: ${result.allowed
        .map(([name]) => name)
        .join(', ')}`
    );
    return;
  }
  console.log('Production dependency audit passed');
}

if (require.main === module) main();

module.exports = { evaluateAudit };
