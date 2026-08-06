export class CredentialStoreUnavailableError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'OS secure store unavailable. Install libsecret (Linux), or run on macOS/Windows. No plaintext fallback.',
    );
    this.name = 'CredentialStoreUnavailableError';
  }
}

export interface TargetCredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, token: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export function targetServiceKey(targetId: string): string {
  return `zeroshot-target-${targetId}`;
}

export const TARGET_ACCOUNT = 'refresh-token';

export class KeyringCredentialStore implements TargetCredentialStore {
  private readonly Entry: new (service: string, account: string) => {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
  };

  private constructor(
    Entry: new (service: string, account: string) => {
      getPassword(): string | null;
      setPassword(password: string): void;
      deletePassword(): boolean;
    },
  ) {
    this.Entry = Entry;
  }

  static async create(): Promise<KeyringCredentialStore> {
    let keyringModule: { Entry: new (service: string, account: string) => {
      getPassword(): string | null;
      setPassword(password: string): void;
      deletePassword(): boolean;
    } };
    try {
      keyringModule = await import('@napi-rs/keyring') as typeof keyringModule;
    } catch {
      throw new CredentialStoreUnavailableError();
    }
    if (!keyringModule.Entry) {
      throw new CredentialStoreUnavailableError();
    }
    return new KeyringCredentialStore(keyringModule.Entry);
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const entry = new this.Entry(service, account);
      return entry.getPassword();
    } catch {
      throw new CredentialStoreUnavailableError('The secure credential store could not be read.');
    }
  }

  async set(service: string, account: string, token: string): Promise<void> {
    try {
      const entry = new this.Entry(service, account);
      entry.setPassword(token);
    } catch {
      throw new CredentialStoreUnavailableError('The secure credential store could not be updated.');
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      const entry = new this.Entry(service, account);
      entry.deletePassword();
    } catch {
      throw new CredentialStoreUnavailableError('The secure credential store could not be cleared.');
    }
  }
}

export class FakeCredentialStore implements TargetCredentialStore {
  private readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}::${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.store.get(this.key(service, account)) ?? null;
  }

  async set(service: string, account: string, token: string): Promise<void> {
    this.store.set(this.key(service, account), token);
  }

  async delete(service: string, account: string): Promise<void> {
    this.store.delete(this.key(service, account));
  }

  has(service: string, account: string): boolean {
    return this.store.has(this.key(service, account));
  }

  clear(): void {
    this.store.clear();
  }
}
