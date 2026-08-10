export {
  CredentialStoreUnavailableError,
  KeyringCredentialStore,
  FakeCredentialStore,
  targetServiceKey,
  TARGET_ACCOUNT,
  type TargetCredentialStore,
} from './credential-store.js';

export { acquireTargetLock } from './credential-lock.js';

export {
  requestDeviceCode,
  pollForToken,
  parseTokenResponse,
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  UnboundSessionError,
  type DeviceCodeResponse,
  type DeviceExchangeContext,
  type TokenResponse,
  type HttpTransport,
  type Clock,
} from './device-flow.js';

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
} from './target-registry.js';

export {
  TargetSessionManager,
  LoginRequiredError,
  type BrowserOpener,
  type TargetSessionDeps,
  type TargetSessionManagerInit,
} from './target-session.js';

export {
  discoverTarget,
  discoverTargetSessionEndpoints,
  expandRoute,
  TargetDiscoveryError,
  type RunIntentDescriptor,
  type RouteTemplate,
  type TargetDiscoveryDescriptor,
  type TargetSessionEndpoints,
} from './discovery.js';
