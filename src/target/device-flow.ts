import { readBoundedResponseJson } from './bounded-response.js';
import { parseTokenResponse, type TokenResponse } from './token-response.js';
export { parseTokenResponse, type TokenResponse } from './token-response.js';
export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
}


export interface DeviceExchangeContext {
  readonly grantType: string;
  readonly deviceToken: string;
  readonly deviceLabel: string;
  readonly audience: string;
}

export interface DeviceIdentity {
  readonly token: string;
  readonly label: string;
}

function exchangeFields(
  exchange: DeviceExchangeContext | DeviceIdentity | undefined,
): Readonly<Record<string, string>> {
  if (exchange === undefined) return {};
  if ('grantType' in exchange) {
    return {
      grant_type: exchange.grantType,
      device_token: exchange.deviceToken,
      device_label: exchange.deviceLabel,
      audience: exchange.audience,
    };
  }
  return {
    device_token: exchange.token,
    device_label: exchange.label,
    audience: 'admin',
  };
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
const MAX_DEVICE_CODE_BYTES = 16 * 1024;
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = Object.freeze({
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
});
const MAX_URI_BYTES = 4 * 1024;
export function oauthFormRequest(
  body: URLSearchParams,
  signal?: AbortSignal,
): RequestInit & { redirect: 'error' } {
  const init: RequestInit & { redirect: 'error' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
  };
  if (signal !== undefined) init.signal = signal;
  return init;
}

async function requireResponseRoute(response: Response, expectedUrl: string): Promise<void> {
  if (!response.url || new URL(response.url).href === expectedUrl) return;
  await response.body?.cancel().catch(() => undefined);
  throw new Error('OAuth response changed target route or authority');
}


async function readBoundedJson(response: Response): Promise<unknown> {
  return readBoundedResponseJson(response, MAX_OAUTH_RESPONSE_BYTES, (kind) =>
    new Error(kind === 'size' ? 'OAuth response exceeds the size limit' : 'OAuth response is malformed'),
  );
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function safeVerificationAuthority(url: URL, allowQuery: boolean): boolean {
  const literalLoopback = LOOPBACK_HOSTS[url.hostname] === true;
  return !url.username && !url.password && !url.hash &&
    (allowQuery || !url.search) &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && literalLoopback));
}

function verificationUrl(value: unknown, allowQuery: boolean): value is string {
  if (
    !boundedString(value, MAX_URI_BYTES) ||
    /[\u0000-\u0020\u007f]|\s/u.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.href === value && safeVerificationAuthority(url, allowQuery);
  } catch {
    return false;
  }
}
function deviceFieldsValid(device: Record<string, unknown>): boolean {
  const fields = Object.keys(device);
  const required = ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval'];
  return fields.every((field) =>
    required.includes(field) || field === 'verification_uri_complete',
  ) && required.every((field) => field in device);
}

function deviceStringsValid(device: Record<string, unknown>): boolean {
  return boundedString(device.device_code, MAX_DEVICE_CODE_BYTES) &&
    boundedString(device.user_code, 256) &&
    verificationUrl(device.verification_uri, false) &&
    (device.verification_uri_complete === undefined ||
      verificationUrl(device.verification_uri_complete, true));
}

function deviceTimingValid(device: Record<string, unknown>): boolean {
  return Number.isSafeInteger(device.expires_in) &&
    (device.expires_in as number) >= 1 &&
    (device.expires_in as number) <= 86_400 &&
    Number.isSafeInteger(device.interval) &&
    (device.interval as number) >= 0 &&
    (device.interval as number) <= 300;
}

function browserAuthorityMatches(device: Record<string, unknown>): boolean {
  return device.verification_uri_complete === undefined ||
    new URL(device.verification_uri_complete as string).origin ===
      new URL(device.verification_uri as string).origin;
}


function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  const device = object(value, 'Device code');
  if (!deviceFieldsValid(device) || !deviceStringsValid(device) ||
      !deviceTimingValid(device) || !browserAuthorityMatches(device)) {
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

  const response = await http.fetch(
    deviceAuthorizationEndpoint,
    oauthFormRequest(body, signal),
  );
  await requireResponseRoute(response, deviceAuthorizationEndpoint);

  if (!response.ok) {
    parseOAuthError(await readBoundedJson(response));
    throw new Error(`Device code request failed (${response.status})`);
  }

  return parseDeviceCodeResponse(await readBoundedJson(response));
}

export interface PollForTokenRequest {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly deviceCode: string;
  readonly interval: number;
  readonly expiresIn: number;
  readonly http: HttpTransport;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  readonly exchange?: DeviceExchangeContext | DeviceIdentity;
}
type PollResult = TokenResponse | 'authorization_pending' | 'slow_down';

async function parsePollResponse(response: Response): Promise<PollResult> {
  if (response.ok) return parseTokenResponse(await readBoundedJson(response));
  const error = parseOAuthError(await readBoundedJson(response));
  if (error === 'authorization_pending' || error === 'slow_down') return error;
  if (error === 'access_denied') throw new DeviceFlowDeniedError();
  if (error === 'expired_token') throw new DeviceFlowExpiredError();
  throw new Error('Token endpoint returned an unsupported OAuth error');
}

function pollBody(request: PollForTokenRequest): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: request.deviceCode,
    client_id: request.clientId,
    ...exchangeFields(request.exchange),
  });
}

export async function pollForToken(request: PollForTokenRequest): Promise<TokenResponse> {
  const clock = request.clock ?? DEFAULT_CLOCK;
  const deadline = clock.now() + request.expiresIn * 1000;
  let currentInterval = request.interval;

  while (clock.now() < deadline) {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    await sleep(currentInterval * 1000, request.signal);
    const response = await request.http.fetch(
      request.tokenEndpoint,
      oauthFormRequest(pollBody(request), request.signal),
    );
    const result = await parsePollResponse(response);
    if (result === 'authorization_pending') continue;
    if (result === 'slow_down') {
      currentInterval += 5;
      continue;
    }
    return result;
  }
  throw new DeviceFlowExpiredError();
}
