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
  parseTokenResponse,
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  UnboundSessionError,
  type DeviceCodeResponse,
  type DeviceExchangeContext,
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
  TargetSessionManager,
  LoginRequiredError,
  type BrowserOpener,
  type TargetSessionDeps,
  type TargetSessionManagerInit,
} from './target-session.ts';

export {
  discoverTarget,
  discoverTargetSessionEndpoints,
  expandRoute,
  TargetDiscoveryError,
  type CredentialInstallDescriptor,
  type RouteTemplate,
  type TargetDiscoveryDescriptor,
  type TargetSessionEndpoints,
} from './discovery.ts';
