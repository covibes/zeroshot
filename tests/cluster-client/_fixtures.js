'use strict';

const { MultiplexedTransport } = require('../../lib/cluster/cjs/index.js');

/** In-memory `FrameSink` capturing every sent frame; `sendFrame` can be scripted to fail once. */
class FakeSink {
  constructor() {
    this.frames = [];
    this._failNextCount = 0;
  }

  /** The next `sendFrame` calls (up to `count`) reject instead of recording the frame. */
  failNextSends(count = 1) {
    this._failNextCount = count;
  }

  sendFrame(frame) {
    if (this._failNextCount > 0) {
      this._failNextCount -= 1;
      return Promise.reject(new Error('WebSocket is not open'));
    }
    this.frames.push(frame);
    return Promise.resolve();
  }
}

/** A `MultiplexedTransport` over a `FakeSink`, with a helper to feed lines back in as if received. */
function createHarness(options) {
  const sink = new FakeSink();
  const transport = new MultiplexedTransport(sink, options);
  return { sink, transport };
}

function parseFrame(frame) {
  return JSON.parse(frame);
}

/** Builds a JSON-RPC success response line replying to the given request frame. */
function successReplyFor(frame, result) {
  const request = parseFrame(frame);
  return JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
}

function eventNotification(subscriptionId, params) {
  return JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { subscriptionId, ...params } });
}

function closedNotification(subscriptionId, reason, extra) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'subscription/closed',
    params: { subscriptionId, reason, ...extra },
  });
}

module.exports = {
  FakeSink,
  createHarness,
  parseFrame,
  successReplyFor,
  eventNotification,
  closedNotification,
};
