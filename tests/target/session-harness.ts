import {
  FakeCredentialStore,
  TARGET_ACCOUNT,
  targetServiceKey,
  type TargetCredentialStore,
} from '../helpers/target-runtime.mjs';
import type { HttpTransport } from '../helpers/target-runtime.mjs';
import { TargetSessionManager } from '../helpers/target-runtime.mjs';
import {
  FakeClock,
  fakeLock,
  makeSessionDeps,
  makeSettingsPort,
  makeTarget,
} from './harness.mjs';

export function makeSessionManager(
  http: HttpTransport,
  store: TargetCredentialStore = new FakeCredentialStore(),
  acquireLock: () => Promise<() => Promise<void>> = fakeLock(),
) {
  const target = makeTarget();
  const settings = makeSettingsPort({ _targets: { primary: target } });
  return {
    target,
    settings,
    store,
    value: new TargetSessionManager({
      targetName: 'primary',
      target,
      credentialStore: store,
      acquireLock,
      settings,
      deps: makeSessionDeps({ http, clock: new FakeClock(1_000_000) }),
    }),
  };
}

export type SessionManagerFixture = ReturnType<typeof makeSessionManager>;

export async function setRefreshToken(
  fixture: SessionManagerFixture,
  token: string,
): Promise<void> {
  await fixture.store.set(targetServiceKey(fixture.target.id), TARGET_ACCOUNT, token);
}

export function getRefreshToken(fixture: SessionManagerFixture): Promise<string | null> {
  return fixture.store.get(targetServiceKey(fixture.target.id), TARGET_ACCOUNT);
}
