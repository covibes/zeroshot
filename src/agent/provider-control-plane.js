// @ts-nocheck

function parseProviderEvent(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function providerFailureFields(failure) {
  return {
    error: { message: failure.error },
    zeroshot_failure: {
      provider: failure.provider,
      event: failure.event,
      category: failure.category,
      kind: failure.classification.kind,
      retryable: failure.classification.retryable,
      diagnostic: failure.diagnostic,
    },
  };
}

module.exports = { parseProviderEvent, providerFailureFields };
