export {
  CredentialStoreUnavailableError,
  KeyringCredentialStore,
  FakeCredentialStore,
  targetServiceKey,
  TARGET_ACCOUNT,
  type TargetCredentialStore,
} from './credential-store.ts';

export { acquireTargetLock } from './credential-lock.ts';

export {
  requestDeviceCode,
  pollForToken,
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  UnboundSessionError,
  type DeviceCodeResponse,
  type TokenResponse,
  type HttpTransport,
  type Clock,
} from './device-flow.ts';

export {
  addTarget,
  removeTarget,
  getTarget,
  listTargets,
  updateTargetOrganization,
  validateTargetName,
  normalizeAndValidateUrl,
  TargetNameInvalidError,
  TargetNameExistsError,
  TargetNotFoundError,
  TargetUrlInvalidError,
  type TargetRecord,
  type SettingsPort,
} from './target-registry.ts';

export {
  targetLogin,
  refreshAccessToken,
  getAccessTokenProvider,
  revokeAndCleanup,
  LoginRequiredError,
  type BrowserOpener,
  type TargetSessionDeps,
  type TargetAccessTokenProvider,
} from './target-session.ts';

export {
  discoverTargetSessionEndpoints,
  TargetDiscoveryError,
  type TargetSessionEndpoints,
} from './discovery.ts';
