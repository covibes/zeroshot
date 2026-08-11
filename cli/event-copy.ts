const EVENT_COPY = {
  IMPLEMENTATION_READY: 'Implementation ready',
  PR_CREATED: 'Pull request created',
} as const;

function formatMergeStatus(merged: unknown): string | null {
  if (merged === true || merged === 'true') return 'merged';
  if (merged === false || merged === 'false') return 'auto-merge pending approval';
  return null;
}

export = { EVENT_COPY, formatMergeStatus };
