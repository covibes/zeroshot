'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { loadRefreshToken, storeRefreshToken } = require('./credential-store');
const { HostedHttpError, request } = require('./http');

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tryOpenBrowser(url) {
  let command = 'xdg-open';
  if (process.platform === 'darwin') command = 'open';
  if (process.platform === 'win32') command = 'cmd';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The printed URL is the portable fallback.
  }
}

function tokenEnvelope(value) {
  if (
    value?.token_type !== 'Bearer' ||
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    typeof value.refresh_token !== 'string' ||
    !value.refresh_token
  ) {
    throw new Error('Zero Cloud returned an invalid token envelope');
  }
  return value;
}

function validateDeviceGrant(grant) {
  if (
    typeof grant?.device_code !== 'string' ||
    typeof grant?.verification_uri_complete !== 'string' ||
    !Number.isSafeInteger(grant.interval) ||
    grant.interval < 1
  ) {
    throw new Error('Zero Cloud returned an invalid device authorization');
  }
  return grant;
}

function devicePollDisposition(error) {
  if (!(error instanceof HostedHttpError)) throw error;
  if (error.code === 'authorization_pending') return 'pending';
  if (error.code === 'slow_down') return 'slow_down';
  if (error.code === 'expired_token') return 'expired';
  if (error.code === 'access_denied') throw new Error('device authorization was denied');
  throw error;
}

async function pollDeviceAuthorization(target, grant, deviceToken) {
  const deadline = Date.now() + (Number(grant.expires_in) || 600) * 1_000;
  let intervalSeconds = grant.interval;
  while (Date.now() < deadline) {
    await wait(intervalSeconds * 1_000);
    try {
      return tokenEnvelope(
        (
          await request(target.endpoint, '/auth/token', {
            method: 'POST',
            form: {
              grant_type: DEVICE_GRANT,
              client_id: 'cli',
              device_code: grant.device_code,
              audience: 'admin',
              device_token: deviceToken,
              device_label: 'Zeroshot CLI',
            },
          })
        ).body
      );
    } catch (error) {
      const disposition = devicePollDisposition(error);
      if (disposition === 'slow_down') {
        intervalSeconds += 5;
      }
      if (disposition === 'expired') break;
    }
  }
  throw new Error('device authorization expired before it was approved');
}

async function login(targetName, target) {
  const grant = validateDeviceGrant(
    (
      await request(target.endpoint, '/auth/device/code', {
        method: 'POST',
        form: { client_id: 'cli' },
      })
    ).body
  );
  console.log(`Authorize this CLI in your browser:\n${grant.verification_uri_complete}`);
  tryOpenBrowser(grant.verification_uri_complete);
  const deviceToken = crypto.randomBytes(32).toString('hex');
  const tokens = await pollDeviceAuthorization(target, grant, deviceToken);
  storeRefreshToken(targetName, tokens.refresh_token);
}

async function exchangeCapsule(targetName, target, source) {
  const tokens = tokenEnvelope(
    (
      await request(target.endpoint, '/auth/token', {
        method: 'POST',
        form: {
          grant_type: 'refresh_token',
          client_id: 'cli',
          refresh_token: source.token,
          audience: 'capsule',
        },
      })
    ).body
  );
  if (source.persistent) storeRefreshToken(targetName, tokens.refresh_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    persistent: source.persistent,
  };
}

function capsuleSession(targetName, target, environment = process.env) {
  return exchangeCapsule(targetName, target, loadRefreshToken(targetName, environment));
}

function rotateCapsuleSession(targetName, target, session) {
  return exchangeCapsule(targetName, target, {
    token: session.refreshToken,
    persistent: session.persistent,
  });
}

module.exports = { capsuleSession, login, rotateCapsuleSession, tokenEnvelope };
