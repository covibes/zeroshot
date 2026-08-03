export class LoginRequiredError extends Error {
  readonly targetName: string;

  constructor(targetName: string) {
    super(`Login required. Run: zeroshot target login ${targetName}`);
    this.name = 'LoginRequiredError';
    this.targetName = targetName;
  }
}
