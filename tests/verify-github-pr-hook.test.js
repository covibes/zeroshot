/**
 * verify_pull_request Hook Action Test Suite
 *
 * Tests for the verify_pull_request hook action that validates PR existence and merge status
 * Part of issue #340 - Prevent git-pusher hallucination
 */

const assert = require('assert');
const childProcess = require('child_process');

function spawnSuccess(stdout) {
  return { status: 0, stdout, stderr: '' };
}

function spawnFailure(stderr) {
  return { status: 1, stdout: '', stderr };
}

function commandText(command, args) {
  return [command, ...(args || [])].join(' ');
}

// Mock agent with required methods
function createMockAgent(workingDirectory = process.cwd(), providerName = 'claude') {
  return {
    id: 'test-agent',
    role: 'test',
    workingDirectory,
    _resolveProvider: () => providerName,
    _log: () => {},
    _publish: function (message) {
      this.lastPublished = message;
    },
    lastPublished: null,
  };
}

describe('verify_pull_request hook action', () => {
  let executeHook;
  let mockSpawnSyncFn;
  let mockPlatformResolver;
  let originalSpawnSync;
  let previousPollAttempts;
  let previousPollIntervalMs;
  let previousFetchRetryAttempts;
  let previousFetchRetryIntervalMs;

  beforeEach(() => {
    previousPollAttempts = process.env.ZEROSHOT_PR_MERGE_POLL_ATTEMPTS;
    previousPollIntervalMs = process.env.ZEROSHOT_PR_MERGE_POLL_INTERVAL_MS;
    previousFetchRetryAttempts = process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_ATTEMPTS;
    previousFetchRetryIntervalMs = process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_INTERVAL_MS;
    process.env.ZEROSHOT_PR_MERGE_POLL_ATTEMPTS = '4';
    process.env.ZEROSHOT_PR_MERGE_POLL_INTERVAL_MS = '1';
    process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_ATTEMPTS = '2';
    process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_INTERVAL_MS = '1';

    // Clear module cache for modules in the dependency chain
    const prVerificationPath = require.resolve('../src/agent/pr-verification.js');
    const issueProvidersPath = require.resolve('../src/issue-providers/index.js');
    const hookExecutorPath = require.resolve('../src/agent/agent-hook-executor.js');

    delete require.cache[hookExecutorPath];
    delete require.cache[prVerificationPath];
    delete require.cache[issueProvidersPath];

    originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function (...args) {
      if (mockSpawnSyncFn) {
        return mockSpawnSyncFn(...args);
      }
      return spawnFailure('Mock spawnSync not configured');
    };

    mockPlatformResolver = null;
    require.cache[issueProvidersPath] = {
      id: issueProvidersPath,
      filename: issueProvidersPath,
      loaded: true,
      exports: {
        getPlatformForPR: (cwd) => (mockPlatformResolver ? mockPlatformResolver(cwd) : 'github'),
      },
    };

    // Reload executeHook after replacing spawnSync so pr-verification captures the seam.
    executeHook = require('../src/agent/agent-hook-executor').executeHook;
    mockSpawnSyncFn = null;
  });

  afterEach(() => {
    childProcess.spawnSync = originalSpawnSync;
    mockSpawnSyncFn = null;
    mockPlatformResolver = null;
    if (previousPollAttempts === undefined) {
      delete process.env.ZEROSHOT_PR_MERGE_POLL_ATTEMPTS;
    } else {
      process.env.ZEROSHOT_PR_MERGE_POLL_ATTEMPTS = previousPollAttempts;
    }
    if (previousPollIntervalMs === undefined) {
      delete process.env.ZEROSHOT_PR_MERGE_POLL_INTERVAL_MS;
    } else {
      process.env.ZEROSHOT_PR_MERGE_POLL_INTERVAL_MS = previousPollIntervalMs;
    }
    if (previousFetchRetryAttempts === undefined) {
      delete process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_ATTEMPTS;
    } else {
      process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_ATTEMPTS = previousFetchRetryAttempts;
    }
    if (previousFetchRetryIntervalMs === undefined) {
      delete process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_INTERVAL_MS;
    } else {
      process.env.ZEROSHOT_PR_VERIFY_FETCH_RETRY_INTERVAL_MS = previousFetchRetryIntervalMs;
    }
  });

  it('should verify PR when pr_url present but pr_number missing', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        summary: 'Merged',
        pr_url: 'https://github.com/org/repo/pull/123',
        merged: true,
      }),
    };

    mockSpawnSyncFn = () => {
      return spawnSuccess(
        JSON.stringify({
          number: 123,
          state: 'MERGED',
          mergedAt: '2026-01-15T10:30:00Z',
          url: 'https://github.com/org/repo/pull/123',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert(agent.lastPublished, 'Expected message to be published');
    assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
  });

  it('prefers cached parsedResult claims over unrecoverable raw output', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: 'Tool call completed without a final JSON response',
      parsedResult: {
        summary: 'Created pull request',
        pr_url: 'https://github.com/org/repo/pull/123',
        pr_number: 123,
      },
    };

    mockSpawnSyncFn = () =>
      spawnSuccess(
        JSON.stringify({
          number: 123,
          state: 'MERGED',
          mergedAt: '2026-01-15T10:30:00Z',
          url: 'https://github.com/org/repo/pull/123',
        })
      );

    await executeHook({ hook, agent, result });

    assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
    assert.strictEqual(agent.lastPublished.content.data.pr_number, 123);
  });

  it('should throw when PR does not exist in GitHub', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/9999',
        merged: true,
      }),
    };

    mockSpawnSyncFn = () => spawnFailure('Could not resolve to a PullRequest');

    try {
      await executeHook({ hook, agent, result });
      assert.fail('Expected error to be thrown');
    } catch (err) {
      assert.match(err.message, /DOES NOT EXIST/);
      assert.match(err.message, /HALLUCINATED/);
    }
  });

  it('should complete with verification-pending when PR remains OPEN after all polls', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/123',
        pr_number: 123,
        merged: true,
      }),
    };

    // Always returns OPEN
    mockSpawnSyncFn = () => {
      return spawnSuccess(
        JSON.stringify({
          number: 123,
          state: 'OPEN',
          mergedAt: null,
          url: 'https://github.com/org/repo/pull/123',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert(agent.lastPublished, 'Expected message to be published');
    assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
    assert.strictEqual(
      agent.lastPublished.content.data.reason,
      'git-pusher-complete-verification-pending'
    );
    assert.strictEqual(agent.lastPublished.content.data.verification_pending, true);
  });

  it('should throw when PR is CLOSED without merge after all polls', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/123',
        pr_number: 123,
        merged: true,
      }),
    };

    mockSpawnSyncFn = () => {
      return spawnSuccess(
        JSON.stringify({
          number: 123,
          state: 'CLOSED',
          mergedAt: null,
          url: 'https://github.com/org/repo/pull/123',
        })
      );
    };

    await assert.rejects(
      () => executeHook({ hook, agent, result }),
      /exists but is not merged \(state="CLOSED"\)/i
    );
  });

  // REGRESSION: gentle-hydra-56 (2026-02-11)
  // GitHub API returned state="OPEN" immediately after gh pr merge, but PR was actually merged.
  // Old code had no merge propagation polling — killed the cluster after 3s.
  it('should succeed when GitHub API shows OPEN initially then MERGED after propagation delay', async function () {
    const agent = createMockAgent();
    agent._log = () => {}; // suppress log noise
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/1411',
        pr_number: 1411,
        merged: true,
      }),
    };

    // Simulate GitHub eventual consistency: OPEN for first 3 calls, then MERGED
    let callCount = 0;
    mockSpawnSyncFn = () => {
      callCount++;
      if (callCount <= 3) {
        return spawnSuccess(
          JSON.stringify({
            number: 1411,
            state: 'OPEN',
            mergedAt: null,
            url: 'https://github.com/org/repo/pull/1411',
          })
        );
      }
      return spawnSuccess(
        JSON.stringify({
          number: 1411,
          state: 'MERGED',
          mergedAt: '2026-02-11T10:08:37Z',
          url: 'https://github.com/org/repo/pull/1411',
        })
      );
    };

    await executeHook({ hook, agent, result });

    assert(agent.lastPublished, 'Expected CLUSTER_COMPLETE to be published');
    assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
    assert.strictEqual(agent.lastPublished.content.data.pr_number, 1411);
    assert(callCount >= 4, `Expected at least 4 gh calls (got ${callCount})`);
  });

  it('should use explicit PR number in gh command when available in agent output', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/555',
        pr_number: 555,
        merged: true,
      }),
    };

    let capturedCmd;
    mockSpawnSyncFn = (command, args) => {
      capturedCmd = commandText(command, args);
      return spawnSuccess(
        JSON.stringify({
          number: 555,
          state: 'MERGED',
          mergedAt: '2026-02-11T10:00:00Z',
          url: 'https://github.com/org/repo/pull/555',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert(
      capturedCmd.includes('gh pr view 555'),
      `Expected PR number in command, got: ${capturedCmd}`
    );
  });

  // REGRESSION: flying-jungle-51 (2026-02-16)
  // Agent failed to create PR (type errors blocked commit). Structured output had no pr_number/pr_url.
  // Old code fell through to `gh pr view` which found an unrelated open PR → "Agent LIED" error.
  it('should throw when structured output has no PR data (agent failed to create PR)', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        summary: 'PR creation blocked - TypeScript compilation errors',
        result: 'Failed to create PR due to pre-commit errors',
      }),
    };

    // Should NOT reach gh pr view at all
    mockSpawnSyncFn = () => {
      assert.fail('gh pr view should not be called when no PR data in output');
    };

    try {
      await executeHook({ hook, agent, result });
      assert.fail('Expected error to be thrown');
    } catch (err) {
      assert.match(err.message, /without creating a PR/);
      assert.match(err.message, /no pr_number, mr_number, pr_url, or mr_url/i);
      assert.match(err.message, /compilation errors/i);
    }
  });

  // REGRESSION: provider mismatch in hook parser
  // verify_pull_request previously parsed Codex output with Claude parser assumptions.
  // That dropped pr_number/pr_url even when the assistant output contained valid JSON.
  it('should parse Codex output with provider-aware extraction', async function () {
    const agent = createMockAgent(process.cwd(), 'codex');
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: [
        JSON.stringify({
          type: 'item.created',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '{"pr_num' }],
          },
        }),
        JSON.stringify({
          type: 'item.created',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ber":321,"merged":true}' }],
          },
        }),
      ].join('\n'),
    };

    let capturedCmd;
    mockSpawnSyncFn = (command, args) => {
      capturedCmd = commandText(command, args);
      return spawnSuccess(
        JSON.stringify({
          number: 321,
          state: 'MERGED',
          mergedAt: '2026-02-17T10:00:00Z',
          url: 'https://github.com/org/repo/pull/321',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert(
      capturedCmd.includes('gh pr view 321'),
      `Expected PR number in command, got: ${capturedCmd}`
    );
    assert.strictEqual(agent.lastPublished.content.data.pr_number, 321);
  });

  // REGRESSION: hook must recover PR metadata from raw command output when
  // structured extraction misses fields.
  it('should recover PR metadata from raw output fallback extraction', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          aggregated_output: 'Created pull request https://github.com/org/repo/pull/654',
          exit_code: 0,
        },
      }),
    };

    let capturedCmd;
    mockSpawnSyncFn = (command, args) => {
      capturedCmd = commandText(command, args);
      return spawnSuccess(
        JSON.stringify({
          number: 654,
          state: 'MERGED',
          mergedAt: '2026-02-17T10:00:00Z',
          url: 'https://github.com/org/repo/pull/654',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert(
      capturedCmd.includes('gh pr view 654'),
      `Expected PR number in command, got: ${capturedCmd}`
    );
    assert.strictEqual(agent.lastPublished.content.data.pr_number, 654);
  });

  it('should derive PR number from pr_url when pr_number is missing', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/100',
        merged: true,
      }),
    };

    let capturedCmd;
    mockSpawnSyncFn = (command, args) => {
      capturedCmd = commandText(command, args);
      return spawnSuccess(
        JSON.stringify({
          number: 100,
          state: 'MERGED',
          mergedAt: '2026-02-11T10:00:00Z',
          url: 'https://github.com/org/repo/pull/100',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert.strictEqual(capturedCmd, 'gh pr view 100 --json state,mergedAt,url,number');
  });

  it('should publish CLUSTER_COMPLETE when PR verified merged', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/456',
        merged: true,
      }),
    };

    mockSpawnSyncFn = () => {
      return spawnSuccess(
        JSON.stringify({
          number: 456,
          state: 'MERGED',
          mergedAt: '2026-01-15T10:30:00Z',
          url: 'https://github.com/org/repo/pull/456',
        })
      );
    };

    await executeHook({ hook, agent, result });

    assert(agent.lastPublished, 'Expected message to be published');
    assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
    assert.strictEqual(agent.lastPublished.content.data.pr_number, 456);
  });

  it('should pass correct workingDirectory to gh CLI', async function () {
    const agent = createMockAgent('/custom/work/dir');
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/789',
        merged: true,
      }),
    };

    let capturedCwd;
    mockSpawnSyncFn = (command, args, opts) => {
      capturedCwd = opts.cwd;
      return spawnSuccess(
        JSON.stringify({
          number: 789,
          state: 'MERGED',
          mergedAt: '2026-01-15T10:30:00Z',
          url: 'https://github.com/org/repo/pull/789',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert.strictEqual(capturedCwd, '/custom/work/dir');
  });

  it('should propagate non-hallucination errors', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/999',
        merged: true,
      }),
    };

    mockSpawnSyncFn = () => spawnFailure('Network error: timeout');

    try {
      await executeHook({ hook, agent, result });
      assert.fail('Expected error to be thrown');
    } catch (err) {
      assert.match(err.message, /Network error: timeout/);
    }
  });

  it('should throw when claimed pr_url does not match the branch PR', async function () {
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        pr_url: 'https://github.com/org/repo/pull/111',
        merged: true,
      }),
    };

    mockSpawnSyncFn = () => {
      return spawnSuccess(
        JSON.stringify({
          number: 222,
          state: 'MERGED',
          mergedAt: '2026-01-15T10:30:00Z',
          url: 'https://github.com/org/repo/pull/222',
        })
      );
    };

    await assert.rejects(() => executeHook({ hook, agent, result }), /claimed URL/i);
  });

  it('should verify GitLab merge requests when platform is gitlab', async function () {
    mockPlatformResolver = () => 'gitlab';
    const agent = createMockAgent();
    const hook = { action: 'verify_pull_request' };
    const result = {
      output: JSON.stringify({
        mr_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
        mr_number: 42,
        merged: true,
      }),
    };

    let capturedCmd;
    mockSpawnSyncFn = (command, args) => {
      capturedCmd = commandText(command, args);
      return spawnSuccess(
        JSON.stringify({
          iid: 42,
          state: 'merged',
          merged_at: '2026-02-23T12:00:00Z',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
        })
      );
    };

    await executeHook({ hook, agent, result });
    assert.strictEqual(capturedCmd, 'glab mr view 42 --output json');
    assert.strictEqual(agent.lastPublished.content.data.pr_number, 42);
    assert.strictEqual(agent.lastPublished.content.data.mr_number, 42);
    assert.strictEqual(agent.lastPublished.content.data.verification_platform, 'gitlab');
  });

  // REGRESSION: issue #452 - `--pr` (autoMerge=false) must stop at PR creation.
  // An OPEN, unmerged PR is the SUCCESS case for --pr mode, not a failure.
  describe('review mode (autoMerge=false, --pr without --ship)', () => {
    it('publishes CLUSTER_COMPLETE for an OPEN unmerged PR without polling or failing', async function () {
      const agent = createMockAgent();
      const hook = { action: 'verify_pull_request', config: { autoMerge: false } };
      const result = {
        output: JSON.stringify({
          pr_url: 'https://github.com/org/repo/pull/123',
          pr_number: 123,
          merged: false,
        }),
      };

      let callCount = 0;
      mockSpawnSyncFn = () => {
        callCount++;
        return spawnSuccess(
          JSON.stringify({
            number: 123,
            state: 'OPEN',
            mergedAt: null,
            url: 'https://github.com/org/repo/pull/123',
          })
        );
      };

      await executeHook({ hook, agent, result });

      assert(agent.lastPublished, 'Expected CLUSTER_COMPLETE to be published');
      assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
      assert.strictEqual(agent.lastPublished.content.data.reason, 'git-pusher-complete-verified');
      assert.strictEqual(agent.lastPublished.content.data.pr_number, 123);
      assert.strictEqual(agent.lastPublished.content.data.merged, false);
      assert.strictEqual(
        agent.lastPublished.content.data.verification_pending,
        undefined,
        'review mode is a final success, not a pending state'
      );
      // Only the initial fetch should run - no merge-polling loop for autoMerge=false.
      assert.strictEqual(callCount, 1, `Expected exactly 1 gh call (got ${callCount})`);
    });

    it('treats PR existence as success even if review-mode agent output claims merged:true', async function () {
      const agent = createMockAgent();
      const hook = { action: 'verify_pull_request', config: { autoMerge: false } };
      const result = {
        output: JSON.stringify({
          pr_url: 'https://github.com/org/repo/pull/124',
          pr_number: 124,
          merged: true,
        }),
      };

      let callCount = 0;
      mockSpawnSyncFn = () => {
        callCount++;
        return spawnSuccess(
          JSON.stringify({
            number: 124,
            state: 'OPEN',
            mergedAt: null,
            url: 'https://github.com/org/repo/pull/124',
          })
        );
      };

      await executeHook({ hook, agent, result });

      assert.strictEqual(agent.lastPublished.topic, 'CLUSTER_COMPLETE');
      assert.strictEqual(agent.lastPublished.content.data.reason, 'git-pusher-complete-verified');
      assert.strictEqual(agent.lastPublished.content.data.pr_number, 124);
      assert.strictEqual(agent.lastPublished.content.data.merged, false);
      assert.strictEqual(callCount, 1, `Expected exactly 1 gh call (got ${callCount})`);
    });

    it('fails review mode when GitHub reports the PR is already merged', async function () {
      const agent = createMockAgent();
      const hook = { action: 'verify_pull_request', config: { autoMerge: false } };
      const result = {
        output: JSON.stringify({
          pr_url: 'https://github.com/org/repo/pull/125',
          pr_number: 125,
          merged: false,
        }),
      };

      mockSpawnSyncFn = () =>
        spawnSuccess(
          JSON.stringify({
            number: 125,
            state: 'MERGED',
            mergedAt: '2026-07-08T20:00:00Z',
            url: 'https://github.com/org/repo/pull/125',
          })
        );

      await assert.rejects(
        () => executeHook({ hook, agent, result }),
        /already merged.*review mode \(autoMerge=false\)/i
      );
      assert.strictEqual(agent.lastPublished, null, 'merged review-mode PR must not complete');
    });

    it('still throws when the PR does not exist (hallucination check still applies)', async function () {
      const agent = createMockAgent();
      const hook = { action: 'verify_pull_request', config: { autoMerge: false } };
      const result = {
        output: JSON.stringify({
          pr_url: 'https://github.com/org/repo/pull/9999',
          merged: false,
        }),
      };

      mockSpawnSyncFn = () => spawnFailure('Could not resolve to a PullRequest');

      await assert.rejects(() => executeHook({ hook, agent, result }), /DOES NOT EXIST/);
    });

    it('undefined autoMerge (existing callers) still defaults to merge-required (fail-closed)', async function () {
      const agent = createMockAgent();
      const hook = { action: 'verify_pull_request' }; // no config at all
      const result = {
        output: JSON.stringify({
          pr_url: 'https://github.com/org/repo/pull/123',
          pr_number: 123,
          merged: true,
        }),
      };

      // Always OPEN -> should hit the existing verification-pending path, not the
      // review-mode short-circuit, proving the undefined -> true default held.
      mockSpawnSyncFn = () => {
        return spawnSuccess(
          JSON.stringify({
            number: 123,
            state: 'OPEN',
            mergedAt: null,
            url: 'https://github.com/org/repo/pull/123',
          })
        );
      };

      await executeHook({ hook, agent, result });
      assert.strictEqual(
        agent.lastPublished.content.data.reason,
        'git-pusher-complete-verification-pending'
      );
      assert.strictEqual(agent.lastPublished.content.data.verification_pending, true);
    });
  });
});
