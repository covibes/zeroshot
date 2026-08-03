export function waitForSocketRequest<R>(
  socket: { request(method: string): R | undefined },
  method: string,
): Promise<R>;
