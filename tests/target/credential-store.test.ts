import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CredentialStoreUnavailableError,
  KeyringCredentialStore,
} from '../../src/target/credential-store.ts';

type EntryConstructor = new (service: string, account: string) => {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

const TestableStore = KeyringCredentialStore as unknown as new (
  Entry: EntryConstructor,
) => KeyringCredentialStore;

class MissingEntry {
  constructor(_service: string, _account: string) {}
  getPassword(): string | null { return null; }
  setPassword(_password: string): void {}
  deletePassword(): boolean { return false; }
}

describe('KeyringCredentialStore backend faults', () => {
  it('distinguishes a missing entry from a secure-store read fault', async () => {
    const missing = new TestableStore(MissingEntry);
    assert.equal(await missing.get('service', 'account'), null);

    class FaultyEntry extends MissingEntry {
      override getPassword(): string | null {
        throw new Error('backend unavailable');
      }
    }
    const faulty = new TestableStore(FaultyEntry);
    await assert.rejects(
      faulty.get('service', 'account'),
      CredentialStoreUnavailableError,
    );
  });

  it('propagates secure-store deletion faults but accepts a missing entry', async () => {
    const missing = new TestableStore(MissingEntry);
    await missing.delete('service', 'account');

    class FaultyEntry extends MissingEntry {
      override deletePassword(): boolean {
        throw new Error('backend unavailable');
      }
    }
    const faulty = new TestableStore(FaultyEntry);
    await assert.rejects(
      faulty.delete('service', 'account'),
      CredentialStoreUnavailableError,
    );
  });
});
