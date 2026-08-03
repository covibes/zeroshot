import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve('tests/fixtures/zero-cloud-44');
const HTTP = join(ROOT, 'contracts/http');
const META = join(HTTP, 'hosted-target/META.json');
const PINNED = 'sha256:6636d50cd60067241a50d1ee027d86fc1738aa933f086d8bb2c496c5be31b85e';

interface ContractMeta {
  readonly digest: string;
  readonly promoted_schemas: readonly string[];
}

function artifactPaths(meta: ContractMeta): string[] {
  const schemas = meta.promoted_schemas.map((path) => resolve(ROOT, path));
  const fixtures = ['valid', 'invalid'].flatMap((kind) =>
    readdirSync(join(HTTP, 'hosted-target/fixtures', kind))
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(HTTP, 'hosted-target/fixtures', kind, name))
  );
  return [...schemas, ...fixtures].sort((left, right) =>
    relative(ROOT, left).localeCompare(relative(ROOT, right))
  );
}

function digest(paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of paths) {
    const name = relative(ROOT, path);
    const bytes = readFileSync(path);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

describe('immutable Zero Cloud #55 e8e746d contract corpus', () => {
  it('contains the exact promoted schemas and 54 fixtures at the pinned digest', () => {
    const meta = JSON.parse(readFileSync(META, 'utf8')) as ContractMeta;
    const paths = artifactPaths(meta);
    assert.equal(meta.promoted_schemas.length, 10);
    assert.equal(paths.length, 64);
    assert.equal(meta.digest, PINNED);
    assert.equal(digest(paths), PINNED);
  });

  it('executes every fixture against its promoted schema classification', () => {
    const meta = JSON.parse(readFileSync(META, 'utf8')) as ContractMeta;
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validators = new Map(
      meta.promoted_schemas.map((schemaPath) => {
        const name = basename(schemaPath, '.schema.json');
        const schema = JSON.parse(readFileSync(resolve(ROOT, schemaPath), 'utf8'));
        return [name, ajv.compile(schema)] as const;
      })
    );
    const fixtures = ['valid', 'invalid'].flatMap((kind) => {
      const directory = join(HTTP, 'hosted-target/fixtures', kind);
      return readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({
          name,
          value: JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
            readonly schema: string;
            readonly body: unknown;
            readonly expect_schema_valid: boolean;
          },
        }));
    });

    assert.equal(fixtures.length, 54);
    for (const fixture of fixtures) {
      const validate = validators.get(fixture.value.schema);
      assert.ok(validate, `${fixture.name}: unknown schema ${fixture.value.schema}`);
      assert.equal(
        validate(fixture.value.body),
        fixture.value.expect_schema_valid,
        `${fixture.name}: ${ajv.errorsText(validate.errors)}`
      );
    }
  });
});
