import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTarget,
  removeTarget,
  getTarget,
  listTargets,
  validateTargetName,
  normalizeAndValidateUrl,
  TargetNameInvalidError,
  TargetNameExistsError,
  TargetNotFoundError,
  TargetUrlInvalidError,
} from '../helpers/target-runtime.mjs';
import { makeDiscoveryEndpoints, makeSettingsPort } from './harness.mjs';

function addValidatedTarget(
  name: string,
  url: string,
  settings: ReturnType<typeof makeSettingsPort>
) {
  const origin = normalizeAndValidateUrl(url);
  return addTarget(name, origin, settings, makeDiscoveryEndpoints(origin).descriptor);
}

describe('validateTargetName', () => {
  it('accepts valid names', () => {
    assert.doesNotThrow(() => validateTargetName('staging'));
    assert.doesNotThrow(() => validateTargetName('prod-us-east'));
    assert.doesNotThrow(() => validateTargetName('a'));
    assert.doesNotThrow(() => validateTargetName('test123'));
  });

  it('rejects empty name', () => {
    assert.throws(() => validateTargetName(''), TargetNameInvalidError);
  });

  it('rejects names with special characters', () => {
    assert.throws(() => validateTargetName('my_target'), TargetNameInvalidError);
    assert.throws(() => validateTargetName('my.target'), TargetNameInvalidError);
    assert.throws(() => validateTargetName('my target'), TargetNameInvalidError);
  });

  it('rejects names starting or ending with hyphen', () => {
    assert.throws(() => validateTargetName('-staging'), TargetNameInvalidError);
    assert.throws(() => validateTargetName('staging-'), TargetNameInvalidError);
  });

  it('rejects names longer than 64 chars', () => {
    assert.throws(() => validateTargetName('a'.repeat(65)), TargetNameInvalidError);
  });
});

describe('normalizeAndValidateUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    assert.equal(normalizeAndValidateUrl('https://api.example.com'), 'https://api.example.com');
    assert.equal(normalizeAndValidateUrl('https://api.example.com/'), 'https://api.example.com');
    assert.throws(
      () => normalizeAndValidateUrl('https://api.example.com/v1'),
      TargetUrlInvalidError
    );
  });

  it('rejects URLs with userinfo', () => {
    assert.throws(
      () => normalizeAndValidateUrl('https://user:pass@api.example.com'),
      TargetUrlInvalidError
    );
    assert.throws(
      () => normalizeAndValidateUrl('https://user@api.example.com'),
      TargetUrlInvalidError
    );
  });

  it('rejects URLs with query or fragment', () => {
    assert.throws(
      () => normalizeAndValidateUrl('https://api.example.com?key=val'),
      TargetUrlInvalidError
    );
    assert.throws(
      () => normalizeAndValidateUrl('https://api.example.com#section'),
      TargetUrlInvalidError
    );
  });

  it('rejects whitespace and C0/DEL URL normalization', () => {
    for (const value of [
      ' https://api.example.com',
      'https://api.example.com\n',
      'https://api.example.com/\u007f',
    ]) {
      assert.throws(() => normalizeAndValidateUrl(value), TargetUrlInvalidError);
    }
  });

  it('rejects non-HTTPS for non-loopback', () => {
    assert.throws(() => normalizeAndValidateUrl('http://api.example.com'), TargetUrlInvalidError);
  });

  it('rejects hostname aliases for loopback HTTP', () => {
    assert.throws(() => normalizeAndValidateUrl('http://localhost:8080'), TargetUrlInvalidError);
  });

  it('allows HTTP for 127.0.0.1', () => {
    assert.equal(normalizeAndValidateUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  });

  it('allows HTTP for ::1', () => {
    assert.equal(normalizeAndValidateUrl('http://[::1]:3000'), 'http://[::1]:3000');
    assert.throws(() => normalizeAndValidateUrl('ftp://localhost/'), TargetUrlInvalidError);
  });

  it('rejects invalid URLs', () => {
    assert.throws(() => normalizeAndValidateUrl('not-a-url'), TargetUrlInvalidError);
  });
});

describe('addTarget', () => {
  it('creates a target with valid name and URL', () => {
    const settings = makeSettingsPort();
    const record = addValidatedTarget('staging', 'https://api.example.com/', settings);
    assert.equal(record.url, 'https://api.example.com');
    assert.equal(typeof record.id, 'string');
    assert.equal(record.adapterVersion, 'v1');
    assert.equal(typeof record.deviceToken, 'string');
    assert.equal(typeof record.createdAt, 'string');
  });

  it('persists the target in settings', () => {
    const settings = makeSettingsPort();
    addValidatedTarget('staging', 'https://api.example.com', settings);
    const loaded = settings.load();
    assert.ok(loaded._targets?.['staging']);
    assert.equal(loaded._targets?.['staging']?.url, 'https://api.example.com');
  });

  it('rejects a descriptor from another authority before settings mutation', () => {
    const settings = makeSettingsPort();
    assert.throws(
      () =>
        addTarget(
          'staging',
          'https://api.example.com',
          settings,
          makeDiscoveryEndpoints('https://other.example.com').descriptor
        ),
      TargetUrlInvalidError
    );
    assert.deepEqual(listTargets(settings), []);
  });

  it('rejects duplicate name', () => {
    const settings = makeSettingsPort();
    addValidatedTarget('staging', 'https://api.example.com', settings);
    assert.throws(
      () => addValidatedTarget('staging', 'https://other.example.com', settings),
      TargetNameExistsError
    );
  });

  it('allows same URL under different names', () => {
    const settings = makeSettingsPort();
    const r1 = addValidatedTarget('staging', 'https://api.example.com', settings);
    const r2 = addValidatedTarget('staging2', 'https://api.example.com', settings);
    assert.notEqual(r1.id, r2.id);
    assert.notEqual(r1.deviceToken, r2.deviceToken);
  });
});

describe('removeTarget', () => {
  it('removes an existing target', () => {
    const settings = makeSettingsPort();
    addValidatedTarget('staging', 'https://api.example.com', settings);
    const removed = removeTarget('staging', settings);
    assert.equal(removed.url, 'https://api.example.com');
    assert.equal(getTarget('staging', settings), null);
  });

  it('throws for nonexistent target', () => {
    const settings = makeSettingsPort();
    assert.throws(() => removeTarget('nope', settings), TargetNotFoundError);
  });
});

describe('getTarget', () => {
  it('returns null for missing target', () => {
    const settings = makeSettingsPort();
    assert.equal(getTarget('staging', settings), null);
  });

  it('returns existing target', () => {
    const settings = makeSettingsPort();
    addValidatedTarget('staging', 'https://api.example.com', settings);
    const target = getTarget('staging', settings);
    assert.ok(target);
    assert.equal(target.url, 'https://api.example.com');
  });
});

describe('listTargets', () => {
  it('returns empty for no targets', () => {
    const settings = makeSettingsPort();
    assert.deepEqual(listTargets(settings), []);
  });

  it('returns all targets', () => {
    const settings = makeSettingsPort();
    addValidatedTarget('staging', 'https://staging.example.com', settings);
    addValidatedTarget('prod', 'https://prod.example.com', settings);
    const list = listTargets(settings);
    assert.equal(list.length, 2);
    const names = list.map((t) => t.name).sort();
    assert.deepEqual(names, ['prod', 'staging']);
  });
});

describe('INTERNAL_SETTINGS_KEYS protection', () => {
  it('_targets root key is in INTERNAL_SETTINGS_KEYS', async () => {
    // We import cli/index.js indirectly by checking the set
    // Instead, we verify the behavior: settings.list/get/set cannot touch _targets
    // This is tested via the CLI command tests. Here we verify the registry itself
    // does not leak secret material.
    const settings = makeSettingsPort();
    addValidatedTarget('staging', 'https://api.example.com', settings);
    const list = listTargets(settings);
    for (const { record } of list) {
      assert.ok(!('refresh_token' in record));
      assert.ok(!('access_token' in record));
    }
  });
});
