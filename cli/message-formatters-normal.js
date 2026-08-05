/**
 * Normal mode message formatters
 * Full-detail message display for non-watch mode
 *
 * All functions accept an optional `print` parameter for output routing.
 * When StatusFooter is active, pass safePrint to avoid terminal garbling.
 */

const chalk = require('chalk');
const { EVENT_COPY, formatMergeStatus } = require('./event-copy');

/**
 * Format AGENT_LIFECYCLE events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatAgentLifecycle(msg, prefix, print = console.log) {
  const data = msg.content?.data;
  const event = data?.event;

  let icon, eventText;
  switch (event) {
    case 'STARTED':
      icon = chalk.green('▶');
      const triggers = data.triggers?.join(', ') || 'none';
      eventText = `started (listening for: ${chalk.dim(triggers)})`;
      break;
    case 'TASK_STARTED':
      icon = chalk.yellow('⚡');
      eventText = `${chalk.cyan(data.triggeredBy)} → task #${data.iteration} (${chalk.dim(data.model)})`;
      break;
    case 'TASK_COMPLETED':
      icon = chalk.green('✓');
      eventText = `task #${data.iteration} completed`;
      break;
    default:
      icon = chalk.dim('•');
      eventText = event || 'unknown event';
  }

  print(`${prefix} ${icon} ${eventText}`);
  return true;
}

/**
 * Format AGENT_ERROR events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatAgentError(msg, prefix, timestamp, print = console.log) {
  print('');
  print(chalk.bold.red(`${'─'.repeat(60)}`));
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.red('Error: agent failed')}`);

  if (msg.content?.text) {
    print(`${prefix} ${chalk.red(msg.content.text)}`);
  }

  if (msg.content?.data?.stack) {
    const stackLines = msg.content.data.stack.split('\n').slice(0, 5);
    for (const line of stackLines) {
      if (line.trim()) print(`${prefix} ${chalk.dim(line)}`);
    }
  }

  print(`${prefix} Next: inspect the agent logs and retry after fixing the cause.`);
  print(chalk.bold.red(`${'─'.repeat(60)}`));
  return true;
}

/**
 * Format ISSUE_OPENED events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Set} shownNewTaskForCluster - Set tracking shown tasks
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatIssueOpened(msg, prefix, timestamp, shownNewTaskForCluster, print = console.log) {
  // Skip duplicate - conductor re-publishes after spawning agents
  if (shownNewTaskForCluster.has(msg.cluster_id)) {
    return true;
  }
  shownNewTaskForCluster.add(msg.cluster_id);

  print('');
  print(chalk.bold.blue(`${'─'.repeat(60)}`));
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.blue('📋 New task')}`);

  if (msg.content?.text) {
    const lines = msg.content.text.split('\n').slice(0, 3);
    for (const line of lines) {
      if (line.trim() && line.trim() !== '# Manual Input') {
        print(`${prefix} ${chalk.white(line)}`);
      }
    }
  }

  print(chalk.bold.blue(`${'─'.repeat(60)}`));
  return true;
}

/**
 * Format IMPLEMENTATION_READY events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatImplementationReady(msg, prefix, timestamp, print = console.log) {
  print(
    `${prefix} ${chalk.gray(timestamp)} ${chalk.bold.yellow(`✅ ${EVENT_COPY.IMPLEMENTATION_READY.toUpperCase()}`)}`
  );

  if (msg.content?.data?.commit) {
    print(
      `${prefix} ${chalk.gray('Commit:')} ${chalk.cyan(msg.content.data.commit.substring(0, 8))}`
    );
  }

  return true;
}

/**
 * Format VALIDATION_RESULT events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatValidationResult(msg, prefix, timestamp, print = console.log) {
  const data = msg.content?.data || {};
  const approved = data.approved === true || data.approved === 'true';
  const status = approved ? chalk.bold.green('✓ Approved') : chalk.bold.red('✗ Rejected');

  print(`${prefix} ${chalk.gray(timestamp)} ${status}`);

  // Show summary if present and not a template variable
  if (msg.content?.text && !msg.content.text.includes('{{')) {
    print(`${prefix} ${msg.content.text.substring(0, 100)}`);
  }

  // Show CANNOT_VALIDATE (permanent) as warnings, CANNOT_VALIDATE_YET (temporary) as errors
  const criteriaResults = data.criteriaResults;
  if (Array.isArray(criteriaResults)) {
    // CANNOT_VALIDATE_YET = temporary, treated as FAIL (work incomplete)
    const cannotValidateYet = criteriaResults.filter((c) => c.status === 'CANNOT_VALIDATE_YET');
    if (cannotValidateYet.length > 0) {
      print(
        `${prefix} ${chalk.red('❌ Cannot validate yet')} (${cannotValidateYet.length} criteria - work incomplete):`
      );
      for (const cv of cannotValidateYet) {
        print(`${prefix}   ${chalk.red('•')} ${cv.id}: ${cv.reason || 'No reason provided'}`);
      }
    }

    // CANNOT_VALIDATE = permanent, treated as PASS (environmental limitation)
    const cannotValidate = criteriaResults.filter((c) => c.status === 'CANNOT_VALIDATE');
    if (cannotValidate.length > 0) {
      print(
        `${prefix} ${chalk.yellow('⚠️ Could not validate')} (${cannotValidate.length} criteria - permanent):`
      );
      for (const cv of cannotValidate) {
        print(`${prefix}   ${chalk.yellow('•')} ${cv.id}: ${cv.reason || 'No reason provided'}`);
      }
    }
  }

  // Show full JSON data structure
  print(`${prefix} ${chalk.dim(JSON.stringify(data, null, 2).split('\n').join(`\n${prefix} `))}`);

  return true;
}

/**
 * Format CLUSTER_COMPLETE events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatClusterComplete(msg, prefix, timestamp, print = console.log) {
  print('');
  print(chalk.bold.green(`${'═'.repeat(60)}`));
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.green('🎉 Cluster complete')}`);
  if (msg.content?.data?.reason) {
    print(`${prefix} ${chalk.green(msg.content.data.reason)}`);
  }
  print(chalk.bold.green(`${'═'.repeat(60)}`));
  return true;
}

/**
 * Format CLUSTER_FAILED events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatClusterFailed(msg, prefix, timestamp, print = console.log) {
  print('');
  print(chalk.bold.red(`${'═'.repeat(60)}`));
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.red('Error: cluster failed')}`);
  if (msg.content?.text) print(`${prefix} ${chalk.red(msg.content.text)}`);
  if (msg.content?.data?.reason) print(`${prefix} ${chalk.red(msg.content.data.reason)}`);
  print(`${prefix} Next: inspect the cluster logs, then resume after fixing the cause.`);
  print(chalk.bold.red(`${'═'.repeat(60)}`));
  return true;
}

/**
 * Format PR_CREATED events
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatPrCreated(msg, prefix, timestamp, print = console.log) {
  const prNumber = msg.content?.data?.pr_number || '';
  const prUrl = msg.content?.data?.pr_url || '';

  print(''); // Blank line before PR notification
  print(chalk.bold.green(`${'─'.repeat(60)}`));
  print(
    `${prefix} ${chalk.gray(timestamp)} ${chalk.bold.green(`🎉 ${EVENT_COPY.PR_CREATED.toUpperCase()}`)}`
  );

  if (prNumber) {
    print(`${prefix} ${chalk.gray('PR:')} ${chalk.cyan(`#${prNumber}`)}`);
  }
  if (prUrl) {
    print(`${prefix} ${chalk.gray('URL:')} ${chalk.blue(prUrl)}`);
  }

  const mergeStatus = formatMergeStatus(msg.content?.data?.merged);
  if (mergeStatus) {
    print(
      `${prefix} ${chalk.gray('Merge:')} ${mergeStatus === 'merged' ? chalk.green(mergeStatus) : chalk.yellow(mergeStatus)}`
    );
  }

  print(chalk.bold.green(`${'─'.repeat(60)}`));
  return true;
}

/**
 * Format generic messages (fallback)
 * @param {Object} msg - Message object
 * @param {string} prefix - Formatted message prefix
 * @param {string} timestamp - Formatted timestamp
 * @param {Function} [print=console.log] - Print function for output
 * @returns {boolean} True if message was handled
 */
function formatGenericMessage(msg, prefix, timestamp, print = console.log) {
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold(msg.topic)}`);
  if (msg.content?.text) {
    print(`${prefix} ${msg.content.text}`);
  }
  return true;
}

module.exports = {
  formatAgentLifecycle,
  formatAgentError,
  formatIssueOpened,
  formatImplementationReady,
  formatValidationResult,
  formatPrCreated,
  formatClusterComplete,
  formatClusterFailed,
  formatGenericMessage,
};
