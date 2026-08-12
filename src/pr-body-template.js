const MAX_PR_BODY_LENGTH = 65536;

function normalizeIssueNumber(value) {
  const candidate = typeof value === 'number' ? String(value) : value;
  if (typeof candidate !== 'string') return 'unknown';
  const trimmed = candidate.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) ? trimmed : 'unknown';
}

function normalizeIssueTitle(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'Implementation';
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
  return normalized || 'Implementation';
}

function resolveIssueContext(options = {}) {
  const issueNumber = normalizeIssueNumber(options.issueNumber);
  const issueTitle = normalizeIssueTitle(options.issueTitle);
  const issueReference =
    options.includeIssueReference === false || issueNumber === 'unknown'
      ? ''
      : `Closes #${issueNumber}`;
  return { issueNumber, issueTitle, issueReference };
}

function normalizePrBodyTemplate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError('PR body template must be a string');
  if (value.includes('\0')) throw new TypeError('PR body template must not contain NUL bytes');
  if (value.length > MAX_PR_BODY_LENGTH) {
    throw new TypeError(`PR body template must not exceed ${MAX_PR_BODY_LENGTH} characters`);
  }
  return value;
}

/**
 * Render a bounded PR body. Missing issue metadata expands to empty text so
 * manual tasks never leak internal sentinel values into pull requests.
 */
function renderPullRequestBody(template, options = {}) {
  const issueContext = resolveIssueContext(options);
  const normalizedTemplate = normalizePrBodyTemplate(template);
  if (normalizedTemplate === null) return issueContext.issueReference;

  const hasIssue = issueContext.issueNumber !== 'unknown';
  const substitutions = {
    '{{issue_number}}': hasIssue ? issueContext.issueNumber : '',
    '{{issue_title}}': hasIssue ? issueContext.issueTitle : '',
    '{{issue_reference}}': hasIssue ? issueContext.issueReference : '',
  };
  let rendered = normalizedTemplate;
  for (const [token, replacement] of Object.entries(substitutions)) {
    rendered = rendered.replaceAll(token, replacement);
  }
  if (rendered.length > MAX_PR_BODY_LENGTH) {
    throw new TypeError(`Rendered PR body must not exceed ${MAX_PR_BODY_LENGTH} characters`);
  }
  return rendered;
}

module.exports = {
  MAX_PR_BODY_LENGTH,
  renderPullRequestBody,
  resolveIssueContext,
};
