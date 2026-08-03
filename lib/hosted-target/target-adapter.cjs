'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createTargetAdapter = createTargetAdapter;
const zero_cloud_v1_adapter_ts_1 = require('./zero-cloud-v1-adapter.cjs');
function createTargetAdapter(options) {
  if (options.descriptor.adapter.majorVersion !== 1) {
    throw new Error('Unsupported hosted target adapter version');
  }
  return new zero_cloud_v1_adapter_ts_1.ZeroCloudV1TargetAdapter(options);
}
