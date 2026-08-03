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
  readonly token_type: string;
  readonly expires_in: number;
  readonly organization?: { readonly id: string; readonly name: string };
}

export interface HttpTransport {
  fetch(url: string, init: RequestInit & { redirect: 'error' }): Promise<Response>;
}

export interface Clock {
  now(): number;
}

export interface DeviceIdentity {
  readonly token: string;
  readonly label: string;
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
  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'openid',
  });

  const init: RequestInit & { redirect: 'error' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
  };
  if (signal) init.signal = signal;

  const response = await http.fetch(deviceAuthorizationEndpoint, init);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device code request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as DeviceCodeResponse;
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
  deviceIdentity?: DeviceIdentity
): Promise<TokenResponse> {
  const deadline = clock.now() + expiresIn * 1000;
  let currentInterval = interval;

  while (clock.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    await sleep(currentInterval * 1000, signal);

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    });
    if (deviceIdentity) {
      body.set('audience', 'admin');
      body.set('device_token', deviceIdentity.token);
      body.set('device_label', deviceIdentity.label);
    }

    const init: RequestInit & { redirect: 'error' } = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
    };
    if (signal) init.signal = signal;

    const response = await http.fetch(tokenEndpoint, init);

    if (response.ok) {
      return (await response.json()) as TokenResponse;
    }

    const errorBody = (await response.json()) as { error: string };
    switch (errorBody.error) {
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
        throw new Error(`Token endpoint error: ${errorBody.error}`);
    }
  }

  throw new DeviceFlowExpiredError();
}
