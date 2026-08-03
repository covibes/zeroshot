import { ZeroCloudV1TargetAdapter } from './zero-cloud-v1-adapter.mjs';
export function createTargetAdapter(options) {
  if (options.descriptor.adapter.majorVersion !== 1) {
    throw new Error('Unsupported hosted target adapter version');
  }
  return new ZeroCloudV1TargetAdapter(options);
}
