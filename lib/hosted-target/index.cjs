'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.isRetryable =
  exports.TargetServerError =
  exports.TargetNotFoundError =
  exports.TargetCapacityError =
  exports.TargetProtocolError =
  exports.TargetTransportError =
  exports.TargetRateLimitError =
  exports.TargetConflictError =
  exports.TargetAuthError =
  exports.TargetAdapterError =
  exports.createTargetAdapter =
    void 0;
var target_adapter_ts_1 = require('./target-adapter.cjs');
Object.defineProperty(exports, 'createTargetAdapter', {
  enumerable: true,
  get: function () {
    return target_adapter_ts_1.createTargetAdapter;
  },
});
var errors_ts_1 = require('./errors.cjs');
Object.defineProperty(exports, 'TargetAdapterError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetAdapterError;
  },
});
Object.defineProperty(exports, 'TargetAuthError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetAuthError;
  },
});
Object.defineProperty(exports, 'TargetConflictError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetConflictError;
  },
});
Object.defineProperty(exports, 'TargetRateLimitError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetRateLimitError;
  },
});
Object.defineProperty(exports, 'TargetTransportError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetTransportError;
  },
});
Object.defineProperty(exports, 'TargetProtocolError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetProtocolError;
  },
});
Object.defineProperty(exports, 'TargetCapacityError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetCapacityError;
  },
});
Object.defineProperty(exports, 'TargetNotFoundError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetNotFoundError;
  },
});
Object.defineProperty(exports, 'TargetServerError', {
  enumerable: true,
  get: function () {
    return errors_ts_1.TargetServerError;
  },
});
Object.defineProperty(exports, 'isRetryable', {
  enumerable: true,
  get: function () {
    return errors_ts_1.isRetryable;
  },
});
