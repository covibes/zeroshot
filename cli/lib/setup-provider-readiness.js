const { getProviderMetadata, providerSupportsCapability } = require('../../lib/provider-names');

const PROVIDER_READINESS = Object.freeze([
  'ready',
  'login-required',
  'incompatible',
  'unavailable',
  'unknown',
]);

function incompatible(reason) {
  return { status: 'incompatible', selectable: false, reason };
}

function executionCompatibility(providerId, isolation, settings) {
  const capability = isolation === 'docker' ? 'dockerIsolation' : 'worktreeIsolation';
  if (isolation !== 'none' && !providerSupportsCapability(providerId, capability)) {
    return incompatible(`${isolation} isolation is not supported`);
  }
  const metadata = getProviderMetadata(providerId);
  const providerSettings = settings.providerSettings?.[providerId];
  if (!metadata.settingsValidator || !providerSettings || typeof providerSettings !== 'object') {
    return null;
  }
  const executionContext = isolation === 'docker' ? 'docker' : 'detached';
  try {
    const error = metadata.settingsValidator(providerSettings, { executionContext });
    return error ? incompatible(error) : null;
  } catch (error) {
    return { status: 'unknown', selectable: false, reason: error.message };
  }
}
function unavailableReadiness(probe) {
  const status = probe.commandAvailable ? 'unknown' : 'unavailable';
  const fallback = probe.commandAvailable ? 'CLI probe failed' : 'CLI is not installed';
  return { status, selectable: false, reason: probe.error || fallback };
}

function authReadiness(probe) {
  if (probe.authStatus === 'login-required') {
    return { status: 'login-required', selectable: false, reason: probe.authReason };
  }
  if (probe.authStatus !== 'ready') {
    return {
      status: 'unknown',
      selectable: false,
      reason: probe.authReason || 'readiness is unknown',
    };
  }
  return { status: 'ready', selectable: true, reason: probe.path || 'available' };
}

function assessProviderReadiness({ providerId, probe, isolation, settings }) {
  if (!probe) return { status: 'unknown', selectable: false, reason: 'probe did not complete' };
  if (!probe.available) return unavailableReadiness(probe);
  const compatibility = executionCompatibility(providerId, isolation, settings);
  return compatibility || authReadiness(probe);
}

function providerChoices({ plan, probes, isolation, settings }) {
  return Object.keys(plan.facts.providers).map((providerId) => {
    const metadata = getProviderMetadata(providerId);
    const readiness = assessProviderReadiness({
      providerId,
      probe: probes[`provider:${providerId}`],
      isolation,
      settings,
    });
    return {
      value: providerId,
      label: metadata.displayName,
      detail: readiness.reason,
      status: readiness.status,
      disabled: !readiness.selectable,
      installInstructions: metadata.installInstructions,
      authInstructions: metadata.authInstructions,
    };
  });
}

module.exports = {
  PROVIDER_READINESS,
  assessProviderReadiness,
  executionCompatibility,
  providerChoices,
};
