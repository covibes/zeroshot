import chalk = require('chalk');
import eventCopy = require('./event-copy');
import formatterUtils = require('./message-formatter-utils');

const { EVENT_COPY, formatMergeStatus } = eventCopy;
const { formatLifecycleEvent, partitionValidationCriteria } = formatterUtils;

interface CriterionResult {
  status?: string;
  id?: string | number;
  reason?: string;
}

interface NormalMessageData {
  event?: string;
  triggers?: readonly string[];
  triggeredBy?: string | number;
  iteration?: string | number;
  model?: string;
  stack?: string;
  commit?: string;
  approved?: boolean | string;
  criteriaResults?: readonly CriterionResult[];
  reason?: string;
  pr_number?: string | number;
  pr_url?: string;
  merged?: unknown;
}

interface NormalMessage {
  cluster_id?: string;
  topic?: string;
  content?: {
    text?: string;
    data?: NormalMessageData;
  };
}

type PrintLine = (text: string) => void;

function isCriterionResults(value: unknown): value is readonly CriterionResult[] {
  return Array.isArray(value);
}

function formatAgentLifecycle(
  msg: NormalMessage,
  prefix: string,
  print: PrintLine = console.log
): true {
  const { icon, eventText } = formatLifecycleEvent(msg.content?.data);
  print(`${prefix} ${icon} ${eventText}`);
  return true;
}

function formatAgentError(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
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

function formatIssueOpened(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  shownNewTaskForCluster: Set<string | undefined>,
  print: PrintLine = console.log
): true {
  // Skip duplicate - conductor re-publishes after spawning agents
  if (!shownNewTaskForCluster.has(msg.cluster_id)) {
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
  }
  return true;
}

function formatImplementationReady(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
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

function formatValidationResult(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
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
  if (isCriterionResults(criteriaResults)) {
    const { cannotValidateYet, cannotValidate } =
      partitionValidationCriteria(criteriaResults);
    if (cannotValidateYet.length > 0) {
      print(
        `${prefix} ${chalk.red('❌ Cannot validate yet')} (${cannotValidateYet.length} criteria - work incomplete):`
      );
      for (const criterion of cannotValidateYet) {
        print(
          `${prefix}   ${chalk.red('•')} ${criterion.id}: ${criterion.reason || 'No reason provided'}`
        );
      }
    }
    if (cannotValidate.length > 0) {
      print(
        `${prefix} ${chalk.yellow('⚠️ Could not validate')} (${cannotValidate.length} criteria - permanent):`
      );
      for (const criterion of cannotValidate) {
        print(
          `${prefix}   ${chalk.yellow('•')} ${criterion.id}: ${criterion.reason || 'No reason provided'}`
        );
      }
    }
  }
  // Show full JSON data structure
  print(`${prefix} ${chalk.dim(JSON.stringify(data, null, 2).split('\n').join(`\n${prefix} `))}`);
  return true;
}

function formatClusterComplete(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
  print('');
  print(chalk.bold.green(`${'═'.repeat(60)}`));
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.green('🎉 Cluster complete')}`);
  if (msg.content?.data?.reason) {
    print(`${prefix} ${chalk.green(msg.content.data.reason)}`);
  }
  print(chalk.bold.green(`${'═'.repeat(60)}`));
  return true;
}

function formatClusterFailed(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
  print('');
  print(chalk.bold.red(`${'═'.repeat(60)}`));
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.red('Error: cluster failed')}`);
  if (msg.content?.text) print(`${prefix} ${chalk.red(msg.content.text)}`);
  if (msg.content?.data?.reason) print(`${prefix} ${chalk.red(msg.content.data.reason)}`);
  print(`${prefix} Next: inspect the cluster logs, then resume after fixing the cause.`);
  print(chalk.bold.red(`${'═'.repeat(60)}`));
  return true;
}

function formatPrCreated(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
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
    const formattedMergeStatus =
      mergeStatus === 'merged' ? chalk.green(mergeStatus) : chalk.yellow(mergeStatus);
    print(`${prefix} ${chalk.gray('Merge:')} ${formattedMergeStatus}`);
  }
  print(chalk.bold.green(`${'─'.repeat(60)}`));
  return true;
}

function formatGenericMessage(
  msg: NormalMessage,
  prefix: string,
  timestamp: string,
  print: PrintLine = console.log
): true {
  print(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold(msg.topic)}`);
  if (msg.content?.text) {
    print(`${prefix} ${msg.content.text}`);
  }
  return true;
}

export = {
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
