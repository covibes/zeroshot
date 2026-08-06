'use strict';

const fs = require('node:fs/promises');
const { TargetSessionManager } = require('../../../lib/target/target-session.js');
const { acquireTargetLock } = require('../../../lib/target/credential-lock.js');

const [directory, targetId, audience] = process.argv.slice(2);
const refreshPath = `${directory}/refresh-token`;
const tracePath = `${directory}/exchanges`;
const store = {
  async get() {
    try {
      return await fs.readFile(refreshPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
  async set(_service, _account, value) {
    await fs.writeFile(refreshPath, value, { mode: 0o600 });
  },
  async delete() {
    await fs.rm(refreshPath, { force: true });
  },
};
const descriptor = {
  origin: 'https://hosted.example',
  session: { method: 'GET' },
};
const manager = new TargetSessionManager({
  targetName: 'race',
  target: {
    id: targetId,
    url: 'https://hosted.example',
    adapterVersion: 'v1',
    deviceToken: 'device-race',
    createdAt: '2026-08-03T00:00:00Z',
  },
  credentialStore: store,
  acquireLock: () => acquireTargetLock(targetId),
  settings: { load: () => ({}), mutate: () => undefined },
  deps: {
    http: {
      async fetch(_url, init) {
        const body = new globalThis.URLSearchParams(init.body);
        const prior = body.get('refresh_token');
        const requested = body.get('audience');
        if (!prior || requested !== audience) throw new Error('invalid refresh request');
        await fs.appendFile(tracePath, `${audience}:${prior}\n`);
        return new globalThis.Response(
          JSON.stringify({
            access_token: `access-${audience}`,
            refresh_token: `${prior}->${audience}`,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_expires_in: 5_184_000,
            scope: 'session capsule',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    },
    clock: { now: () => Date.now() },
    browserOpener: { open: () => Promise.resolve() },
    stderr: { write: () => undefined },
    discoveryEndpoints: {
      deviceAuthorizationEndpoint: 'https://hosted.example/device',
      tokenEndpoint: 'https://hosted.example/token',
      revocationEndpoint: 'https://hosted.example/revoke',
      clientId: 'cli',
      deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
      audience: 'capsule',
      sessionEndpoint: 'https://hosted.example/target-session',
      descriptor,
    },
  },
});

manager.getAccessToken(audience).then(
  (token) => process.stdout.write(token),
  (error) => {
    process.stderr.write(error.stack || String(error));
    process.exitCode = 1;
  }
);
