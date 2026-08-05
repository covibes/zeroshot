const chalk = require('chalk');
const {
  buildClusterPrefix,
  getColorForSender,
  parseDataField,
} = require('./message-formatter-utils');
const { EVENT_COPY, formatMergeStatus } = require('./event-copy');

const DEFAULT_WRITER = Object.freeze({ printLine: (text) => console.log(text) });

function formatAgentError(msg, clusterPrefix, writer) {
  writer.printLine(`${clusterPrefix} ${chalk.bold.red(`Error: ${msg.sender}`)}`);
  if (msg.content?.text) {
    writer.printLine(`${clusterPrefix}   ${chalk.red(msg.content.text)}`);
  }
  writer.printLine(`${clusterPrefix}   Next: zeroshot logs ${msg.cluster_id} -f`);
}

function formatIssueOpened(msg, clusterPrefix, writer) {
  const issueNum = msg.content?.data?.issue_number || '';
  const title = msg.content?.data?.title || '';
  const prompt = msg.content?.data?.prompt || msg.content?.text || '';
  const taskDesc = title === 'Manual Input' && prompt ? prompt : title;
  const truncatedDesc =
    taskDesc && taskDesc.length > 60 ? `${taskDesc.substring(0, 60)}...` : taskDesc;
  const eventText = `Started ${issueNum ? `#${issueNum}` : 'task'}${truncatedDesc ? chalk.dim(` - ${truncatedDesc}`) : ''}`;
  writer.printLine(`${clusterPrefix} ${eventText}`);
}

function formatImplementationReady(msg, clusterPrefix, writer = DEFAULT_WRITER) {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  writer.printLine(
    `${clusterPrefix} ${agentName} ${EVENT_COPY.IMPLEMENTATION_READY.toLowerCase()}`
  );
}

function printRejectionDetails(data, clusterPrefix, writer) {
  const errors = parseDataField(data.errors);
  const issues = parseDataField(data.issues);
  if (errors.length > 0) {
    const count = JSON.stringify(errors).length;
    writer.printLine(
      `${clusterPrefix}   ${chalk.red('•')} ${errors.length} error${errors.length > 1 ? 's' : ''} (${count} chars)`
    );
  }
  if (issues.length > 0) {
    const count = JSON.stringify(issues).length;
    writer.printLine(
      `${clusterPrefix}   ${chalk.yellow('•')} ${issues.length} issue${issues.length > 1 ? 's' : ''} (${count} chars)`
    );
  }
}

function formatValidationResult(msg, clusterPrefix, writer) {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  const data = msg.content?.data;
  const approved = data?.approved === 'true' || data?.approved === true;
  const status = approved ? chalk.green('Approved') : chalk.red('Rejected');
  let eventText = `${agentName} ${status}`;
  if (data?.summary && !approved) eventText += chalk.dim(` - ${data.summary}`);
  writer.printLine(`${clusterPrefix} ${eventText}`);
  if (!approved) printRejectionDetails(data, clusterPrefix, writer);
}

function formatPrCreated(msg, clusterPrefix, writer = DEFAULT_WRITER) {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  const prNum = msg.content?.data?.pr_number || '';
  let eventText = `${agentName} ${EVENT_COPY.PR_CREATED.toLowerCase()}${prNum ? ` #${prNum}` : ''}`;
  const mergeStatus = formatMergeStatus(msg.content?.data?.merged);
  if (mergeStatus) eventText += chalk.dim(` — ${mergeStatus}`);
  writer.printLine(`${clusterPrefix} ${eventText}`);
}

function formatPrMerged(msg, clusterPrefix, writer) {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  writer.printLine(`${clusterPrefix} ${agentName} merged PR`);
}

function formatUnknownTopic(msg, clusterPrefix, writer) {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  const eventText = `${agentName} ${msg.topic.toLowerCase().replace(/_/g, ' ')}`;
  writer.printLine(`${clusterPrefix} ${eventText}`);
}

function formatWatchMode(msg, isActive, writer = DEFAULT_WRITER) {
  if (msg.topic === 'AGENT_OUTPUT' || msg.topic === 'AGENT_LIFECYCLE') return true;
  const clusterPrefix = buildClusterPrefix(msg.cluster_id, isActive);
  const handlers = {
    AGENT_ERROR: formatAgentError,
    ISSUE_OPENED: formatIssueOpened,
    IMPLEMENTATION_READY: formatImplementationReady,
    VALIDATION_RESULT: formatValidationResult,
    PR_CREATED: formatPrCreated,
    PR_MERGED: formatPrMerged,
  };
  (handlers[msg.topic] || formatUnknownTopic)(msg, clusterPrefix, writer);
  return true;
}

module.exports = {
  formatWatchMode,
  formatImplementationReady,
  formatPrCreated,
};
