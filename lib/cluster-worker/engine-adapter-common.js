'use strict';

const { MAX_SUMMARY_BYTES } = require('./contracts');

const DEFAULT_COMPLETION_SUMMARY = 'Cluster completed';
const PUBLIC_ADAPTER_METHODS = Object.freeze([
  'start',
  'status',
  'stop',
  'waitForCleanup',
  'close',
]);

function completionSummary(value) {
  const summary = typeof value === 'string' ? value : DEFAULT_COMPLETION_SUMMARY;
  if (Buffer.byteLength(summary, 'utf8') <= MAX_SUMMARY_BYTES) return summary;
  let bounded = '';
  let bytes = 0;
  for (const character of summary) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > MAX_SUMMARY_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

function createAdapterFacade(adapter) {
  return Object.freeze(
    Object.fromEntries(PUBLIC_ADAPTER_METHODS.map((name) => [name, adapter[name].bind(adapter)]))
  );
}

function requestText(request, artifactText) {
  if (request.source === 'issue') return request.issue;
  if (request.source === 'prompt') return request.prompt;
  return typeof artifactText === 'function' ? artifactText() : artifactText;
}

function declaredFailureEvent() {
  return { type: 'failed', code: 'crash', reason: 'declared_failure' };
}

function frozenResourceStatus(resource, state, details) {
  if (!resource) return null;
  return Object.freeze({ clusterId: resource.clusterId, state, ...details });
}

module.exports = {
  completionSummary,
  createAdapterFacade,
  declaredFailureEvent,
  frozenResourceStatus,
  requestText,
};
