import { existsSync, statSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import chalk from 'chalk';
import { getTask } from '../store.js';
import { isProcessRunning } from '../runner.js';
import { createRequire } from 'module';

// Import cluster's stream parser (shared between task and cluster)
const require = createRequire(import.meta.url);
const { parseChunk } = require('../../lib/stream-json-parser');
const { decodeTaskLogLine } = require('../../src/task-log-line');

// Tool icons for different tool types
const TOOL_ICONS = {
  Read: '📖',
  Write: '📝',
  Edit: '✏️',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '🤖',
  TodoWrite: '📋',
  AskUserQuestion: '❓',
  BashOutput: '📤',
  KillShell: '🔪',
};

function getToolIcon(toolName) {
  return TOOL_ICONS[toolName] || '🔧';
}

// Format tool call input for display
const TOOL_CALL_FORMATTERS = {
  Bash: (input) => (input.command ? `$ ${input.command}` : ''),
  Read: (input) => formatFilePathTail(input.file_path),
  Write: (input) => formatFilePathTail(input.file_path, '→ '),
  Edit: (input) => formatFilePathTail(input.file_path),
  Glob: (input) => input.pattern || '',
  Grep: (input) => (input.pattern ? `/${input.pattern}/` : ''),
  WebFetch: (input) => (input.url ? input.url.substring(0, 50) : ''),
  WebSearch: (input) => (input.query ? `"${input.query}"` : ''),
  Task: (input) => input.description || '',
  TodoWrite: (input) => formatTodoSummary(input),
  AskUserQuestion: (input) => formatQuestionSummary(input),
};

function formatToolCall(toolName, input) {
  if (!input) return '';

  const formatter = TOOL_CALL_FORMATTERS[toolName] || formatUnknownToolCall;
  return formatter(input);
}

function formatFilePathTail(filePath, prefix = '') {
  if (!filePath) return '';
  return `${prefix}${filePath.split('/').slice(-2).join('/')}`;
}

function formatTodoSummary(input) {
  const todos = input.todos;
  if (!Array.isArray(todos)) return '';

  const statusCounts = {};
  for (const todo of todos) {
    statusCounts[todo.status] = (statusCounts[todo.status] || 0) + 1;
  }

  const parts = Object.entries(statusCounts).map(
    ([status, count]) => `${count} ${status.replace('_', ' ')}`
  );

  return `${todos.length} todo${todos.length === 1 ? '' : 's'} (${parts.join(', ')})`;
}

function formatQuestionSummary(input) {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return '';
  }

  const preview = questions[0].question.substring(0, 50);
  const suffix = questions[0].question.length > 50 ? '...' : '';
  return questions.length > 1
    ? `${questions.length} questions: "${preview}..."`
    : `"${preview}${suffix}"`;
}

function formatUnknownToolCall(input) {
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return '';
  }

  const value = String(input[keys[0]]);
  const preview = value.substring(0, 40);
  return preview.length < value.length ? `${preview}...` : preview;
}

// Format tool result for display
function formatToolResult(content, isError, toolName, toolInput) {
  if (!content) return isError ? 'error' : 'done';

  // For errors, show full message
  if (isError) {
    const firstLine = content.split('\n')[0].substring(0, 80);
    return chalk.red(firstLine);
  }

  // For TodoWrite, show the actual todo items
  if (toolName === 'TodoWrite' && toolInput?.todos && Array.isArray(toolInput.todos)) {
    const todos = toolInput.todos;
    if (todos.length === 0) return chalk.dim('no todos');

    // Helper to get status icon
    const getStatusIcon = (todoStatus) => {
      if (todoStatus === 'completed') return '✓';
      if (todoStatus === 'in_progress') return '⧗';
      return '○';
    };

    if (todos.length === 1) {
      const status = getStatusIcon(todos[0].status);
      const suffix = todos[0].content.length > 50 ? '...' : '';
      return chalk.dim(`${status} ${todos[0].content.substring(0, 50)}${suffix}`);
    }
    // Multiple todos - show first one as preview
    const status = getStatusIcon(todos[0].status);
    return chalk.dim(
      `${status} ${todos[0].content.substring(0, 40)}... (+${todos.length - 1} more)`
    );
  }

  // For success, show summary
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return 'done';
  if (lines.length === 1) {
    const line = lines[0].substring(0, 60);
    return chalk.dim(line.length < lines[0].length ? line + '...' : line);
  }
  // Multiple lines - show count
  return chalk.dim(`${lines.length} lines`);
}

// Line buffer for accumulating text that streams without newlines
let lineBuffer = '';
let currentToolCall = null;

function resetState() {
  lineBuffer = '';
  currentToolCall = null;
}

// Flush pending text in buffer
function flushLineBuffer() {
  if (lineBuffer.trim()) {
    process.stdout.write(lineBuffer);
    if (!lineBuffer.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  lineBuffer = '';
}

// Accumulate text and print complete lines
function accumulateText(text) {
  lineBuffer += text;

  // Print complete lines, keep incomplete in buffer
  const lines = lineBuffer.split('\n');
  if (lines.length > 1) {
    // Print all complete lines
    for (let i = 0; i < lines.length - 1; i++) {
      console.log(lines[i]);
    }
    // Keep incomplete line in buffer
    lineBuffer = lines[lines.length - 1];
  }
}

// Process parsed events and output formatted content
const EVENT_HANDLERS = {
  text: handleTextEvent,
  thinking: handleThinkingEvent,
  thinking_start: handleThinkingEvent,
  tool_start: handleToolStart,
  tool_call: handleToolCall,
  tool_input: handleToolInput,
  tool_result: handleToolResult,
  result: handleResult,
  block_end: handleBlockEnd,
  multi: handleMulti,
};

function processEvent(event) {
  const handler = EVENT_HANDLERS[event.type];
  if (handler) {
    handler(event);
  }
}

function handleTextEvent(event) {
  accumulateText(event.text);
}

function handleThinkingEvent(event) {
  if (event.text) {
    console.log(chalk.dim.italic(event.text));
    return;
  }

  if (event.type === 'thinking_start') {
    console.log(chalk.dim.italic('💭 thinking...'));
  }
}

function handleToolStart() {
  flushLineBuffer();
}

function handleToolCall(event) {
  flushLineBuffer();
  const icon = getToolIcon(event.toolName);
  const toolDesc = formatToolCall(event.toolName, event.input);
  console.log(`${icon} ${chalk.cyan(event.toolName)} ${chalk.dim(toolDesc)}`);
  currentToolCall = { toolName: event.toolName, input: event.input };
}

function handleToolInput() {
  // Streaming tool input JSON - skip (shown in tool_call)
}

function handleToolResult(event) {
  const status = event.isError ? chalk.red('✗') : chalk.green('✓');
  const resultDesc = formatToolResult(
    event.content,
    event.isError,
    currentToolCall?.toolName,
    currentToolCall?.input
  );
  console.log(`  ${status} ${resultDesc}`);
}

function handleResult(event) {
  flushLineBuffer();
  if (event.error) {
    console.log(chalk.red(`\n✗ ERROR: ${event.error}`));
    return;
  }

  console.log(chalk.green(`\n✓ Completed`));
  if (event.cost) {
    console.log(chalk.dim(`   Cost: $${event.cost.toFixed(4)}`));
  }
  if (event.duration) {
    const mins = Math.floor(event.duration / 60000);
    const secs = Math.floor((event.duration % 60000) / 1000);
    console.log(chalk.dim(`   Duration: ${mins}m ${secs}s`));
  }
}

function handleBlockEnd() {
  // Content block ended
}

function handleMulti(event) {
  if (event.events) {
    for (const subEvent of event.events) {
      processEvent(subEvent);
    }
  }
}

// Parse a raw log line (may have timestamp prefix)
export function parseLogLine(line) {
  const decoded = decodeTaskLogLine(line);
  if (!decoded.providerOutput) return [];
  const trimmed = decoded.content.trim();
  if (!trimmed) return [];

  // Non-JSON lines output as-is
  if (!trimmed.startsWith('{')) {
    return [{ type: 'text', text: trimmed + '\n' }];
  }

  // Parse JSON using cluster's parser
  return parseChunk(trimmed);
}

export async function showLogs(taskId, options = {}) {
  const task = getTask(taskId);

  if (!task) {
    console.log(chalk.red(`Task not found: ${taskId}`));
    process.exit(1);
  }

  if (!existsSync(task.logFile)) {
    console.log(chalk.yellow('Log file not found (task may still be starting).'));
    return;
  }

  const lines = options.lines || 50;
  const follow = options.follow;
  const watch = options.watch;

  if (watch) {
    throw new Error('Task log TUI is unavailable in this release. Use `zeroshot logs <id> -f`.');
  } else if (follow) {
    // Stream logs continuously (like tail -f) - show last N lines first
    await tailFollow(task.logFile, task.pid, lines);
  } else {
    await tailLines(task.logFile, lines);
  }
}

function parseEventsFromLines(lines) {
  const events = [];
  for (const line of lines) {
    events.push(...parseLogLine(line));
  }
  return events;
}

function renderEvents(events) {
  for (const event of events) {
    processEvent(event);
  }
}

function renderLines(lines) {
  for (const line of lines) {
    renderEvents(parseLogLine(line));
  }
}

function readFileSlice(file, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return '';

  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  readSync(fd, buffer, 0, buffer.length, start);
  closeSync(fd);

  return buffer.toString();
}

function shouldStopFollowing(noChangeCount, pid) {
  return noChangeCount >= 10 && pid && !isProcessRunning(pid);
}

function handleFinalContent(file, lastSize, interval) {
  const finalSize = statSync(file).size;
  if (finalSize > lastSize) {
    const finalContent = readFileSlice(file, lastSize, finalSize);
    renderLines(finalContent.split('\n'));
    flushLineBuffer();
  }

  console.log(chalk.dim('\n--- Task completed ---'));
  clearInterval(interval);
  process.exit(0);
}

function handleNewContent(file, lastSize, currentSize) {
  const newContent = readFileSlice(file, lastSize, currentSize);
  if (newContent) {
    renderLines(newContent.split('\n'));
    flushLineBuffer();
  }
  return currentSize;
}

function tailLines(file, n) {
  resetState();
  const rawContent = readFileSync(file, 'utf-8');
  const rawLines = rawContent.split('\n');

  // Parse and process all events
  const allEvents = parseEventsFromLines(rawLines);
  // Tail to last n events
  renderEvents(allEvents.slice(-n));
  flushLineBuffer();
}

async function tailFollow(file, pid, lines = 50) {
  resetState();
  // First, output last N events (like tail -f behavior)
  const rawContent = readFileSync(file, 'utf-8');
  const rawLines = rawContent.split('\n');

  // Parse all events first
  const allEvents = parseEventsFromLines(rawLines);
  // Output only the last N events
  renderEvents(allEvents.slice(-lines));
  flushLineBuffer();

  // Poll for changes (more reliable than fs.watch)
  let lastSize = statSync(file).size;
  let noChangeCount = 0;

  const interval = setInterval(() => {
    try {
      const currentSize = statSync(file).size;

      if (currentSize > lastSize) {
        lastSize = handleNewContent(file, lastSize, currentSize);
        noChangeCount = 0;
        return;
      }

      noChangeCount++;

      // Check if process is still running after 5 seconds of no output
      if (shouldStopFollowing(noChangeCount, pid)) {
        handleFinalContent(file, lastSize, interval);
      }
    } catch (err) {
      // File might have been deleted
      console.log(chalk.red(`\nError reading log: ${err.message}`));
      clearInterval(interval);
      process.exit(1);
    }
  }, 500); // Poll every 500ms

  // Keep alive until Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.dim('\nStopped following.'));
    process.exit(0);
  });

  // Keep process running
  await new Promise(() => {});
}
