import target from '../../lib/target/index.js';
import hostedRun from '../../lib/target/hosted-run.js';
import hostedCommands from '../../lib/target/register-hosted-commands.js';

export const {
  CredentialStoreUnavailableError,
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  FakeCredentialStore,
  KeyringCredentialStore,
  LoginRequiredError,
  TargetDiscoveryError,
  TargetNameExistsError,
  TargetNameInvalidError,
  TargetNotFoundError,
  TargetSessionManager,
  TargetUrlInvalidError,
  addTarget,
  discoverTarget,
  discoverTargetSessionEndpoints,
  getTarget,
  listTargets,
  normalizeAndValidateUrl,
  pollForToken,
  removeTarget,
  requestDeviceCode,
  targetServiceKey,
  validateTargetName,
  TARGET_ACCOUNT,
} = target;

export const {
  HostedRunHttpError,
  cancelHostedRun,
  resolveHostedInput,
  runHosted,
  statusHostedRun,
  validateHostedOptions,
} = hostedRun;

export const { registerHostedCommands } = hostedCommands;
