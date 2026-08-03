import crypto from 'node:crypto';
import type { TargetDiscoveryDescriptor } from './discovery.ts';

export interface TargetRecord {
  readonly id: string;
  readonly url: string;
  readonly adapterVersion: string;
  readonly deviceToken: string;
  readonly organization?: { readonly id: string; readonly name?: string };
  readonly refreshInvalidated?: true;
  readonly createdAt: string;
}

export class TargetNameInvalidError extends Error {
  constructor(name: string) {
    super(`Invalid target name "${name}". Must be 1-64 characters, alphanumeric and hyphens only.`);
    this.name = 'TargetNameInvalidError';
  }
}

export class TargetNameExistsError extends Error {
  constructor(name: string) {
    super(`Target "${name}" already exists. Remove it first or choose a different name.`);
    this.name = 'TargetNameExistsError';
  }
}

export class TargetNotFoundError extends Error {
  constructor(name: string) {
    super(`Target "${name}" not found.`);
    this.name = 'TargetNotFoundError';
  }
}

export class TargetUrlInvalidError extends Error {
  constructor(url: string, reason: string) {
    super(`Invalid target URL "${url}": ${reason}`);
    this.name = 'TargetUrlInvalidError';
  }
}

const TARGET_NAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?$/;
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = Object.freeze({
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
});

export function validateTargetName(name: string): void {
  if (!TARGET_NAME_PATTERN.test(name) || name.length > 64) {
    throw new TargetNameInvalidError(name);
  }
}

export function normalizeAndValidateUrl(rawUrl: string): string {
  if (/[\u0000-\u0020\u007f]|\s/u.test(rawUrl)) {
    throw new TargetUrlInvalidError(rawUrl, 'URL contains forbidden whitespace or controls');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TargetUrlInvalidError(rawUrl, 'not a valid URL');
  }

  if (parsed.username || parsed.password) {
    throw new TargetUrlInvalidError(rawUrl, 'URL must not contain userinfo');
  }

  if (parsed.search || parsed.hash) {
    throw new TargetUrlInvalidError(rawUrl, 'URL must not contain query or fragment');
  }

  const isLoopback = LOOPBACK_HOSTS[parsed.hostname] === true;
  const protocolAllowed =
    parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback);
  if (!protocolAllowed) {
    throw new TargetUrlInvalidError(
      rawUrl,
      'HTTPS required except for literal loopback HTTP targets'
    );
  }
  if (parsed.pathname !== '/') {
    throw new TargetUrlInvalidError(rawUrl, 'URL must contain only an origin');
  }

  return parsed.origin;
}

interface SettingsWithTargets {
  _targets?: Record<string, TargetRecord>;
  [key: string]: unknown;
}

export interface SettingsPort {
  load(): SettingsWithTargets;
  mutate(mutator: (settings: SettingsWithTargets) => void): void;
}

export function addTarget(
  name: string,
  rawUrl: string,
  settings: SettingsPort,
  descriptor: TargetDiscoveryDescriptor
): TargetRecord {
  validateTargetName(name);
  const url = normalizeAndValidateUrl(rawUrl);

  const existing = settings.load();
  if (existing._targets?.[name]) {
    throw new TargetNameExistsError(name);
  }
  if (!descriptor || descriptor.origin !== url || descriptor.adapter.majorVersion !== 1) {
    throw new TargetUrlInvalidError(rawUrl, 'validated discovery does not match the target origin');
  }

  const record: TargetRecord = {
    id: crypto.randomUUID(),
    url,
    adapterVersion: `v${descriptor.adapter.majorVersion}`,
    deviceToken: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  settings.mutate((s) => {
    if (!s._targets) {
      s._targets = {};
    }
    s._targets[name] = record;
  });

  return record;
}

export function removeTarget(name: string, settings: SettingsPort): TargetRecord {
  const existing = settings.load();
  const record = existing._targets?.[name];
  if (!record) {
    throw new TargetNotFoundError(name);
  }

  settings.mutate((s) => {
    if (s._targets) {
      delete s._targets[name];
    }
  });

  return record;
}

export function getTarget(name: string, settings: SettingsPort): TargetRecord | null {
  const existing = settings.load();
  return existing._targets?.[name] ?? null;
}

export function listTargets(settings: SettingsPort): Array<{ name: string; record: TargetRecord }> {
  const existing = settings.load();
  const targets = existing._targets ?? {};
  return Object.entries(targets).map(([name, record]) => ({ name, record }));
}

export function updateTargetOrganization(
  name: string,
  organization: { id: string; name?: string },
  settings: SettingsPort
): void {
  const existing = settings.load();
  if (!existing._targets?.[name]) {
    throw new TargetNotFoundError(name);
  }

  settings.mutate((s) => {
    const target = s._targets?.[name];
    if (target) {
      (s._targets as Record<string, TargetRecord>)[name] = {
        ...target,
        organization,
      };
    }
  });
}

export function targetRefreshIsInvalidated(
  name: string,
  settings: SettingsPort,
): boolean {
  return settings.load()._targets?.[name]?.refreshInvalidated === true;
}

export function setTargetRefreshInvalidated(
  name: string,
  invalidated: boolean,
  settings: SettingsPort,
): void {
  settings.mutate((state) => {
    const targets = state._targets;
    const target = targets?.[name];
    if (targets === undefined || target === undefined) throw new TargetNotFoundError(name);
    if (invalidated) {
      targets[name] = { ...target, refreshInvalidated: true };
    } else {
      const active = { ...target };
      Reflect.deleteProperty(active, 'refreshInvalidated');
      targets[name] = active;
    }
  });
}
