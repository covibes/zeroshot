/**
 * Jira Provider - Fetch issues from Jira via jira CLI (go-jira)
 * Supports both Jira Cloud (*.atlassian.net) and self-hosted (Server/Data Center)
 */

const IssueProvider = require('./base-provider');
const { execSync } = require('../lib/safe-exec');

const AUTH_CHECK_TIMEOUT_MS = 2000;

class JiraProvider extends IssueProvider {
  static id = 'jira';
  static displayName = 'Jira';

  /**
   * Detect Jira issue keys and URLs
   * Matches:
   * - Jira Cloud URLs (*.atlassian.net)
   * - Self-hosted Jira URLs (via jiraInstance setting)
   * - Jira issue keys (KEY-123 format)
   * - Bare numbers when defaultIssueSource=jira (requires jiraProject setting)
   *
   * Note: Jira doesn't use git context since it's not a git hosting platform.
   * Git context will never match 'jira', so this provider only activates via
   * explicit Jira URLs, Jira issue keys, or settings.
   *
   * @param {string} input - Issue identifier (URL, key, or number)
   * @param {Object} settings - User settings
   * @param {Object|null} gitContext - Git context (unused for Jira, but kept for API consistency)
   * @returns {boolean} True if this provider should handle the input
   */
  static detectIdentifier(input, settings, gitContext = null) {
    // Jira Cloud URLs
    if (/atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+/.test(input)) {
      return true;
    }

    // Self-hosted Jira URLs
    if (
      settings.jiraInstance &&
      input.includes(settings.jiraInstance) &&
      /\/browse\/[A-Z][A-Z0-9]+-\d+/.test(input)
    ) {
      return true;
    }

    // Jira issue key pattern (KEY-123) - shared with Linear (ENG-42 vs PROJ-123).
    // Defer to Linear when it's configured and Jira isn't, so the sole
    // configured tracker wins instead of registration order.
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(input)) {
      const jiraConfigured = !!(settings.jiraInstance || settings.jiraProject);
      const linearConfigured = !!(settings.linearApiKey || settings.linearTeam);
      if (!jiraConfigured && linearConfigured) {
        return false;
      }
      return true;
    }

    // Bare numbers - use shared priority cascade logic
    // Jira requires jiraProject setting to convert bare numbers to issue keys
    // Note: gitContext check will never match 'jira' since Jira isn't a git host
    return IssueProvider.detectBareNumber(input, settings, gitContext, 'jira', {
      requiredSettings: ['jiraProject'],
    });
  }

  static getRequiredTool() {
    return {
      name: 'jira',
      checkCmd: 'jira version',
      installHint: 'Install jira-cli: brew install go-jira (or https://github.com/go-jira/jira)',
    };
  }

  /**
   * Check jira CLI authentication
   * go-jira uses config files (~/.jira.d/) rather than explicit auth commands
   */
  static checkAuth() {
    try {
      // go-jira uses 'jira session' to verify authentication
      // If not configured, it fails with endpoint/login errors
      execSync('jira session', { encoding: 'utf8', stdio: 'pipe', timeout: AUTH_CHECK_TIMEOUT_MS });
      return { authenticated: true, error: null, recovery: [] };
    } catch (err) {
      const stderr = err.stderr || err.message || '';

      if (err.code === 'ENOENT' || stderr.includes('command not found')) {
        return {
          authenticated: false,
          error: 'Jira CLI not installed',
          recovery: [
            'Install jira CLI: https://github.com/go-jira/jira',
            'Then verify: jira version',
          ],
        };
      }

      if (stderr.includes('Command timed out')) {
        return {
          authenticated: false,
          error: 'jira session timed out',
          recovery: ['Retry: jira session', 'Check ~/.jira.d/config.yml for endpoint/login'],
        };
      }

      // go-jira has various error patterns for auth issues
      if (
        stderr.includes('endpoint') ||
        stderr.includes('login') ||
        stderr.includes('authentication') ||
        stderr.includes('401')
      ) {
        return {
          authenticated: false,
          error: 'Jira CLI not configured',
          recovery: [
            'Create ~/.jira.d/config.yml with your Jira endpoint',
            'See: https://github.com/go-jira/jira#configuration',
            'Example config:\n   endpoint: https://yourcompany.atlassian.net\n   login: your-email@company.com',
            'Then verify: jira session',
          ],
        };
      }

      // If command just doesn't exist or times out, it's likely not configured
      if (stderr.includes('command not found') || stderr.includes('ETIMEDOUT')) {
        return {
          authenticated: false,
          error: 'Jira CLI not configured',
          recovery: [
            'Configure ~/.jira.d/config.yml',
            'See: https://github.com/go-jira/jira#configuration',
          ],
        };
      }

      // Default: assume not authenticated
      return {
        authenticated: false,
        error: stderr.trim() || 'Jira CLI not configured or authentication failed',
        recovery: [
          'Create ~/.jira.d/config.yml with your Jira endpoint',
          'See: https://github.com/go-jira/jira#configuration',
        ],
      };
    }
  }

  /**
   * Jira-specific settings schema
   */
  static getSettingsSchema() {
    return {
      jiraInstance: {
        type: 'string',
        nullable: true,
        default: null,
        description: "Self-hosted Jira URL (e.g., 'jira.company.com')",
      },
      jiraProject: {
        type: 'string',
        nullable: true,
        default: null,
        description: "Default Jira project key for bare numbers (e.g., 'PROJ')",
        pattern: /^[A-Z][A-Z0-9]*$/,
        patternMsg: 'jiraProject must be a valid Jira project key (e.g., PROJ, ABC)',
      },
    };
  }

  fetchIssue(identifier, settings) {
    try {
      const issueKey = this._extractIssueKey(identifier, settings);

      // Fetch issue using jira CLI
      const cmd = `jira view ${issueKey} --template json`;
      const output = execSync(cmd, { encoding: 'utf8' });
      const issue = JSON.parse(output);

      return this._parseIssue(issue);
    } catch (error) {
      throw new Error(`Failed to fetch Jira issue: ${error.message}`);
    }
  }

  /**
   * Extract Jira issue key from URL or return as-is
   * @private
   */
  _extractIssueKey(identifier, settings) {
    // URL format: https://company.atlassian.net/browse/KEY-123
    const urlMatch = identifier.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (urlMatch) {
      return urlMatch[1];
    }

    // Bare number: construct from jiraProject setting
    if (/^\d+$/.test(identifier) && settings.jiraProject) {
      return `${settings.jiraProject}-${identifier}`;
    }

    // Assume it's already a key
    return identifier;
  }

  /**
   * Parse Jira issue into standardized InputData format
   * @private
   */
  _parseIssue(issue) {
    const fields = issue.fields || {};
    const key = issue.key;
    const summary = fields.summary || '';
    const description = fields.description || '';
    const labels = fields.labels || [];
    const comments = fields.comment?.comments || [];

    let context = `# Jira Issue ${key}\n\n`;
    context += `## Title\n${summary}\n\n`;

    if (description) {
      context += `## Description\n${description}\n\n`;
    }

    if (labels.length > 0) {
      context += `## Labels\n`;
      context += labels.map((l) => `- ${l}`).join('\n');
      context += '\n\n';
    }

    if (comments.length > 0) {
      context += `## Comments\n\n`;
      for (const comment of comments) {
        const author = comment.author?.displayName || comment.author?.name || 'unknown';
        context += `### ${author} (${comment.created})\n`;
        context += `${comment.body}\n\n`;
      }
    }

    // Map Jira labels to GitHub format
    const mappedLabels = labels.map((name) => ({ name }));

    // Map Jira comments to GitHub format
    const mappedComments = comments.map((comment) => ({
      author: { login: comment.author?.displayName || comment.author?.name || 'unknown' },
      createdAt: comment.created,
      body: comment.body,
    }));

    // Extract issue number from key (KEY-123 → 123)
    const numberMatch = key.match(/-(\d+)$/);
    const number = numberMatch ? parseInt(numberMatch[1], 10) : null;

    return {
      number,
      title: summary,
      body: description,
      labels: mappedLabels,
      comments: mappedComments,
      url: fields.self || null,
      context,
    };
  }
}

module.exports = JiraProvider;
