export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
}

export interface DeviceExchangeContext {
  readonly grantType: string;
  readonly deviceToken: string;
  readonly deviceLabel: string;
  readonly audience: string;
}

export interface HttpTransport {
  fetch(url: string, init: RequestInit & { redirect: 'error' }): Promise<Response>;
}

export interface Clock {
  now(): number;
}

export class DeviceFlowDeniedError extends Error {
  constructor() {
    super('Device authorization denied by user');
    this.name = 'DeviceFlowDeniedError';
  }
}

export class DeviceFlowExpiredError extends Error {
  constructor() {
    super('Device authorization code expired');
    this.name = 'DeviceFlowExpiredError';
  }
}

export class UnboundSessionError extends Error {
  readonly verificationUri: string;
  constructor(verificationUri: string) {
    super(
      `Session not bound to an organization. Re-approve at ${verificationUri} and select an organization.`
    );
    this.name = 'UnboundSessionError';
    this.verificationUri = verificationUri;
  }
}

const DEFAULT_CLOCK: Clock = { now: () => Date.now() };
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_URI_BYTES = 4 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_OAUTH_RESPONSE_BYTES)
  ) {
    throw new Error('OAuth response exceeds the size limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OAUTH_RESPONSE_BYTES)
    throw new Error('OAuth response exceeds the size limit');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('OAuth response is malformed');
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function verificationUrl(value: unknown): value is string {
  if (!boundedString(value, MAX_URI_BYTES)) return false;
  try {
    const url = new URL(value);
    const literalLoopback =
      url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && literalLoopback))
    );
  } catch {
    return false;
  }
}

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  const device = object(value, 'Device code');
  const fields = Object.keys(device);
  const required = ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval'];
  if (
    fields.some((field) => !required.includes(field) && field !== 'verification_uri_complete') ||
    required.some((field) => !(field in device)) ||
    !boundedString(device.device_code, MAX_TOKEN_BYTES) ||
    !boundedString(device.user_code, 256) ||
    !verificationUrl(device.verification_uri) ||
    (device.verification_uri_complete !== undefined &&
      !verificationUrl(device.verification_uri_complete)) ||
    !Number.isSafeInteger(device.expires_in) ||
    (device.expires_in as number) < 1 ||
    (device.expires_in as number) > 86_400 ||
    !Number.isSafeInteger(device.interval) ||
    (device.interval as number) < 0 ||
    (device.interval as number) > 300
  ) {
    throw new Error('Device code response is malformed');
  }
  return Object.freeze(device) as unknown as DeviceCodeResponse;
}

function parseOAuthError(value: unknown): string {
  const error = object(value, 'OAuth error');
  if (Object.keys(error).length !== 1 || typeof error.error !== 'string') {
    throw new Error('OAuth error response is malformed');
  }
  return error.error;
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} response is malformed`);
  }
  return value as Record<string, unknown>;
}

export function parseTokenResponse(value: unknown): TokenResponse {
  const token = object(value, 'Token');
  const allowed = new Set(['access_token', 'refresh_token', 'token_type', 'expires_in']);
  if (Object.keys(token).some((key) => !allowed.has(key)))
    throw new Error('Token response is malformed');
  if (
    !boundedString(token.access_token, MAX_TOKEN_BYTES) ||
    !boundedString(token.refresh_token, MAX_TOKEN_BYTES) ||
    token.token_type !== 'Bearer' ||
    !Number.isSafeInteger(token.expires_in) ||
    (token.expires_in as number) <= 0 ||
    (token.expires_in as number) > 86_400
  ) {
    throw new Error('Token response is malformed');
  }
  return token as unknown as TokenResponse;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

export async function requestDeviceCode(
  deviceAuthorizationEndpoint: string,
  clientId: string,
  http: HttpTransport,
  signal?: AbortSignal
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: clientId });

  const init: RequestInit & { redirect: 'error' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
  };
  if (signal) init.signal = signal;

  const response = await http.fetch(deviceAuthorizationEndpoint, init);

  if (!response.ok) {
    parseOAuthError(await readBoundedJson(response));
    throw new Error(`Device code request failed (${response.status})`);
  }

  return parseDeviceCodeResponse(await readBoundedJson(response));
}

export async function pollForToken(
  tokenEndpoint: string,
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  http: HttpTransport,
  clock: Clock = DEFAULT_CLOCK,
  signal?: AbortSignal,
  exchange?: DeviceExchangeContext
): Promise<TokenResponse> {
  const deadline = clock.now() + expiresIn * 1000;
  let currentInterval = interval;

  while (clock.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    await sleep(currentInterval * 1000, signal);

    const body = new URLSearchParams({
      grant_type: exchange?.grantType ?? 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
      ...(exchange === undefined
        ? {}
        : {
            device_token: exchange.deviceToken,
            device_label: exchange.deviceLabel,
            audience: exchange.audience,
          }),
    });

    const init: RequestInit & { redirect: 'error' } = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
    };
    if (signal) init.signal = signal;

    const response = await http.fetch(tokenEndpoint, init);

    if (response.ok) {
      return parseTokenResponse(await readBoundedJson(response));
    }

    const error = parseOAuthError(await readBoundedJson(response));
    switch (error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        currentInterval += 5;
        continue;
      case 'access_denied':
        throw new DeviceFlowDeniedError();
      case 'expired_token':
        throw new DeviceFlowExpiredError();
      default:
        throw new Error('Token endpoint returned an unsupported OAuth error');
    }
  }

  throw new DeviceFlowExpiredError();
}
