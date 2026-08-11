import type { ProviderCliFeatures } from './types';

type AvailabilityProbe = 'command' | 'help-or-version' | 'supported-version' | undefined;

export function runtimeProbeIsAvailable(
  availabilityProbe: AvailabilityProbe,
  evidenceAvailable: boolean | undefined,
  helpText: string,
  versionText: string,
  capabilities: ProviderCliFeatures
): boolean {
  const probeAvailable =
    evidenceAvailable ??
    (availabilityProbe === 'command' ? true : Boolean(helpText || versionText));
  const versionSupported =
    availabilityProbe !== 'supported-version' ||
    ('versionMatches' in capabilities && capabilities.versionMatches === true);
  return probeAvailable && versionSupported;
}
