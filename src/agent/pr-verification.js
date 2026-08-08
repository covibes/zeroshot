/**
 * PR/MR Verification - Provider-agnostic verification for git-pusher hook
 */

const { spawnSync } = require('child_process');
const { getDefaultProviderId } = require('../../lib/provider-names');

const DEFAULT_VERIFICATION_PLATFORM = 'github';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePrNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseJson(raw, commandName) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${commandName} returned non-JSON output: ${err.message}`);
  }
}

const VERIFICATION_ADAPTERS = {
  github: {
    platform: 'github',
    displayName: 'GitHub',
    itemName: 'PR',
    claimUrlFields: ['pr_url', 'url'],
    claimNumberFields: ['pr_number', 'number', 'pull_request_id', 'pullRequestId'],
    rawNumberFieldNames: ['pr_number', 'number', 'pull_request_id', 'pullRequestId'],
    urlPatterns: [
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)/g,
      /https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/(\d+)/g,
    ],
    buildViewCommand(prNumber) {
      return {
        command: 'gh',
        args: [
          'pr',
          'view',
          ...(prNumber ? [String(prNumber)] : []),
          '--json',
          'state,mergedAt,url,number,autoMergeRequest,mergeStateStatus',
        ],
      };
    },
    parseViewOutput(raw) {
      const data = parseJson(raw, 'gh pr view');
      return {
        number: normalizePrNumber(data.number),
        state: String(data.state || '').toUpperCase(),
        mergedAt: data.mergedAt || null,
        url: data.url || null,
        autoMergeRequest: data.autoMergeRequest || null,
        mergeStateStatus: data.mergeStateStatus || null,
      };
    },
    isNotFoundError(err) {
      const text = String(err?.stderr || err?.message || '').toLowerCase();
      return (
        text.includes('could not resolve to a pullrequest') ||
        text.includes('no pull requests found')
      );
    },
    isOpenState(state) {
      return String(state || '').toUpperCase() === 'OPEN';
    },
    isMerged(prData) {
      const state = String(prData?.state || '').toUpperCase();
      return Boolean(prData?.mergedAt) || state === 'MERGED';
    },
    strictUrlMatch: true,
    skipEnvVars: ['ZEROSHOT_SKIP_PR_VERIFY', 'ZEROSHOT_SKIP_GH_VERIFY'],
  },
  gitlab: {
    platform: 'gitlab',
    displayName: 'GitLab',
    itemName: 'MR',
    claimUrlFields: ['mr_url', 'pr_url', 'url'],
    claimNumberFields: ['mr_number', 'pr_number', 'iid', 'number', 'id'],
    rawNumberFieldNames: ['mr_number', 'pr_number', 'iid', 'number', 'id'],
    urlPatterns: [
      /https?:\/\/[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/-\/merge_requests\/(\d+)/g,
    ],
    buildViewCommand(prNumber) {
      return {
        command: 'glab',
        args: ['mr', 'view', ...(prNumber ? [String(prNumber)] : []), '--output', 'json'],
      };
    },
    parseViewOutput(raw) {
      const data = parseJson(raw, 'glab mr view');
      const state = String(data.state || '').toUpperCase();
      const mergedAt =
        data.merged_at || data.mergedAt || (state === 'MERGED' ? '__MERGED__' : null);
      return {
        number: normalizePrNumber(data.iid || data.number || data.id),
        state,
        mergedAt,
        url: data.web_url || data.url || null,
      };
    },
    isNotFoundError(err) {
      const text = String(err?.stderr || err?.message || '').toLowerCase();
      return (
        text.includes('merge request') &&
        (text.includes('not found') || text.includes('no merge requests found'))
      );
    },
    isOpenState(state) {
      const normalized = String(state || '').toUpperCase();
      return normalized === 'OPEN' || normalized === 'OPENED';
    },
    isMerged(prData) {
      const state = String(prData?.state || '').toUpperCase();
      return Boolean(prData?.mergedAt) || state === 'MERGED';
    },
    strictUrlMatch: true,
    skipEnvVars: ['ZEROSHOT_SKIP_PR_VERIFY'],
  },
  'azure-devops': {
    platform: 'azure-devops',
    displayName: 'Azure DevOps',
    itemName: 'PR',
    claimUrlFields: ['pr_url', 'pull_request_url', 'url'],
    claimNumberFields: ['pr_number', 'pull_request_id', 'pullRequestId', 'id', 'number'],
    rawNumberFieldNames: ['pr_number', 'pull_request_id', 'pullRequestId', 'id', 'number'],
    urlPatterns: [
      /https?:\/\/dev\.azure\.com\/[^/\s]+\/[^/\s]+\/_git\/[^/\s]+\/pullrequest\/(\d+)/g,
      /https?:\/\/[^.\s]+\.visualstudio\.com\/[^/\s]+\/_git\/[^/\s]+\/pullrequest\/(\d+)/g,
      /https?:\/\/dev\.azure\.com\/[^/\s]+\/[^/\s]+\/_apis\/git\/repositories\/[^/\s]+\/pullRequests\/(\d+)/g,
    ],
    buildViewCommand(prNumber) {
      if (!prNumber) {
        throw new Error(
          'Verification requires pr_number/pullRequestId for Azure DevOps; no PR number was found in agent output.'
        );
      }
      return {
        command: 'az',
        args: ['repos', 'pr', 'show', '--id', String(prNumber), '--output', 'json'],
      };
    },
    parseViewOutput(raw) {
      const data = parseJson(raw, 'az repos pr show');
      const state = String(data.status || data.state || '').toUpperCase();
      const mergedAt =
        data.closedDate || data.closedAt || (state === 'COMPLETED' ? '__COMPLETED__' : null);
      return {
        number: normalizePrNumber(data.pullRequestId || data.prId || data.number || data.id),
        state,
        mergedAt,
        url: data.pullRequestUrl || data.url || null,
      };
    },
    isNotFoundError(err) {
      const text = String(err?.stderr || err?.message || '').toLowerCase();
      return text.includes('not found') || text.includes('does not exist');
    },
    isOpenState(state) {
      const normalized = String(state || '').toUpperCase();
      return normalized === 'ACTIVE' || normalized === 'OPEN';
    },
    isMerged(prData) {
      const state = String(prData?.state || '').toUpperCase();
      return state === 'COMPLETED' || state === 'MERGED';
    },
    strictUrlMatch: false,
    skipEnvVars: ['ZEROSHOT_SKIP_PR_VERIFY'],
  },
};

function getVerificationAdapter(platform) {
  return VERIFICATION_ADAPTERS[platform] || VERIFICATION_ADAPTERS[DEFAULT_VERIFICATION_PLATFORM];
}

function resolveVerificationPlatform(agent) {
  try {
    const { getPlatformForPR } = require('../issue-providers');
    const detected = getPlatformForPR(agent?.workingDirectory || process.cwd());
    if (VERIFICATION_ADAPTERS[detected]) return detected;
  } catch (err) {
    if (typeof agent?._log === 'function') {
      agent._log(
        `⚠️  Could not detect PR platform (${err.message}). ` +
          `Falling back to ${DEFAULT_VERIFICATION_PLATFORM}.`
      );
    }
  }
  return DEFAULT_VERIFICATION_PLATFORM;
}

function getClaimNumberFieldCandidates(adapter) {
  const defaults = ['pr_number', 'mr_number', 'pull_request_id', 'pullRequestId', 'id', 'number'];
  return Array.from(new Set([...(adapter?.claimNumberFields || []), ...defaults]));
}

function getClaimUrlFieldCandidates(adapter) {
  const defaults = ['pr_url', 'mr_url', 'pull_request_url', 'url'];
  return Array.from(new Set([...(adapter?.claimUrlFields || []), ...defaults]));
}

function getAllUrlPatterns(adapter) {
  const allPatterns = Object.values(VERIFICATION_ADAPTERS).flatMap((cfg) => cfg.urlPatterns || []);
  return adapter?.urlPatterns && adapter.urlPatterns.length > 0
    ? [...adapter.urlPatterns, ...allPatterns]
    : allPatterns;
}

function extractLastMatchNumber(text, fieldNames) {
  const normalizedOutput = text.replace(/\\\//g, '/');
  const allowedFields = new Set(fieldNames.map((field) => String(field).toLowerCase()));

  const keyValueRegex = /"?([A-Za-z_][A-Za-z0-9_]*)"?\s*[:=]\s*"?([0-9]+)"?/g;
  let latestNumber = null;
  let match;
  while ((match = keyValueRegex.exec(normalizedOutput)) !== null) {
    if (allowedFields.has(String(match[1]).toLowerCase())) {
      latestNumber = normalizePrNumber(match[2]);
    }
  }

  return latestNumber;
}

function extractPrInfoFromRawOutput(output, adapter = null) {
  if (!output || typeof output !== 'string') {
    return { prUrl: null, prNumber: null };
  }

  const normalizedOutput = output.replace(/\\\//g, '/');
  const urlPatterns = getAllUrlPatterns(adapter);

  let lastPrUrlMatch = null;
  for (const regex of urlPatterns) {
    regex.lastIndex = 0;
    const matches = [...normalizedOutput.matchAll(regex)];
    if (matches.length > 0) {
      lastPrUrlMatch = matches[matches.length - 1];
    }
  }

  const numberFieldNames = getClaimNumberFieldCandidates(adapter);
  const rawNumber = extractLastMatchNumber(normalizedOutput, [
    ...(adapter?.rawNumberFieldNames || []),
    ...numberFieldNames,
  ]);

  const urlNumber = lastPrUrlMatch ? normalizePrNumber(lastPrUrlMatch[1]) : null;

  return {
    prUrl: lastPrUrlMatch ? lastPrUrlMatch[0] : null,
    prNumber: rawNumber || urlNumber || null,
  };
}

function runViewCommand(adapter, prNumber, cwd) {
  const spec = adapter.buildViewCommand(prNumber);
  const result = spawnSync(spec.command, spec.args, {
    encoding: 'utf8',
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message || result.stderr || 'no stderr';
    const error = new Error(
      `${adapter.displayName} view command failed for ${adapter.itemName} #${prNumber || 'current'}: ${detail}`
    );
    error.status = result.status;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
function normalizeFetchedPrData(prData, adapter) {
  const number = normalizePrNumber(prData?.number);
  if (!number) {
    throw new Error(
      `VERIFICATION FAILED: ${adapter.displayName} verification returned invalid PR/MR number.`
    );
  }

  return {
    number,
    state: String(prData?.state || '').toUpperCase(),
    mergedAt: prData?.mergedAt || null,
    url: prData?.url || null,
    autoMergeRequest: prData?.autoMergeRequest || null,
    mergeStateStatus: prData?.mergeStateStatus || null,
  };
}

async function fetchPrDataWithRetry({ adapter, cwd, prNumber, agent }) {
  const attempts = prNumber
    ? parsePositiveInt(process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_ATTEMPTS, 6)
    : 1;
  const intervalMs = parsePositiveInt(process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_INTERVAL_MS, 5000);
  const itemLabel = adapter.itemName;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = runViewCommand(adapter, prNumber, cwd);
      return normalizeFetchedPrData(adapter.parseViewOutput(raw), adapter);
    } catch (err) {
      const isNotFound =
        typeof adapter.isNotFoundError === 'function' && adapter.isNotFoundError(err);

      if (!isNotFound) throw err;

      if (attempt < attempts) {
        agent._log(
          `⏳ ${itemLabel} #${prNumber} not found yet (attempt ${attempt}/${attempts}). ` +
            `${adapter.displayName} API eventual consistency, retrying in ${intervalMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      throw new Error(
        `VERIFICATION FAILED: Agent claimed ${itemLabel} #${prNumber || '(unknown)'} exists, ` +
          `but ${adapter.displayName} says it DOES NOT EXIST after ${attempts} attempts ` +
          `over ${(attempts * intervalMs) / 1000}s. Agent HALLUCINATED.`
      );
    }
  }
}

function resolveFieldValue(structuredOutput, fieldNames) {
  for (const fieldName of fieldNames) {
    if (structuredOutput[fieldName] !== undefined && structuredOutput[fieldName] !== null) {
      return structuredOutput[fieldName];
    }
  }
  return null;
}

function resolvePrClaimsFromOutput({ output, parsedResult, providerName, adapter }) {
  const { extractJsonFromOutput } = require('./output-extraction');
  const structuredOutput =
    parsedResult && typeof parsedResult === 'object'
      ? parsedResult
      : extractJsonFromOutput(output, providerName) || {};

  const structuredUrl = resolveFieldValue(structuredOutput, getClaimUrlFieldCandidates(adapter));
  const structuredNumber = resolveFieldValue(
    structuredOutput,
    getClaimNumberFieldCandidates(adapter)
  );

  let claimedPrUrl = typeof structuredUrl === 'string' ? structuredUrl : null;
  let claimedPrNumber = normalizePrNumber(structuredNumber);

  const fallbackPrInfo = extractPrInfoFromRawOutput(output, adapter);
  if (!claimedPrUrl && fallbackPrInfo.prUrl) claimedPrUrl = fallbackPrInfo.prUrl;
  if (!claimedPrNumber && fallbackPrInfo.prNumber) claimedPrNumber = fallbackPrInfo.prNumber;

  return {
    structuredOutput,
    claimedPrUrl,
    claimedPrNumber,
    usedFallbackExtraction:
      (fallbackPrInfo.prUrl && !structuredUrl) || (fallbackPrInfo.prNumber && !structuredNumber),
  };
}

function publishClusterComplete(agent, data) {
  agent._publish({ topic: 'CLUSTER_COMPLETE', content: { data } });
}

function publishPushBlocked(agent, data) {
  agent._publish({
    topic: 'PUSH_BLOCKED',
    receiver: 'broadcast',
    content: {
      text: `git-pusher blocked: ${data.blocked_reason}`,
      data,
    },
  });
}

function buildVerificationPayload({ platform, prData, reason }) {
  const payload = {
    reason,
    verification_platform: platform,
    pr_number: prData?.number || null,
    pr_url: prData?.url || null,
  };

  if (platform === 'gitlab') {
    payload.mr_number = prData?.number || null;
    payload.mr_url = prData?.url || null;
  }

  return payload;
}

function isTrue(value) {
  return value === true || value === 'true';
}

function normalizeBlockedReason(value) {
  if (typeof value !== 'string') return 'unspecified pusher block';
  const trimmed = value.trim();
  return trimmed || 'unspecified pusher block';
}

function isStatusOnlyPusherReason(reason) {
  const normalized = String(reason || '').toLowerCase();
  const hasPendingSignal =
    normalized.includes('pending') ||
    normalized.includes('waiting') ||
    normalized.includes('auto-merge') ||
    normalized.includes('automerge') ||
    normalized.includes('auto complete') ||
    normalized.includes('auto-complete') ||
    normalized.includes('merge queue') ||
    normalized.includes('required review') ||
    normalized.includes('review required');
  const hasFailureSignal =
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('conflict') ||
    normalized.includes('rejected') ||
    normalized.includes('hook') ||
    normalized.includes('compile') ||
    normalized.includes('test failed') ||
    normalized.includes('check failed');

  return hasPendingSignal && !hasFailureSignal;
}

function handleBlockedPusherOutcome({ claims, platform, agent, requireMerge }) {
  const structuredOutput = claims.structuredOutput || {};
  if (!isTrue(structuredOutput.blocked)) return false;

  const blockedReason = normalizeBlockedReason(structuredOutput.blocked_reason);
  const payload = buildVerificationPayload({
    platform,
    prData: {
      number: claims.claimedPrNumber,
      url: claims.claimedPrUrl,
    },
    reason: 'git-pusher-blocked',
  });

  if (isStatusOnlyPusherReason(blockedReason) && !requireMerge) {
    agent._log(`⚠️  git-pusher status pending: ${blockedReason}`);
    publishClusterComplete(agent, {
      ...payload,
      reason: 'git-pusher-complete-verification-pending',
      verification_pending: true,
      verification_message: blockedReason,
      pusher_blocked: false,
    });
    return true;
  }

  agent._log(`🔁 git-pusher blocked; routing back to worker repair: ${blockedReason}`);
  publishPushBlocked(agent, {
    ...payload,
    blocked: true,
    blocked_reason: blockedReason,
    pusher_blocked: true,
    timestamp: Date.now(),
  });
  return true;
}

async function pollForMerge({ adapter, prData, agent, cwd }) {
  const pollAttempts = parsePositiveInt(process.env.ZEROSHOT_PR_MERGE_POLL_ATTEMPTS, 12);
  const pollIntervalMs = parsePositiveInt(process.env.ZEROSHOT_PR_MERGE_POLL_INTERVAL_MS, 5000);
  const prNumber = prData.number;
  const itemLabel = adapter.itemName;

  agent._log(
    `⏳ ${itemLabel} #${prNumber} not yet showing as merged (state="${prData.state}"). ` +
      `Polling (up to ${pollAttempts} attempts, ${pollIntervalMs / 1000}s apart)...`
  );

  let latest = prData;
  for (let attempt = 1; attempt <= pollAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      const raw = runViewCommand(adapter, prNumber, cwd);
      latest = normalizeFetchedPrData(adapter.parseViewOutput(raw), adapter);
    } catch {
      continue;
    }

    if (adapter.isMerged(latest)) {
      agent._log(`✅ ${itemLabel} #${prNumber} merge confirmed on poll attempt ${attempt}`);
      return latest;
    }
    agent._log(
      `⏳ Poll ${attempt}/${pollAttempts}: ${itemLabel} #${prNumber} still state="${latest.state}"`
    );
  }

  return latest;
}

function handleUnmergedPr({ adapter, platform, prData, agent }) {
  const pollAttempts = parsePositiveInt(process.env.ZEROSHOT_PR_MERGE_POLL_ATTEMPTS, 12);
  const pollIntervalMs = parsePositiveInt(process.env.ZEROSHOT_PR_MERGE_POLL_INTERVAL_MS, 5000);
  const windowSeconds = (pollAttempts * pollIntervalMs) / 1000;
  const itemLabel = adapter.itemName;

  if (
    adapter.platform === 'github' &&
    prData.autoMergeRequest?.mergeMethod === 'MERGE' &&
    prData.autoMergeRequest?.enabledAt
  ) {
    const reason = `${itemLabel} accepted by authoritative GitHub auto-merge policy.`;
    agent._log(
      `✅ VERIFICATION PASSED: ${reason} ${itemLabel} #${prData.number}, state="${prData.state}"`
    );
    publishClusterComplete(agent, {
      ...buildVerificationPayload({
        platform,
        prData,
        reason: 'git-pusher-complete-auto-merge-accepted',
      }),
      auto_merge_accepted: true,
      verification_state: prData.state,
      verification_polls: pollAttempts,
      verification_window_seconds: windowSeconds,
    });
    return;
  }

  throw new Error(
    `VERIFICATION FAILED: ${itemLabel} #${prData.number} exists but is neither merged nor ` +
      'authoritatively accepted for merge-method auto-merge ' +
      `(state="${prData.state}") after ${pollAttempts} polls over ${windowSeconds}s.`
  );
}

function validatePrClaims({ structuredOutput, claimedPrNumber, claimedPrUrl }) {
  if (claimedPrNumber || claimedPrUrl) return;

  const reason = structuredOutput.summary || structuredOutput.result || 'no details provided';
  const reasonStr =
    typeof reason === 'string' ? reason.slice(0, 200) : JSON.stringify(reason).slice(0, 200);
  throw new Error(
    `git-pusher completed without creating a PR/MR ` +
      `(no pr_number, mr_number, pr_url, or mr_url in output). ` +
      `Reason: ${reasonStr}`
  );
}

function extractReviewNumberFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  for (const adapter of Object.values(VERIFICATION_ADAPTERS)) {
    for (const regex of adapter.urlPatterns || []) {
      regex.lastIndex = 0;
      const matches = [...url.matchAll(regex)];
      const last = matches.length > 0 ? matches[matches.length - 1] : null;
      if (last && last[1]) return normalizePrNumber(last[1]);
    }
  }
  return null;
}

function validatePrUrl({ adapter, claimedPrUrl, prData }) {
  if (!claimedPrUrl || !prData.url) return;

  if (claimedPrUrl === prData.url) return;

  const claimedNumber = extractReviewNumberFromUrl(claimedPrUrl);
  const actualNumber = extractReviewNumberFromUrl(prData.url);
  if (!adapter.strictUrlMatch && claimedNumber && actualNumber && claimedNumber === actualNumber) {
    return;
  }

  throw new Error(
    `VERIFICATION FAILED: Agent claimed URL ${claimedPrUrl}, ` +
      `but ${adapter.displayName} CLI reports ${prData.url}.`
  );
}

function shouldSkipVerification(adapter) {
  const skipVars = adapter.skipEnvVars || [];
  return skipVars.some((name) => process.env[name] === '1');
}

async function verifyPullRequest({ result, agent, autoMerge }) {
  // Default to true (merge required) so existing callers/tests and --ship semantics stay fail-closed.
  const requireMerge = autoMerge !== false;
  const platform = resolveVerificationPlatform(agent);
  const adapter = getVerificationAdapter(platform);
  const providerName =
    typeof agent?._resolveProvider === 'function'
      ? agent._resolveProvider()
      : getDefaultProviderId();
  const claims = resolvePrClaimsFromOutput({
    output: result.output,
    parsedResult: result.parsedResult,
    providerName,
    adapter,
  });

  if (handleBlockedPusherOutcome({ claims, platform, agent, requireMerge })) {
    return;
  }

  if (shouldSkipVerification(adapter)) {
    const skipVar = (adapter.skipEnvVars || []).find((name) => process.env[name] === '1');
    agent._log(`✅ VERIFICATION SKIPPED (${skipVar || 'skip flag enabled'})`);
    publishClusterComplete(
      agent,
      buildVerificationPayload({
        platform,
        prData: { number: claims.claimedPrNumber, url: claims.claimedPrUrl },
        reason: 'git-pusher-complete-verified',
      })
    );
    return;
  }

  validatePrClaims(claims);

  let prData = await fetchPrDataWithRetry({
    adapter,
    cwd: agent.workingDirectory,
    prNumber: claims.claimedPrNumber,
    agent,
  });

  validatePrUrl({ adapter, claimedPrUrl: claims.claimedPrUrl, prData });

  if (claims.usedFallbackExtraction) {
    agent._log(
      `⚠️  PR metadata recovered from raw output fallback ` +
        `(provider=${providerName}, platform=${platform}, ${adapter.itemName.toLowerCase()}=#${prData.number})`
    );
  }

  if (!requireMerge) {
    // --pr mode: the PR/MR was created and verified to exist. It's left OPEN for human
    // review - do NOT poll for merge or treat an unmerged PR as a failure.
    if (adapter.isMerged(prData)) {
      throw new Error(
        `VERIFICATION FAILED: ${adapter.itemName} #${prData.number} is already merged, ` +
          'but this run was started in review mode (autoMerge=false).'
      );
    }

    agent._log(
      `✅ VERIFICATION PASSED: ${adapter.itemName} #${prData.number} created (open for human review)`
    );
    publishClusterComplete(agent, {
      ...buildVerificationPayload({
        platform,
        prData,
        reason: 'git-pusher-complete-verified',
      }),
      merged: adapter.isMerged(prData),
    });
    return;
  }

  if (!adapter.isMerged(prData)) {
    prData = await pollForMerge({ adapter, prData, agent, cwd: agent.workingDirectory });
  }

  if (!adapter.isMerged(prData)) {
    handleUnmergedPr({ adapter, platform, prData, agent });
    return;
  }

  agent._log(`✅ VERIFICATION PASSED: ${adapter.itemName} #${prData.number} actually merged`);
  publishClusterComplete(
    agent,
    buildVerificationPayload({
      platform,
      prData,
      reason: 'git-pusher-complete-verified',
    })
  );
}

module.exports = {
  parsePositiveInt,
  normalizePrNumber,
  extractPrInfoFromRawOutput,
  fetchPrDataWithRetry,
  resolvePrClaimsFromOutput,
  publishClusterComplete,
  verifyPullRequest,
};
