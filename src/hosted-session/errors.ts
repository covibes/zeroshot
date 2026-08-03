export class HostedAuthenticationError extends Error {
  constructor() {
    super('Hosted target authentication failed');
    this.name = 'HostedAuthenticationError';
  }
}

export class HostedAuthorizationError extends Error {
  constructor() {
    super('Hosted target authorization was revoked');
    this.name = 'HostedAuthorizationError';
  }
}

export class HostedTransportUncertainError extends Error {
  readonly executionRetryAuthorized = false;
  constructor() {
    super('Hosted session transport closed with uncertain execution state');
    this.name = 'HostedTransportUncertainError';
  }
}
