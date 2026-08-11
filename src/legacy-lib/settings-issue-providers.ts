interface IssueProviderFacade {
  getIssueProviderSettingsDefaults(): Record<string, unknown>;
  listProviders(): readonly string[];
  validateIssueProviderSetting(key: string, value: unknown): string | null | undefined;
}

let issueProviderFns: IssueProviderFacade | null = null;

function getIssueProviderFns(): IssueProviderFacade {
  if (issueProviderFns) return issueProviderFns;
  // Lazy load preserves the issue-providers -> settings -> issue-providers boundary.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const loaded: IssueProviderFacade = require('../src/issue-providers');
  issueProviderFns = loaded;
  return loaded;
}

export = { getIssueProviderFns };
