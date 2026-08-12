'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const GH = '/usr/bin/gh';
const ISSUE_TIMEOUT_MS = 30_000;
const MAX_ISSUE_BYTES = 512 * 1024;

function commandEnvironment() {
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    PATH: process.env.PATH,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
}

function parseIssueNumber(repository, identifier) {
  if (typeof identifier !== 'string') throw new Error('Hosted issue input is invalid');
  const prefixes = [`https://github.com/${repository}/issues/`, `${repository}#`, ''];
  for (const prefix of prefixes) {
    if (!identifier.startsWith(prefix)) continue;
    const number = identifier.slice(prefix.length);
    const parsed = Number(number);
    if (/^[1-9][0-9]*$/.test(number) && Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error('Hosted issue input does not match the fixed repository authority');
}

function requiredString(value) {
  if (typeof value !== 'string') throw new Error('GitHub returned an invalid hosted issue');
  return value;
}

function optionalArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid hosted issue');
  return value;
}

function namedValues(value, key) {
  return optionalArray(value).map((entry) => requiredString(entry?.[key]));
}

function issueComments(value) {
  return optionalArray(value).map((comment) => {
    const createdAt = requiredString(comment?.createdAt);
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new Error('GitHub returned an invalid hosted issue');
    }
    return {
      author: requiredString(comment?.author?.login),
      createdAt: new Date(createdAt).toISOString(),
      body: requiredString(comment.body),
    };
  });
}

function normalizeIssue(repository, expectedNumber, issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    throw new Error('GitHub returned an invalid hosted issue');
  }
  if (!Number.isSafeInteger(issue.number) || issue.number !== expectedNumber) {
    throw new Error('GitHub returned an invalid hosted issue');
  }
  const expectedUrl = `https://github.com/${repository}/issues/${expectedNumber}`;
  if (requiredString(issue.url) !== expectedUrl) {
    throw new Error('GitHub returned an issue outside the fixed repository authority');
  }
  const title = requiredString(issue.title);
  const body = issue.body === null ? '' : requiredString(issue.body);
  return {
    title,
    body,
    expectedUrl,
    labels: namedValues(issue.labels, 'name'),
    assignees: namedValues(issue.assignees, 'login'),
    comments: issueComments(issue.comments),
  };
}

function section(title, contents) {
  return contents ? `## ${title}\n${contents}\n\n` : '';
}

function renderIssue(repository, expectedNumber, response) {
  const issue = normalizeIssue(repository, expectedNumber, response);
  const labels = issue.labels.map((label) => `- ${label}`).join('\n');
  const assignees = issue.assignees.map((login) => `- @${login}`).join('\n');
  const comments = issue.comments
    .map((comment) => `### ${comment.author} (${comment.createdAt})\n${comment.body}`)
    .join('\n\n');

  const context =
    `# GitHub Issue #${expectedNumber}\n\n` +
    section('URL', issue.expectedUrl) +
    section('Title', issue.title) +
    section('Description', issue.body) +
    section('Labels', labels) +
    section('Assignees', assignees) +
    section('Comments', comments);
  if (Buffer.byteLength(context) > MAX_ISSUE_BYTES) {
    throw new Error('Hosted issue exceeds the supported size');
  }
  return context;
}

async function fetchIssue(repository, number) {
  const { stdout } = await execFileAsync(
    GH,
    [
      'issue',
      'view',
      String(number),
      '--repo',
      repository,
      '--json',
      'number,title,body,labels,assignees,comments,url',
    ],
    {
      encoding: 'utf8',
      env: commandEnvironment(),
      maxBuffer: MAX_ISSUE_BYTES,
      timeout: ISSUE_TIMEOUT_MS,
      windowsHide: true,
    }
  );
  return JSON.parse(stdout);
}

async function hydrateIssueRequest(config, request, dependencies = {}) {
  if (request.source !== 'issue') return request;
  const number = parseIssueNumber(config.repository, request.issue);
  const issue = await (dependencies.fetchIssue || fetchIssue)(config.repository, number);
  return Object.freeze({
    ...request,
    source: 'prompt',
    issue: null,
    prompt: renderIssue(config.repository, number, issue),
  });
}

module.exports = { hydrateIssueRequest, parseIssueNumber, renderIssue };
