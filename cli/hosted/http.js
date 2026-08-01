'use strict';

const { URL, URLSearchParams } = require('node:url');

class HostedHttpError extends Error {
  constructor(status, code, retryAfter) {
    super(`Zero Cloud request failed (${status}${code ? `: ${code}` : ''})`);
    this.name = 'HostedHttpError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function isLoopbackHttp(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function encodeBody(options, headers) {
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    return JSON.stringify(options.json);
  }
  if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    return new URLSearchParams(options.form).toString();
  }
  return undefined;
}

async function request(endpoint, pathname, options = {}) {
  const url = new URL(pathname, `${endpoint}/`);
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (isLoopbackHttp(url)) {
    headers['x-forwarded-for'] = '127.0.0.1';
  }
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  const body = encodeBody(options, headers);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: 'error',
      signal: options.signal || controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Zero Cloud request timed out: ${pathname}`);
    throw new Error(`Zero Cloud is unreachable at ${endpoint}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Zero Cloud returned an invalid response (${response.status})`);
    }
  }
  const accepted = options.accept || [200];
  if (!accepted.includes(response.status)) {
    let code = null;
    if (typeof value?.code === 'string') code = value.code;
    else if (typeof value?.error === 'string') code = value.error;
    throw new HostedHttpError(response.status, code, response.headers.get('retry-after'));
  }
  return { status: response.status, body: value, headers: response.headers };
}

module.exports = { HostedHttpError, request };
