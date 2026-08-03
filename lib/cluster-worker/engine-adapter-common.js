'use strict';

const PUBLIC_ADAPTER_METHODS = Object.freeze([
  'start',
  'status',
  'stop',
  'waitForCleanup',
  'close',
]);

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
  createAdapterFacade,
  declaredFailureEvent,
  frozenResourceStatus,
  requestText,
};
