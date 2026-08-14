/**
 * Git Pusher Agent Template
 *
 * Generates platform-specific git-pusher agent configurations.
 * Eliminates duplication across github/gitlab/azure JSON files.
 *
 * Single source of truth for:
 * - Trigger logic (validation consensus detection)
 * - Agent structure (id, role, modelLevel, output)
 * - Prompt template with platform-specific commands
 */

/**
 * Shared trigger logic for detecting when all validators have approved.
 * This is the SINGLE source of truth - no more duplicating across 3 JSON files.
 */
const SHARED_TRIGGER_SCRIPT = `const validators = cluster.getAgentsByRole('validator');
const lastPush = ledger.findLast({ topic: 'IMPLEMENTATION_READY' });
if (!lastPush) return false;

function isApproved(value) {
  return value === true || value === 'true';
}

function getPayload(msg) {
  return msg?.content?.['data'] || {};
}

function getEvidence(gate) {
  return gate?.evidence && typeof gate.evidence === 'object' ? gate.evidence : {};
}

function getGateId(gate) {
  if (typeof gate?.id === 'string' && gate.id.trim() !== '') return gate.id.trim();
  const gateName = gate?.['name'];
  if (typeof gateName === 'string' && gateName.trim() !== '') return gateName.trim();
  return null;
}

function normalizeGateRequirements(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const gate of value) {
    if (typeof gate === 'string') {
      const id = gate.trim();
      if (id) normalized.push({ id });
      continue;
    }
    if (!gate || typeof gate !== 'object') continue;
    const id = getGateId(gate);
    if (!id) continue;
    const required = { id };
    if (typeof gate.scope === 'string' && gate.scope.trim() !== '') {
      required.scope = gate.scope.trim();
    }
    normalized.push(required);
  }
  return normalized;
}

function getRequiredQualityGates() {
  const currentAgent =
    typeof cluster.getAgent === 'function' ? cluster.getAgent(agent.id) : null;
  const sources = [
    agent.requiredQualityGates,
    currentAgent?.requiredQualityGates,
    currentAgent?.config?.requiredQualityGates,
  ];
  for (const source of sources) {
    const gates = normalizeGateRequirements(source);
    if (gates.length > 0) return gates;
  }
  return [];
}

function collectQualityGates(msg) {
  const gateData = getPayload(msg);
  return Array.isArray(gateData.qualityGates) ? gateData.qualityGates : [];
}

function toTimestamp(timestampInput) {
  const value = timestampInput;
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (isFinite(parsed)) return parsed;
  }
  return null;
}

function qualityGateTimestamp(gate, msg) {
  const evidence = getEvidence(gate);
  return (
    toTimestamp(gate?.timestamp) ||
    toTimestamp(gate?.validatedAt) ||
    toTimestamp(gate?.completedAt) ||
    toTimestamp(evidence.timestamp) ||
    toTimestamp(evidence.validatedAt) ||
    toTimestamp(evidence.completedAt)
  );
}

function describeQualityGate(gate, msg, required) {
  const evidence = getEvidence(gate);
  const parts = [];
  const gateId = getGateId(gate) || required?.id;
  const scope = gate?.scope || evidence.scope || required?.scope;
  const status = gate?.status;
  const exitCode = evidence.exitCode;
  const command = evidence.command;
  const output = evidence.output || gate?.reason || evidence.reason;
  if (gateId) parts.push('gate=' + gateId);
  if (scope) parts.push('scope=' + scope);
  if (status) parts.push('status=' + status);
  if (exitCode !== undefined) parts.push('exitCode=' + exitCode);
  if (command) parts.push('command=' + JSON.stringify(String(command).slice(0, 160)));
  if (msg?.sender) parts.push('sender=' + msg.sender);
  if (output) parts.push('output=' + JSON.stringify(String(output).slice(0, 240)));
  if (!output && (gate?.reason || evidence.reason)) {
    parts.push('reason=' + JSON.stringify(String(gate?.reason || evidence.reason).slice(0, 240)));
  }
  return parts.join(' ');
}

function exitCodePasses(evidence) {
  const exitCode = evidence.exitCode;
  return (
    exitCode === 0 ||
    exitCode === '0' ||
    (typeof exitCode === 'string' && exitCode.trim() !== '' && Number(exitCode) === 0)
  );
}

function qualityGateMatches(gate, required) {
  if (getGateId(gate) !== required.id) return false;
  if (required.scope && gate?.scope !== required.scope && getEvidence(gate).scope !== required.scope) {
    return false;
  }
  return true;
}

function compareGateEvidence(left, right) {
  const leftTimestamp = qualityGateTimestamp(left.gate, left.msg) || 0;
  const rightTimestamp = qualityGateTimestamp(right.gate, right.msg) || 0;
  return leftTimestamp - rightTimestamp;
}

function findLatestQualityGate(messages, required) {
  let latest = null;
  for (const msg of messages) {
    for (const gate of collectQualityGates(msg)) {
      if (!qualityGateMatches(gate, required)) continue;
      const candidate = { gate, msg };
      if (!latest || compareGateEvidence(candidate, latest) >= 0) {
        latest = candidate;
      }
    }
  }
  return latest;
}

function getQualityGateBlockingReasons(gate, msg) {
  const reasons = [];
  const status = String(gate?.status || '').toUpperCase();
  if (status !== 'PASS') reasons.push('status=' + (gate?.status || 'missing'));

  const evidence = getEvidence(gate);
  if (typeof evidence.command !== 'string' || evidence.command.trim() === '') {
    reasons.push('missing evidence.command');
  }
  if (!exitCodePasses(evidence)) {
    reasons.push('evidence.exitCode=' + evidence.exitCode);
  }
  if (typeof evidence.output !== 'string') {
    reasons.push('missing evidence.output');
  }
  if (gate?.stale === true || evidence.stale === true) {
    reasons.push('stale=true');
  }
  const completedAt = qualityGateTimestamp(gate, msg);
  if (completedAt === null) {
    reasons.push('missing completedAt');
  } else if (completedAt < lastPush.timestamp) {
    reasons.push('completed before IMPLEMENTATION_READY');
  }
  return reasons;
}

function assertRequiredQualityGatesPass(messages) {
  if (requiredQualityGatesForHandoff.length === 0) return true;

  for (const required of requiredQualityGatesForHandoff) {
    const found = findLatestQualityGate(messages, required);
    if (!found) {
      throw new Error(
        'Required quality gate missing for git-pusher handoff: gate=' + required.id
      );
    }

    const reasons = getQualityGateBlockingReasons(found.gate, found.msg);
    if (reasons.length > 0) {
      throw new Error(
        'Required quality gate blocked git-pusher handoff: ' +
          describeQualityGate(found.gate, found.msg, required) +
          ' reason=' +
          JSON.stringify(reasons.join(', '))
      );
    }
  }

  return true;
}

const requiredQualityGatesForHandoff = getRequiredQualityGates();
if (validators.length === 0 && requiredQualityGatesForHandoff.length === 0) return true;

// A generated topology validates in stages, and every stage but the last
// publishes STAGE_<n>_VALIDATION_RESULT rather than VALIDATION_RESULT. Counting
// only the plain topic misses every earlier-stage validator, so
// latestByValidator can never reach validators.length and the handoff never
// fires: the work is built, approved by all of them, and then never shipped.
const results = ledger
  .query({ since: lastPush.timestamp })
  .filter((msg) => typeof msg.topic === 'string' && /(?:^|_)VALIDATION_RESULT$/.test(msg.topic));
if (results.length === 0) return false;

const validatorIds = new Set(validators.map((v) => v.id));
const validatorResults = results.filter((r) => validatorIds.has(r.sender));

// Two supported patterns:
// 1) Per-validator VALIDATION_RESULT (sender is a validator) → require all validators approve.
// 2) Consensus-only VALIDATION_RESULT (sender is coordinator) -> use latest result.
if (validatorResults.length === 0) {
  let latest = null;
  for (const msg of results) {
    if (!latest || (typeof msg.timestamp === 'number' && msg.timestamp > latest.timestamp)) {
      latest = msg;
    }
  }
  const approved = getPayload(latest).approved;
  if (!isApproved(approved)) return false;
  assertRequiredQualityGatesPass([latest]);
  return true;
}

const latestByValidator = new Map();
for (const msg of validatorResults) {
  latestByValidator.set(msg.sender, msg);
}
if (latestByValidator.size < validators.length) return false;

for (const validator of validators) {
  const msg = latestByValidator.get(validator.id);
  const approved = getPayload(msg).approved;
  if (!isApproved(approved)) return false;
}

const latestValidatorMessages = Array.from(latestByValidator.values());
assertRequiredQualityGatesPass(latestValidatorMessages);

const hasSufficientEvidence = latestValidatorMessages.every((r) => {
  const criteria = getPayload(r).criteriaResults;
  if (!Array.isArray(criteria) || criteria.length === 0) return true;
  return criteria.every((c) => {
    const status = String(c.status || '').toUpperCase();
    if (status === 'CANNOT_VALIDATE') return true;
    if (status === 'SKIPPED') return true;
    if (status === 'CANNOT_VALIDATE_YET') return false;
    const evidence = c.evidence || {};
    const hasCommand = typeof evidence.command === 'string' && evidence.command.trim().length > 0;
    const exitCode = evidence.exitCode;
    const hasExitCode =
      typeof exitCode === 'number' ||
      (typeof exitCode === 'string' && exitCode.trim() !== '' && isFinite(Number(exitCode)));
    const hasOutput = evidence.output === undefined || typeof evidence.output === 'string';
    return hasCommand && hasExitCode && hasOutput;
  });
});

return hasSufficientEvidence;`;

const { readRepoSettings } = require('../../lib/repo-settings');
const { normalizeGitRemoteName, quoteShellArgument } = require('../../lib/git-remote-utils');
const { resolveRequiredQualityGates } = require('../quality-gates');
const { renderPullRequestBody, resolveIssueContext } = require('../pr-body-template');

function getSafeBranchName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Conservative allowlist to avoid shell injection in generated CLI commands.
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '1' || trimmed === 'true' || trimmed === 'yes') return true;
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'no') return false;
  return null;
}

function normalizeCloseIssueMode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'auto') return 'auto';
  if (trimmed === 'always') return 'always';
  if (trimmed === 'never') return 'never';
  return null;
}

/**
 * Resolve GitHub configuration from CLI options and repo settings.
 * Priority: CLI options > repo settings (.zeroshot/settings.json) > defaults
 *
 * @param {Object} options - CLI options
 * @param {string} [options.prBase] - Target branch for PRs
 * @param {boolean} [options.mergeQueue] - Use GitHub merge queue
 * @param {string} [options.closeIssue] - When to close issue: auto|always|never
 * @param {string} [options.gitRemote=origin] - Remote to push the implementation branch to
 * @param {string|number} [options.issueNumber] - Typed issue identifier for prompt commands
 * @param {string} [options.issueTitle] - Typed issue title for prompt commands
 * @param {boolean} [options.includeIssueReference] - Include the closing reference in PR text
 * @param {string} [options.prBody] - Literal PR body template with supported issue tokens
 * @returns {Object} Resolved configuration
 */
function resolveGitHubConfig(options = {}) {
  const repoSettingsResult = readRepoSettings(options.cwd || process.cwd());
  const repoSettings = repoSettingsResult.settings || {};
  const repoGithub = repoSettings.github || {};
  const gitRemote = normalizeGitRemoteName(options.gitRemote ?? 'origin');
  if (!gitRemote) {
    throw new Error(`Invalid git remote name '${options.gitRemote}'`);
  }

  // CLI options override repo settings
  const prBase = getSafeBranchName(options.prBase) || getSafeBranchName(repoGithub.prBase);

  const useMergeQueue =
    options.mergeQueue === true ||
    (options.mergeQueue !== false && parseBool(repoGithub.useMergeQueue) === true);

  const closeIssueMode =
    normalizeCloseIssueMode(options.closeIssue) ||
    normalizeCloseIssueMode(repoGithub.closeIssue) ||
    (parseBool(repoGithub.closeIssue) === true ? 'always' : null) ||
    'never';

  // --ship (or explicit autoMerge) merges automatically; --pr alone stops after PR creation
  // for human review. Repo settings can opt in to auto-merge when the caller hasn't decided.
  const autoMerge =
    options.autoMerge === true ||
    (options.autoMerge !== false && parseBool(repoGithub.autoMerge) === true);

  const issueContext = resolveIssueContext(options);

  return {
    prBase,
    useMergeQueue,
    closeIssueMode,
    autoMerge,
    gitRemote,
    issueContext,
    prBody: renderPullRequestBody(options.prBody, options),
  };
}

function resolvedPrBody(config, issueContext) {
  return typeof config.prBody === 'string' ? config.prBody : issueContext.issueReference;
}

/**
 * Generate platform-specific configuration based on resolved GitHub config.
 *
 * @param {string} platform - Platform ID ('github', 'gitlab', 'azure-devops')
 * @param {Object} config - Resolved GitHub config from resolveGitHubConfig()
 * @returns {Object|null} Platform configuration or null if unsupported
 */
function getPlatformConfig(platform, config = {}) {
  const { prBase, useMergeQueue, closeIssueMode, autoMerge, gitRemote } = config;
  const issueContext = config.issueContext || resolveIssueContext({});
  const issueTitleArgument = quoteShellArgument(`feat: ${issueContext.issueTitle}`);
  const prBodyArgument = quoteShellArgument(resolvedPrBody(config, issueContext));

  const PLATFORM_CONFIGS = {
    github: {
      prName: 'PR',
      prNameLower: 'pull request',
      createCmd:
        `gh pr create${prBase ? ` --base ${prBase}` : ''} ` +
        `--title ${issueTitleArgument} --body ${prBodyArgument}`,
      mergeCmd: useMergeQueue
        ? `PR_ID="$(timeout 30 gh pr view --json id --jq .id)"
gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){mergeQueueEntry{state}}}' -f id="$PR_ID"
echo "Waiting for merge..."
for i in $(seq 1 90); do if timeout 30 gh pr view --json mergedAt --jq .mergedAt | grep -q .; then break; fi; sleep 20; done`
        : 'gh pr merge --merge --delete-branch',
      mergeFallbackCmd: useMergeQueue
        ? 'gh pr merge --merge --delete-branch'
        : 'gh pr merge --merge',
      prUrlExample: 'https://github.com/owner/repo/pull/123',
      outputFields: { urlField: 'pr_url', numberField: 'pr_number', mergedField: 'merged' },
      rebaseBranch: prBase || 'main',
      usesMergeQueue: useMergeQueue,
      closeIssueMode: closeIssueMode || 'never',
      autoMerge: Boolean(autoMerge),
      gitRemote,
      issueContext,
    },
    gitlab: {
      prName: 'MR',
      prNameLower: 'merge request',
      createCmd: `glab mr create --title ${issueTitleArgument} --description ${prBodyArgument}`,
      mergeCmd: 'glab mr merge --auto-merge',
      mergeFallbackCmd: 'glab mr merge',
      prUrlExample: 'https://gitlab.com/owner/repo/-/merge_requests/123',
      outputFields: { urlField: 'mr_url', numberField: 'mr_number', mergedField: 'merged' },
      closeIssueMode: closeIssueMode || 'never',
      autoMerge: Boolean(autoMerge),
      gitRemote,
      issueContext,
    },
    'azure-devops': {
      prName: 'PR',
      prNameLower: 'pull request',
      createCmd: `az repos pr create --title ${issueTitleArgument} --description ${prBodyArgument}`,
      mergeCmd: 'az repos pr update --id <PR_ID> --auto-complete true',
      mergeFallbackCmd: 'az repos pr update --id <PR_ID> --status completed',
      prUrlExample: 'https://dev.azure.com/org/project/_git/repo/pullrequest/123',
      outputFields: {
        urlField: 'pr_url',
        numberField: 'pr_number',
        mergedField: 'merged',
        autoCompleteField: 'auto_complete',
      },
      // Azure requires extracting PR ID from create output
      requiresPrIdExtraction: true,
      closeIssueMode: closeIssueMode || 'never',
      autoMerge: Boolean(autoMerge),
      gitRemote,
      issueContext,
    },
  };

  return PLATFORM_CONFIGS[platform] || null;
}

/**
 * Get list of supported platforms for git-pusher
 * @returns {string[]} Array of platform IDs
 */
const SUPPORTED_PLATFORMS = ['github', 'gitlab', 'azure-devops'];

/**
 * Generate the review-mode prompt (--pr without --ship): create the PR/MR and STOP.
 * No merge step, no issue-closing - the PR is left open for human review.
 * @param {Object} config - Platform configuration from PLATFORM_CONFIGS
 * @returns {string} The complete review-mode prompt
 */
function generateReviewModePrompt(config) {
  const {
    prName,
    prNameLower,
    createCmd,
    prUrlExample,
    outputFields,
    requiresPrIdExtraction,
    gitRemote,
    issueContext,
  } = config;
  const gitRemoteArgument = quoteShellArgument(gitRemote);
  const commitMessageArgument = quoteShellArgument(
    `feat: implement #${issueContext.issueNumber} - ${issueContext.issueTitle}`
  );

  return `CRITICAL: ALL VALIDATORS APPROVED. YOU ARE A TRANSPORT-ONLY GIT PUSHER.

Your job is to preserve validator ownership: stage, commit, push, and create the ${prName} for HUMAN REVIEW.

Do NOT edit source files, tests, configs, generated artifacts, or lockfiles.
Do NOT inspect CI logs to debug product code.
Do NOT resolve merge conflicts or rebase conflicts.
Do NOT run implementation/debugging workflows after validators hand off.
Do NOT merge the ${prName} - it is left OPEN for human review.
Do NOT close the linked issue - it stays open until a human merges the ${prName}.

Allowed after validation:
- git add/status/commit/push
- ${createCmd.split(' ').slice(0, 3).join(' ')}
- status-only commands such as ${prName === 'PR' ? 'gh pr view/gh pr checks' : 'the platform PR/MR status command'}

If commit hooks, push, ${prName} creation, or conflict handling requires code changes, STOP and report the blocked state in JSON. The implementation and validator agents must fix code and rerun quality gates.

## MANDATORY STEPS - EXECUTE EACH ONE IN ORDER - DO NOT SKIP ANY STEP

### STEP 1: Stage ALL changes (MANDATORY)
\`\`\`bash
git add -A
\`\`\`
Run this command. Do not skip it. If commit fails because hooks/checks fail, do not edit files. Output blocked JSON with the failure summary.

### STEP 2: Check what's staged
\`\`\`bash
git status
\`\`\`
Run this. If nothing to commit, output JSON with ${outputFields.urlField}: null and stop.

### STEP 3: Commit the changes (MANDATORY if there are changes)
\`\`\`bash
git commit -m ${commitMessageArgument}
\`\`\`
Run this command. Do not skip it.

### STEP 4: Push to ${gitRemote} (MANDATORY)
\`\`\`bash
git push -u -- ${gitRemoteArgument} HEAD
\`\`\`
Run this. If it fails, do not edit files, rebase, or resolve conflicts. Output blocked JSON with the failure summary.

⚠️ AFTER PUSH YOU ARE NOT DONE! CONTINUE TO STEP 5! ⚠️

### STEP 5: CREATE THE ${prName.toUpperCase()} (MANDATORY - YOU MUST RUN THIS COMMAND)
\`\`\`bash
${createCmd}
\`\`\`
🚨 YOU MUST RUN \`${createCmd.split(' ').slice(0, 3).join(' ')}\`! Outputting a link is NOT creating a ${prName}! 🚨
The push output shows a "Create a ${prNameLower}" link - IGNORE IT.
You MUST run the \`${createCmd.split(' ').slice(0, 3).join(' ')}\` command above.${requiresPrIdExtraction ? '' : ` Save the actual ${prName} URL from the output.`}

⚠️ AFTER THE ${prName} IS CREATED, YOU ARE DONE. DO NOT MERGE. DO NOT CLOSE THE ISSUE. ⚠️

## CRITICAL RULES
- Execute EVERY step in order (1, 2, 3, 4, 5)
- Do NOT skip git add -A
- Do NOT skip git commit
- Do NOT skip ${createCmd.split(' ').slice(0, 3).join(' ')} - THE TASK IS NOT DONE UNTIL ${prName} EXISTS
- Do NOT merge the ${prName} - this run is for human review only
- Do NOT close the issue - it stays open until a human merges the ${prName}
- Do NOT edit files after validator handoff
- Do NOT debug product failures after validator handoff
- If push or ${prName} creation fails, report it instead of fixing code
- Output JSON as soon as the ${prName} is created (OPEN, unmerged), or a non-code transport failure blocks progress
- A link from git push is NOT a ${prName} - you must run ${createCmd.split(' ').slice(0, 3).join(' ')}

## Final Output
ONLY after the ${prName} is CREATED (left OPEN for review), output:
\`\`\`json
{"${outputFields.urlField}": "${prUrlExample}", "${outputFields.numberField}": 123, "merged": false}
\`\`\`

If truly no changes exist, output:
\`\`\`json
{"${outputFields.urlField}": null, "${outputFields.numberField}": null, "merged": false}
\`\`\`

If blocked after creating a ${prName}, output:
\`\`\`json
{"${outputFields.urlField}": "${prUrlExample}", "${outputFields.numberField}": 123, "merged": false, "blocked": true, "blocked_reason": "ci_failed: test job failed"}
\`\`\`

If blocked before creating a ${prName}, output:
\`\`\`json
{"${outputFields.urlField}": null, "${outputFields.numberField}": null, "merged": false, "blocked": true, "blocked_reason": "commit_failed: pre-commit hook failed"}
\`\`\``;
}

/**
 * Generate the prompt for a specific platform
 * @param {Object} config - Platform configuration from PLATFORM_CONFIGS
 * @returns {string} The complete prompt with platform-specific commands
 */
function generatePrompt(config) {
  const {
    prName,
    prNameLower,
    createCmd,
    mergeCmd,
    mergeFallbackCmd,
    prUrlExample,
    outputFields,
    requiresPrIdExtraction,
    rebaseBranch,
    usesMergeQueue,
    closeIssueMode,
    autoMerge,
    gitRemote,
    issueContext,
  } = config;
  const gitRemoteArgument = quoteShellArgument(gitRemote);
  const issueNumberArgument = quoteShellArgument(issueContext.issueNumber);
  const commitMessageArgument = quoteShellArgument(
    `feat: implement #${issueContext.issueNumber} - ${issueContext.issueTitle}`
  );

  if (!autoMerge) {
    return generateReviewModePrompt(config);
  }

  // Azure-specific instructions for PR ID extraction
  const azurePrIdNote = requiresPrIdExtraction
    ? `\n\n💡 IMPORTANT: The output will contain the PR ID. You MUST extract it for the next step.
Look for output like: "Created PR 123" or parse the URL for the PR number.
Save the PR ID to a variable for step 6.`
    : '';

  // Azure uses different merge terminology
  const mergeDescription = requiresPrIdExtraction
    ? 'SET AUTO-COMPLETE (MANDATORY - THIS IS NOT OPTIONAL)'
    : usesMergeQueue
      ? `ENQUEUE INTO MERGE QUEUE AND WAIT UNTIL THE ${prName} IS MERGED (MANDATORY - THIS IS NOT OPTIONAL)`
      : `MERGE THE ${prName} (MANDATORY - THIS IS NOT OPTIONAL)`;

  const mergeExplanation = requiresPrIdExtraction
    ? `Replace <PR_ID> with the actual PR number from step 5.
This enables auto-complete (auto-merge when CI passes).

If auto-complete is not available or you need to merge immediately:`
    : usesMergeQueue
      ? `This enqueues the ${prName} into GitHub's merge queue and waits until it is merged.

If enqueue fails (merge queue not enabled, missing permissions, etc.), fall back to auto-merge:`
      : `This merges the ${prName} directly and deletes the remote branch. If it fails, try without branch deletion:`;

  const finalOutputNote = requiresPrIdExtraction
    ? `ONLY after the PR is created and auto-complete is set, output:
\`\`\`json
{"${outputFields.urlField}": "${prUrlExample}", "${outputFields.numberField}": 123, "merged": false, "auto_complete": true}
\`\`\`

If truly no changes exist, output:
\`\`\`json
{"${outputFields.urlField}": null, "${outputFields.numberField}": null, "merged": false, "auto_complete": false}
\`\`\``
    : `ONLY after the ${prName} is MERGED, output:
\`\`\`json
{"${outputFields.urlField}": "${prUrlExample}", "${outputFields.numberField}": 123, "merged": true}
\`\`\`

If truly no changes exist, output:
\`\`\`json
{"${outputFields.urlField}": null, "${outputFields.numberField}": null, "merged": false}
\`\`\``;

  return `CRITICAL: ALL VALIDATORS APPROVED. YOU ARE A TRANSPORT-ONLY GIT PUSHER.

Your job is to preserve validator ownership: stage, commit, push, create the ${prName}, then merge or enable auto-merge when possible.

Do NOT edit source files, tests, configs, generated artifacts, or lockfiles.
Do NOT inspect CI logs to debug product code.
Do NOT resolve merge conflicts or rebase conflicts.
Do NOT run implementation/debugging workflows after validators hand off.

Allowed after validation:
- git add/status/commit/push
- ${createCmd.split(' ').slice(0, 3).join(' ')}
- ${mergeCmd.split(' ').slice(0, 4).join(' ')} or auto-merge/auto-complete commands
- status-only commands such as ${prName === 'PR' ? 'gh pr view/gh pr checks' : 'the platform PR/MR status command'}

If commit hooks, push, ${prName} creation, merge, CI, or conflict handling requires code changes, STOP and report the blocked state in JSON. The implementation and validator agents must fix code and rerun quality gates.

## MANDATORY STEPS - EXECUTE EACH ONE IN ORDER - DO NOT SKIP ANY STEP

### STEP 1: Stage ALL changes (MANDATORY)
\`\`\`bash
git add -A
\`\`\`
Run this command. Do not skip it. If commit fails because hooks/checks fail, do not edit files. Output blocked JSON with the failure summary.

### STEP 2: Check what's staged
\`\`\`bash
git status
\`\`\`
Run this. If nothing to commit, output JSON with ${outputFields.urlField}: null and stop.

### STEP 3: Commit the changes (MANDATORY if there are changes)
\`\`\`bash
git commit -m ${commitMessageArgument}
\`\`\`
Run this command. Do not skip it.

### STEP 4: Push to ${gitRemote} (MANDATORY)
\`\`\`bash
git push -u -- ${gitRemoteArgument} HEAD
\`\`\`
Run this. If it fails, do not edit files, rebase, or resolve conflicts. Output blocked JSON with the failure summary.

⚠️ AFTER PUSH YOU ARE NOT DONE! CONTINUE TO STEP 5! ⚠️

### STEP 5: CREATE THE ${prName.toUpperCase()} (MANDATORY - YOU MUST RUN THIS COMMAND)
\`\`\`bash
${createCmd}
\`\`\`
🚨 YOU MUST RUN \`${createCmd.split(' ').slice(0, 3).join(' ')}\`! Outputting a link is NOT creating a ${prName}! 🚨
The push output shows a "Create a ${prNameLower}" link - IGNORE IT.
You MUST run the \`${createCmd.split(' ').slice(0, 3).join(' ')}\` command above.${requiresPrIdExtraction ? '' : ` Save the actual ${prName} URL from the output.`}${azurePrIdNote}

⚠️ AFTER ${prName} CREATION YOU ARE NOT DONE! CONTINUE TO STEP 6! ⚠️

### STEP 6: ${mergeDescription}
\`\`\`bash
${mergeCmd}
\`\`\`
${mergeExplanation}
\`\`\`bash
${mergeFallbackCmd}
\`\`\`

If direct merge is blocked by pending CI or required review, set auto-merge/auto-complete when the platform supports it and output status-only JSON without \`blocked: true\`.
If merge is blocked by failed CI, merge conflicts, rejected hooks, or any condition requiring code changes, do not debug or edit code. Output blocked JSON with the ${prName} details and failure summary.

${
  closeIssueMode !== 'never'
    ? `### STEP 7: Close the issue (MANDATORY)
\`\`\`bash
if [ ${issueNumberArgument} != "unknown" ]; then
  ISSUE_STATE="$(gh issue view ${issueNumberArgument} --json state --jq .state 2>/dev/null || true)"
  if [ "$ISSUE_STATE" = "OPEN" ]; then
    BASE_BRANCH="${rebaseBranch || 'main'}"
    DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)"
    SHOULD_CLOSE="0"
    if [ "${closeIssueMode}" = "always" ]; then
      SHOULD_CLOSE="1"
    elif [ "${closeIssueMode}" = "auto" ]; then
      if [ -z "$DEFAULT_BRANCH" ] || [ "$BASE_BRANCH" != "$DEFAULT_BRANCH" ]; then
        SHOULD_CLOSE="1"
      fi
    fi

    if [ "$SHOULD_CLOSE" = "1" ]; then
  PR_URL="$(gh pr view --json url --jq .url 2>/dev/null || true)"
  if [ -n "$PR_URL" ]; then
    gh issue close ${issueNumberArgument} --comment "Implemented in $PR_URL"
  else
    gh issue close ${issueNumberArgument} --comment "Implemented"
  fi
    fi
  fi
fi
\`\`\`
Only do this AFTER the ${prName} is merged.`
    : ''
}

## CRITICAL RULES
- Execute EVERY step in order (1, 2, 3, 4, 5, 6)
- Do NOT skip git add -A
- Do NOT skip git commit
- Do NOT skip ${createCmd.split(' ').slice(0, 3).join(' ')} - THE TASK IS NOT DONE UNTIL ${prName} EXISTS
- Do NOT skip ${mergeCmd.split(' ').slice(0, 4).join(' ')} - attempt merge or auto-merge before reporting blocked${requiresPrIdExtraction ? '\n- MUST extract PR ID from step 5 output to use in step 6' : ''}
- Do NOT edit files after validator handoff
- Do NOT debug product failures after validator handoff
- If push, ${prName} creation, CI, or ${requiresPrIdExtraction ? 'auto-complete' : 'merge'} fails, report it instead of fixing code
- Output JSON only after the ${prName} is merged, auto-merge is enabled/pending, or a non-code transport failure blocks progress
- A link from git push is NOT a ${prName} - you must run ${createCmd.split(' ').slice(0, 3).join(' ')}

## Final Output
${finalOutputNote}

If blocked after creating a ${prName}, output:
\`\`\`json
{"${outputFields.urlField}": "${prUrlExample}", "${outputFields.numberField}": 123, "merged": false, "blocked": true, "blocked_reason": "ci_failed: test job failed"}
\`\`\`

If blocked before creating a ${prName}, output:
\`\`\`json
{"${outputFields.urlField}": null, "${outputFields.numberField}": null, "merged": false, "blocked": true, "blocked_reason": "commit_failed: pre-commit hook failed"}
\`\`\``;
}

/**
 * Generate a git-pusher agent configuration for a specific platform
 *
 * @param {string} platform - Platform ID ('github', 'gitlab', 'azure-devops')
 * @param {Object} [options] - CLI options for GitHub configuration
 * @param {string} [options.prBase] - Target branch for PRs
 * @param {boolean} [options.mergeQueue] - Use GitHub merge queue
 * @param {string} [options.closeIssue] - When to close issue: auto|always|never
 * @param {string} [options.gitRemote=origin] - Remote to push the implementation branch to
 * @param {string|number} [options.issueNumber] - Typed issue identifier for prompt commands
 * @param {string} [options.issueTitle] - Typed issue title for prompt commands
 * @param {boolean} [options.includeIssueReference] - Include the closing reference in PR text
 * @param {string} [options.prBody] - Literal PR body template with supported issue tokens
 * @param {Array} [options.requiredQualityGates] - Required handoff quality gates
 * @param {boolean} [options.autoMerge] - Merge the PR (--ship). False stops after PR creation (--pr).
 * @returns {Object} Agent configuration object
 * @throws {Error} If platform is not supported
 */
function generateGitPusherAgent(platform, options = {}) {
  // Resolve config from CLI options and repo settings
  const resolvedConfig = resolveGitHubConfig(options);
  const platformConfig = getPlatformConfig(platform, resolvedConfig);
  const requiredQualityGates = resolveRequiredQualityGates(options);

  if (!platformConfig) {
    const supported = SUPPORTED_PLATFORMS.join(', ');
    throw new Error(`Unsupported platform '${platform}'. Supported: ${supported}`);
  }

  return {
    id: 'git-pusher',
    role: 'completion-detector',
    modelLevel: 'level2',
    ...(requiredQualityGates.length > 0 ? { requiredQualityGates } : {}),
    triggers: [
      {
        topic: 'VALIDATION_RESULT',
        logic: {
          engine: 'javascript',
          script: SHARED_TRIGGER_SCRIPT,
        },
        action: 'execute_task',
      },
    ],
    prompt: generatePrompt(platformConfig),
    hooks: {
      onComplete: {
        action: 'verify_pull_request',
        // Verification reads PR data from result.structured_output; autoMerge controls
        // whether an OPEN unmerged PR counts as success (--pr) or must be merged (--ship).
        config: { autoMerge: Boolean(platformConfig.autoMerge) },
      },
    },
    output: {
      topic: 'PR_CREATED',
      publishAfter: 'CLUSTER_COMPLETE',
    },
    structuredOutput: {
      type: 'object',
      properties: {
        pr_number: {
          type: 'number',
          description: 'MUST extract from gh pr create output - NOT from git push link',
        },
        pr_url: { type: 'string' },
        merged: { type: 'boolean' },
        merge_commit_sha: {
          type: 'string',
          description: 'MUST extract from gh pr merge output',
        },
        blocked: { type: 'boolean' },
        blocked_reason: { type: 'string' },
      },
      required: ['pr_number', 'pr_url', 'merged'],
    },
  };
}

/**
 * Get list of supported platforms for git-pusher
 * @returns {string[]} Array of platform IDs
 */
function getSupportedPlatforms() {
  return SUPPORTED_PLATFORMS;
}

/**
 * Check if a platform supports git-pusher (PR/MR creation)
 * @param {string} platform - Platform ID
 * @returns {boolean}
 */
function isPlatformSupported(platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

module.exports = {
  generateGitPusherAgent,
  getSupportedPlatforms,
  isPlatformSupported,
  // Export for testing
  SHARED_TRIGGER_SCRIPT,
  SUPPORTED_PLATFORMS,
  resolveGitHubConfig,
  getPlatformConfig,
};
