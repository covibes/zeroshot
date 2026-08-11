import chalk = require('chalk');
import formatterUtils = require('./message-formatter-utils');
import eventCopy = require('./event-copy');

const { buildClusterPrefix, getColorForSender, parseDataField } = formatterUtils;
const { EVENT_COPY, formatMergeStatus } = eventCopy;

interface WatchMessageData {
  issue_number?: string | number;
  title?: string;
  prompt?: string;
  approved?: boolean | string;
  summary?: string;
  errors?: unknown;
  issues?: unknown;
  pr_number?: string | number;
  merged?: unknown;
}

interface WatchMessage {
  sender: string;
  cluster_id: string;
  topic: string;
  content?: {
    text?: string;
    data?: WatchMessageData;
  };
}

interface LineWriter {
  printLine(text: string): void;
}

type WatchMessageHandler = (
  message: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter
) => void;

interface CountableData {
  readonly length: number;
}

const DEFAULT_WRITER: Readonly<LineWriter> = Object.freeze({
  printLine: (text: string) => console.log(text),
});

function isCountableData(value: unknown): value is CountableData {
  if (typeof value === 'string') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    'length' in value &&
    typeof value.length === 'number'
  );
}

function formatAgentError(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter
): void {
  writer.printLine(`${clusterPrefix} ${chalk.bold.red(`Error: ${msg.sender}`)}`);
  if (msg.content?.text) {
    writer.printLine(`${clusterPrefix}   ${chalk.red(msg.content.text)}`);
  }
  writer.printLine(`${clusterPrefix}   Next: zeroshot logs ${msg.cluster_id} -f`);
}

function formatIssueOpened(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter
): void {
  const issueNum = msg.content?.data?.issue_number || '';
  const title = msg.content?.data?.title || '';
  const prompt = msg.content?.data?.prompt || msg.content?.text || '';
  const taskDesc = title === 'Manual Input' && prompt ? prompt : title;
  const truncatedDesc =
    taskDesc && taskDesc.length > 60 ? `${taskDesc.substring(0, 60)}...` : taskDesc;
  const issueLabel = issueNum ? `#${issueNum}` : 'task';
  const description = truncatedDesc ? chalk.dim(` - ${truncatedDesc}`) : '';
  const eventText = `Started ${issueLabel}${description}`;
  writer.printLine(`${clusterPrefix} ${eventText}`);
}

function formatImplementationReady(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter = DEFAULT_WRITER
): void {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  writer.printLine(
    `${clusterPrefix} ${agentName} ${EVENT_COPY.IMPLEMENTATION_READY.toLowerCase()}`
  );
}

function printRejectionDetails(
  data: WatchMessageData,
  clusterPrefix: string,
  writer: LineWriter
): void {
  const errors = parseDataField(data.errors);
  const issues = parseDataField(data.issues);
  if (isCountableData(errors) && errors.length > 0) {
    const count = JSON.stringify(errors).length;
    writer.printLine(
      `${clusterPrefix}   ${chalk.red('•')} ${errors.length} error${errors.length > 1 ? 's' : ''} (${count} chars)`
    );
  }
  if (isCountableData(issues) && issues.length > 0) {
    const count = JSON.stringify(issues).length;
    writer.printLine(
      `${clusterPrefix}   ${chalk.yellow('•')} ${issues.length} issue${issues.length > 1 ? 's' : ''} (${count} chars)`
    );
  }
}

function formatValidationResult(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter
): void {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  const data = msg.content?.data;
  const approved = data?.approved === 'true' || data?.approved === true;
  const status = approved ? chalk.green('Approved') : chalk.red('Rejected');
  let eventText = `${agentName} ${status}`;
  if (data?.summary && !approved) eventText += chalk.dim(` - ${data.summary}`);
  writer.printLine(`${clusterPrefix} ${eventText}`);
  if (!approved && data) printRejectionDetails(data, clusterPrefix, writer);
}

function formatPrCreated(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter = DEFAULT_WRITER
): void {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  const prNum = msg.content?.data?.pr_number || '';
  let eventText = `${agentName} ${EVENT_COPY.PR_CREATED.toLowerCase()}${prNum ? ` #${prNum}` : ''}`;
  const mergeStatus = formatMergeStatus(msg.content?.data?.merged);
  if (mergeStatus) eventText += chalk.dim(` — ${mergeStatus}`);
  writer.printLine(`${clusterPrefix} ${eventText}`);
}

function formatPrMerged(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter
): void {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  writer.printLine(`${clusterPrefix} ${agentName} merged PR`);
}

function formatUnknownTopic(
  msg: WatchMessage,
  clusterPrefix: string,
  writer: LineWriter
): void {
  const agentName = getColorForSender(msg.sender)(msg.sender);
  const eventText = `${agentName} ${msg.topic.toLowerCase().replace(/_/g, ' ')}`;
  writer.printLine(`${clusterPrefix} ${eventText}`);
}

function formatWatchMode(
  msg: WatchMessage,
  isActive: boolean,
  writer: LineWriter = DEFAULT_WRITER
): true {
  if (msg.topic === 'AGENT_OUTPUT' || msg.topic === 'AGENT_LIFECYCLE') return true;
  const clusterPrefix = buildClusterPrefix(msg.cluster_id, isActive);
  const handlers: Readonly<Record<string, WatchMessageHandler>> = {
    AGENT_ERROR: formatAgentError,
    ISSUE_OPENED: formatIssueOpened,
    IMPLEMENTATION_READY: formatImplementationReady,
    VALIDATION_RESULT: formatValidationResult,
    PR_CREATED: formatPrCreated,
    PR_MERGED: formatPrMerged,
  };
  (handlers[msg.topic] ?? formatUnknownTopic)(msg, clusterPrefix, writer);
  return true;
}

export = {
  formatWatchMode,
  formatImplementationReady,
  formatPrCreated,
};
