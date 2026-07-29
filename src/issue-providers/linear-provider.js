/**
 * Linear Provider - Fetch issues from Linear via GraphQL API
 * Linear is not a git host; no CLI binary required (talks to api.linear.app directly)
 */

const IssueProvider = require('./base-provider');

const AUTH_CHECK_TIMEOUT_MS = 2000;
const FETCH_TIMEOUT_MS = 10000;
const LINEAR_API_URL = 'https://api.linear.app/graphql';
const LINEAR_URL_PATTERN = /linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)/;
const LINEAR_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

class LinearProvider extends IssueProvider {
  static id = 'linear';
  static displayName = 'Linear';

  /**
   * Detect Linear issue keys and URLs
   * Matches:
   * - Linear issue URLs (linear.app/<workspace>/issue/<TEAM>-<n>/...)
   * - Linear issue keys (TEAM-123 format)
   * - Bare numbers when defaultIssueSource=linear (requires linearTeam setting)
   *
   * Note: Linear doesn't use git context since it's not a git hosting platform.
   * Git context will never match 'linear', so this provider only activates via
   * explicit Linear URLs, Linear issue keys, or settings.
   *
   * Note: Linear and Jira share the same KEY-NUMBER key format (e.g. ENG-42 vs
   * PROJ-123), so a bare key is ambiguous between the two providers. This is
   * resolved by configuration, not registration order: JiraProvider.detectIdentifier
   * defers to Linear for KEY-NUMBER input when Linear is configured
   * (linearApiKey/linearTeam) and Jira is not. If neither or both are configured,
   * Jira wins by registration order. Use --linear or defaultIssueSource=linear
   * for unambiguous Linear selection regardless of configuration.
   *
   * @param {string} input - Issue identifier (URL, key, or number)
   * @param {Object} settings - User settings
   * @param {Object|null} gitContext - Git context (unused for Linear, but kept for API consistency)
   * @returns {boolean} True if this provider should handle the input
   */
  static detectIdentifier(input, settings, gitContext = null) {
    // Linear issue URLs
    if (LINEAR_URL_PATTERN.test(input)) {
      return true;
    }

    // Linear issue key pattern (TEAM-123)
    if (LINEAR_KEY_PATTERN.test(input)) {
      return true;
    }

    // Bare numbers - use shared priority cascade logic
    // Linear requires linearTeam setting to convert bare numbers to issue keys
    // Note: gitContext check will never match 'linear' since Linear isn't a git host
    return IssueProvider.detectBareNumber(input, settings, gitContext, 'linear', {
      requiredSettings: ['linearTeam'],
    });
  }

  static getRequiredTool() {
    // No CLI binary required - talks to Linear's GraphQL API directly via fetch
    return {
      name: null,
      checkCmd: null,
      installHint: null,
    };
  }

  /**
   * Validate response status and parse GraphQL JSON body.
   * Shared by checkAuth and fetchIssue so both surface 401/429/non-OK/invalid-body
   * failures the same way instead of falling through to a generic JSON-parse error.
   * @private
   */
  static async _handleGraphQLResponse(response) {
    if (response.status === 401) {
      throw new Error('Linear API key invalid');
    }

    if (response.status === 429) {
      throw new Error('Linear API rate limit exceeded, try again later');
    }

    if (!response.ok) {
      throw new Error(`Linear API request failed with status ${response.status}`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error(`Linear API returned an invalid response (status ${response.status})`);
    }
  }

  /**
   * Resolve the Linear API key: settings-owned, with env var fallback.
   * @param {Object} [settings] - User settings (may be undefined/null)
   * @returns {string|null}
   */
  static _resolveApiKey(settings) {
    return settings?.linearApiKey || process.env.LINEAR_API_KEY || null;
  }

  /**
   * Recovery hints pointing at the settings-based fix for a missing/invalid key.
   * @returns {string[]}
   */
  static _recoveryHints() {
    return [
      'Set it: zeroshot settings set linearApiKey <key>',
      'Get a key at https://linear.app/settings/api',
      'Or export LINEAR_API_KEY=lin_api_...',
    ];
  }

  /**
   * Check Linear API key authentication via a minimal GraphQL query
   */
  static async checkAuth() {
    // Lazy require avoids circular dependency (settings.js lazy-loads issue-providers).
    const { loadSettings } = require('../../lib/settings');
    const apiKey = LinearProvider._resolveApiKey(loadSettings());

    if (!apiKey) {
      return {
        authenticated: false,
        error: 'Linear API key not configured',
        recovery: LinearProvider._recoveryHints(),
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AUTH_CHECK_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(LINEAR_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: apiKey,
          },
          body: JSON.stringify({ query: '{ viewer { id } }' }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const json = await LinearProvider._handleGraphQLResponse(response);
      if (json.errors) {
        return {
          authenticated: false,
          error: 'Linear API key invalid',
          recovery: ['Verify LINEAR_API_KEY at https://linear.app/settings/api'],
        };
      }

      return { authenticated: true, error: null, recovery: [] };
    } catch (err) {
      if (err.message === 'Linear API key invalid') {
        return {
          authenticated: false,
          error: err.message,
          recovery: ['Verify LINEAR_API_KEY at https://linear.app/settings/api'],
        };
      }

      return {
        authenticated: false,
        error: err.message,
        recovery: ['Check network connectivity', 'Verify https://api.linear.app is reachable'],
      };
    }
  }

  /**
   * Linear-specific settings schema
   */
  static getSettingsSchema() {
    return {
      linearTeam: {
        type: 'string',
        nullable: true,
        default: null,
        description: "Default Linear team key for bare numbers (e.g., 'ENG')",
        pattern: /^[A-Z][A-Z0-9]*$/,
        patternMsg: 'linearTeam must be a valid Linear team key (e.g., ENG, PROJ)',
      },
      linearApiKey: {
        type: 'string',
        nullable: true,
        default: null,
        description: 'Linear personal API key (get one at https://linear.app/settings/api)',
      },
    };
  }

  /**
   * Fetch the workspace's Linear teams and, if there's exactly one, persist its
   * key as `linearTeam` so future bare-number runs skip this round-trip.
   * @private
   */
  static async _resolveTeamKey(apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(LINEAR_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey,
        },
        body: JSON.stringify({ query: '{ teams { nodes { key } } }' }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const json = await LinearProvider._handleGraphQLResponse(response);
    if (json.errors) {
      throw new Error(json.errors.map((e) => e.message).join('; '));
    }

    const teams = json.data?.teams?.nodes || [];
    if (teams.length === 0) {
      throw new Error('No Linear teams found for this API key.');
    }
    if (teams.length > 1) {
      const keys = teams.map((t) => t.key).join(', ');
      throw new Error(
        `Multiple Linear teams found (${keys}). Set one: zeroshot settings set linearTeam <KEY>`
      );
    }

    const key = teams[0].key;
    const { mutateSettings } = require('../../lib/settings');
    mutateSettings((current) => {
      current.linearTeam = key;
    });
    return key;
  }

  /**
   * Resolve the issue key, auto-deriving `linearTeam` for bare numbers when it
   * isn't configured yet.
   * @private
   */
  async _resolveIssueKey(identifier, settings, apiKey) {
    if (/^\d+$/.test(identifier) && !settings.linearTeam) {
      const team = await LinearProvider._resolveTeamKey(apiKey);
      return `${team}-${identifier}`;
    }
    return this._extractIssueKey(identifier, settings);
  }

  async fetchIssue(identifier, settings) {
    const apiKey = LinearProvider._resolveApiKey(settings);
    if (!apiKey) {
      throw new Error(
        `Failed to fetch Linear issue: Linear API key not configured. ${LinearProvider._recoveryHints().join(' ')}`
      );
    }

    try {
      const issueKey = await this._resolveIssueKey(identifier, settings, apiKey);

      const query = `
      query($id: String!) {
        issue(id: $id) {
          identifier
          number
          title
          description
          url
          # Linear defaults to a 50-node first page with no pagination here; long
          # label sets or comment threads beyond that are silently truncated.
          labels {
            nodes {
              name
            }
          }
          comments {
            nodes {
              user {
                name
              }
              createdAt
              body
            }
          }
        }
      }
    `;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(LINEAR_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: apiKey,
          },
          body: JSON.stringify({ query, variables: { id: issueKey } }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const json = await LinearProvider._handleGraphQLResponse(response);

      if (json.errors) {
        throw new Error(json.errors.map((e) => e.message).join('; '));
      }

      if (!json.data?.issue) {
        throw new Error(`Linear issue not found: ${issueKey}`);
      }

      return this._parseIssue(json.data.issue);
    } catch (error) {
      throw new Error(`Failed to fetch Linear issue: ${error.message}`);
    }
  }

  /**
   * Extract Linear issue key from URL or return as-is
   * @private
   */
  _extractIssueKey(identifier, settings) {
    // URL format: https://linear.app/<workspace>/issue/TEAM-123/...
    const urlMatch = identifier.match(LINEAR_URL_PATTERN);
    if (urlMatch) {
      return urlMatch[1];
    }

    // Bare number: construct from linearTeam setting
    if (/^\d+$/.test(identifier) && settings.linearTeam) {
      return `${settings.linearTeam}-${identifier}`;
    }

    // Assume it's already a key
    return identifier;
  }

  /**
   * Parse Linear issue into standardized InputData format
   * @private
   */
  _parseIssue(issue) {
    const labels = issue.labels?.nodes || [];
    const comments = issue.comments?.nodes || [];
    const description = issue.description || '';

    let context = `# Linear Issue ${issue.identifier}\n\n`;
    context += `## Title\n${issue.title}\n\n`;

    if (description) {
      context += `## Description\n${description}\n\n`;
    }

    if (labels.length > 0) {
      context += `## Labels\n`;
      context += labels.map((l) => `- ${l.name}`).join('\n');
      context += '\n\n';
    }

    if (comments.length > 0) {
      context += `## Comments\n\n`;
      for (const comment of comments) {
        const author = comment.user?.name || 'unknown';
        context += `### ${author} (${comment.createdAt})\n`;
        context += `${comment.body}\n\n`;
      }
    }

    const mappedLabels = labels.map((l) => ({ name: l.name }));
    const mappedComments = comments.map((c) => ({
      author: { login: c.user?.name || 'unknown' },
      createdAt: c.createdAt,
      body: c.body,
    }));

    return {
      number: issue.number,
      title: issue.title,
      body: description,
      labels: mappedLabels,
      comments: mappedComments,
      url: issue.url || null,
      context,
    };
  }
}

module.exports = LinearProvider;
