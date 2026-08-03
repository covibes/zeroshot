export class TargetDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetDiscoveryError';
  }
}
