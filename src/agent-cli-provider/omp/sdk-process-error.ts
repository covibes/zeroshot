export class OmpSdkProcessRunnerError extends Error {
  readonly code: 'cleanup-error' | 'containment-error' | 'credential-error' | 'protocol-error';

  constructor(code: OmpSdkProcessRunnerError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OmpSdkProcessRunnerError';
    this.code = code;
  }
}
