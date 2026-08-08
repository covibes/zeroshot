'use strict';

const DELIVERY_CONTRACT_VERSION = 'zeroshot.delivery/v1';
const REVISION = /^[0-9a-f]{40}$/;

function invalid(field) {
  throw new Error(`Invalid ${DELIVERY_CONTRACT_VERSION} ${field}`);
}

function branch(value, field = 'targetBranch') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('.') ||
    value.endsWith('/') ||
    value.includes('//')
  ) {
    invalid(field);
  }
  return value;
}

function repository(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  return repositoryOwner(owner) && repositoryName(name);
}

function repositoryOwner(owner) {
  return (
    owner.length >= 1 &&
    owner.length <= 39 &&
    /^[a-z0-9-]+$/.test(owner) &&
    !owner.startsWith('-') &&
    !owner.endsWith('-')
  );
}

function repositoryName(name) {
  return (
    name.length >= 1 &&
    name.length <= 100 &&
    /^[a-z0-9._-]+$/.test(name) &&
    /^[a-z0-9]/.test(name) &&
    /[a-z0-9._]$/.test(name) &&
    !name.endsWith('.git')
  );
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(field);
  }
}

function normalizeDeliveryRequest(value) {
  const keys = ['baseRevision', 'mode', 'repository', 'targetBranch', 'version'];
  exactKeys(value, keys, 'request');
  if (value.version !== DELIVERY_CONTRACT_VERSION) invalid('request.version');
  if (!['pr', 'ship'].includes(value.mode)) invalid('request.mode');
  if (!repository(value.repository)) {
    invalid('request.repository');
  }
  if (!REVISION.test(value.baseRevision)) invalid('request.baseRevision');
  return Object.freeze({
    version: DELIVERY_CONTRACT_VERSION,
    mode: value.mode,
    repository: value.repository,
    targetBranch: branch(value.targetBranch),
    baseRevision: value.baseRevision,
  });
}

function resultKeys(disposition) {
  const common = [
    'baseRevision',
    'deliveryBranch',
    'disposition',
    'headRevision',
    'mode',
    'pullRequestUrl',
    'repository',
    'targetBranch',
    'version',
  ];
  return disposition === 'merged' ? [...common, 'mergeRevision'].sort() : common.sort();
}

function requestFromResult(value) {
  return normalizeDeliveryRequest({
    version: value.version,
    mode: value.mode,
    repository: value.repository,
    targetBranch: value.targetBranch,
    baseRevision: value.baseRevision,
  });
}

function validateResultReferences(value, request) {
  branch(value.deliveryBranch, 'result.deliveryBranch');
  if (!REVISION.test(value.headRevision) || value.headRevision === request.baseRevision) {
    invalid('result.headRevision');
  }
  const prefix = `https://github.com/${request.repository}/pull/`;
  if (typeof value.pullRequestUrl !== 'string' || !value.pullRequestUrl.startsWith(prefix)) {
    invalid('result.pullRequestUrl');
  }
}

function normalizeDeliveryResult(value) {
  const disposition = value?.disposition;
  const dispositions = ['pull_request_open', 'merged', 'auto_merge_enabled'];
  if (!dispositions.includes(disposition)) invalid('result.disposition');
  exactKeys(value, resultKeys(disposition), 'result');
  const request = requestFromResult(value);
  const validDisposition =
    (request.mode === 'pr' && disposition === 'pull_request_open') ||
    (request.mode === 'ship' && ['merged', 'auto_merge_enabled'].includes(disposition));
  if (!validDisposition) invalid('result mode/disposition');
  validateResultReferences(value, request);
  if (disposition === 'merged' && !REVISION.test(value.mergeRevision)) {
    invalid('result.mergeRevision');
  }
  return Object.freeze({ ...value });
}

module.exports = {
  DELIVERY_CONTRACT_VERSION,
  normalizeDeliveryRequest,
  normalizeDeliveryResult,
};
