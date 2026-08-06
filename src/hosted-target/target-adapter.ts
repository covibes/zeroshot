import { ZeroCloudV1TargetAdapter } from './zero-cloud-v1-adapter.js';
import type { CreateTargetAdapterOptions, TargetAdapter } from './adapter-types.js';
export type {
  CreateTargetAdapterOptions,
  CredentialInstallCapability,
  TargetAdapter,
} from './adapter-types.js';

export function createTargetAdapter(options: CreateTargetAdapterOptions): TargetAdapter {
  if (options.descriptor.adapter.majorVersion !== 1) {
    throw new Error('Unsupported hosted target adapter version');
  }
  return new ZeroCloudV1TargetAdapter(options);
}
