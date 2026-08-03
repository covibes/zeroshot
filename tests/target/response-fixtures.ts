interface ResponseQueue {
  enqueue(status: number, body: unknown, headers?: Record<string, string>): void;
}

export function tokenResponse(
  overrides: Partial<Record<
    'access_token' | 'refresh_token' | 'token_type' | 'scope',
    string
  > & Record<'expires_in' | 'refresh_expires_in', number>> = {},
) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_expires_in: 5_184_000,
    scope: 'session capsule',
    ...overrides,
  };
}

export function enqueueToken(
  http: ResponseQueue,
  overrides: Parameters<typeof tokenResponse>[0] = {},
): void {
  http.enqueue(200, tokenResponse(overrides));
}

export function oversizedJsonResponse(maxBytes: number): {
  readonly response: Response;
  readonly wasCancelled: () => boolean;
} {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(maxBytes));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 });
  return { response, wasCancelled: () => cancelled };
}
