'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { URL } = require('node:url');

const { capsuleSession, rotateCapsuleSession } = require('./auth');
const { HostedHttpError, request } = require('./http');
const { getTarget } = require('./target-store');

const DEFAULT_MODEL = 'openai/gpt-5.4';
const PROTOCOL = 'openengine.cluster/v1';
const WORKER = 'legacy.zeroshot.ship@1';
const READY_TIMEOUT_MS = 10 * 60 * 1_000;
const CAPSULE_SIZES = new Set(['tiny', 'small', 'standard', 'large']);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function validModel(value) {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function repositoryFromRemote(cwd = process.cwd()) {
  let remote;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const match = remote.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/
  );
  return match && validRepository(match[1]) ? match[1] : null;
}

function isolationProfile(options = {}) {
  return options.pr ? 'isolation.pr@1' : 'isolation.worktree@1';
}

function providerProfile(options = {}) {
  return options.pr ? 'provider.codex-openrouter-pr@1' : 'provider.codex-openrouter@1';
}

function issueInput(value, options = {}) {
  const shorthand = value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/);
  if (shorthand && validRepository(shorthand[1])) {
    const canonicalIssue = `https://github.com/${shorthand[1]}/issues/${shorthand[2]}`;
    return { repository: shorthand[1], request: issueRequest(canonicalIssue, options) };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/);
  const repository = match ? `${match[1]}/${match[2]}` : '';
  if (url.hostname !== 'github.com' || !match || !validRepository(repository)) return null;
  return { repository, request: issueRequest(value, options) };
}

function issueRequest(issue, options = {}) {
  return {
    source: 'issue',
    issue,
    artifacts: [],
    isolationProfile: isolationProfile(options),
    providerProfile: providerProfile(options),
  };
}

function promptRequest(prompt, options = {}) {
  return {
    source: 'prompt',
    prompt,
    artifacts: [],
    isolationProfile: isolationProfile(options),
    providerProfile: providerProfile(options),
  };
}

async function stdinText() {
  if (process.stdin.isTTY) throw new Error('zeroshot run - requires piped input');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('hosted task input exceeds 1 MiB');
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (!value) throw new Error('hosted task input is empty');
  return value;
}

function readTaskFile(filename) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null;
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) return null;
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

async function resolveInput(input, options) {
  const explicitIssue = issueInput(input, options);
  if (explicitIssue) return explicitIssue;
  const repository =
    options.repository || process.env.ZEROSHOT_REPOSITORY || repositoryFromRemote();
  if (!validRepository(repository || '')) {
    throw new Error(
      'hosted runs need a GitHub repository; use org/repo#123, --repository owner/name, ' +
        'ZEROSHOT_REPOSITORY, or run inside a GitHub checkout'
    );
  }
  if (/^[1-9][0-9]*$/.test(input)) return { repository, request: issueRequest(input, options) };
  if (input === '-') return { repository, request: promptRequest(await stdinText(), options) };
  const filename = path.resolve(input);
  const fileInput = readTaskFile(filename);
  if (fileInput !== null) {
    const text = fileInput.trim();
    if (!text) throw new Error(`hosted task file is empty: ${input}`);
    return { repository, request: promptRequest(text, options) };
  }
  if (!input.trim()) throw new Error('hosted task input is empty');
  return { repository, request: promptRequest(input.trim(), options) };
}

function githubToken(environment = process.env) {
  const configured = environment.GH_TOKEN || environment.GITHUB_TOKEN;
  if (configured?.trim()) return configured.trim();
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return token;
  } catch {
    // The actionable error below covers missing and unauthenticated gh alike.
  }
  throw new Error('hosted runs require GH_TOKEN/GITHUB_TOKEN or an authenticated gh CLI');
}

function providerKey(environment = process.env) {
  const key = environment.OPENROUTER_API_KEY;
  if (!key?.trim()) throw new Error('hosted Codex runs require OPENROUTER_API_KEY');
  return key.trim();
}

function validateHostedOptions(options) {
  const unsupported = [
    ['config', '--config'],
    ['docker', '--docker'],
    ['worktree', '--worktree'],
    ['dockerImage', '--docker-image'],
    ['strictSchema', '--strict-schema'],
    ['ship', '--ship'],
    ['prBase', '--pr-base'],
    ['mergeQueue', '--merge-queue'],
    ['closeIssue', '--close-issue'],
    ['workers', '--workers'],
    ['gitlab', '--gitlab'],
    ['jira', '--jira'],
    ['devops', '--devops'],
    ['linear', '--linear'],
    ['detach', '--detach'],
    ['mount', '--mount'],
    ['containerHome', '--container-home'],
  ];
  const selected = unsupported
    .filter(([name]) => options[name] !== undefined && options[name] !== false)
    .map(([, flag]) => flag);
  if (options.provider && options.provider !== 'codex') selected.push('--provider');
  if (selected.length) {
    throw new Error(`hosted runs do not support ${selected.join(', ')}`);
  }
  if (options.model !== undefined && !validModel(options.model)) {
    throw new Error('hosted runs require an exact provider/model slug');
  }
  if (!CAPSULE_SIZES.has(options.size || 'standard')) {
    throw new Error('hosted runs require --size tiny, small, standard, or large');
  }
}

function organizationFromToken(token) {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Zero Cloud returned an invalid access token');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Zero Cloud returned an invalid access token');
  }
  if (typeof claims.org_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.org_id)) {
    throw new Error('target login is not bound to an organization');
  }
  return claims.org_id;
}

async function waitForReady(target, organization, capsuleId, accessToken) {
  const pathname = `/api/v1/orgs/${organization}/capsules/${capsuleId}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastState = 'provisioning';
  while (Date.now() < deadline) {
    const capsule = (await request(target.endpoint, pathname, { bearer: accessToken })).body;
    lastState = capsule?.state;
    if (lastState === 'ready') return;
    if (['failed', 'terminated'].includes(lastState)) {
      throw new Error(`capsule entered terminal state ${lastState} before it was ready`);
    }
    await delay(500);
  }
  throw new Error(`capsule did not become ready; last state was ${lastState}`);
}

async function mintAccess(target, capsuleId, accessToken) {
  const pathname = `/api/v1/capsules/${capsuleId}/access`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return (
        await request(target.endpoint, pathname, {
          method: 'POST',
          bearer: accessToken,
          json: { protocol: PROTOCOL },
        })
      ).body;
    } catch (error) {
      if (!(error instanceof HostedHttpError) || error.code !== 'capsule_not_ready') throw error;
      await delay(500);
    }
  }
  throw new Error('capsule access did not become ready');
}

function websocketUrl(target, advertised) {
  const url = new URL(advertised);
  if (new URL(target.endpoint).protocol === 'http:') {
    const local = new URL(target.endpoint);
    url.protocol = 'ws:';
    url.host = local.host;
  }
  return url.toString();
}

function schemaDefinition(name) {
  const schema = require('../../protocol/openengine-cluster/v1/worker.schema.json');
  return payloadType(schema.$defs[name], schema.$defs);
}

function payloadType(schema, definitions) {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return payloadType(definitions[name], definitions);
  }
  if (schema.enum) return { kind: 'enum', values: [...schema.enum].sort() };
  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== 'null')
    : schema.type;
  if (type === 'object') {
    const required = new Set(schema.required || []);
    const fields = {};
    for (const name of Object.keys(schema.properties || {}).sort()) {
      fields[name] = {
        type: payloadType(schema.properties[name], definitions),
        required: required.has(name),
      };
    }
    return { kind: 'record', fields };
  }
  if (type === 'array') return { kind: 'array', items: payloadType(schema.items, definitions) };
  if (['null', 'boolean', 'integer', 'number', 'string'].includes(type)) return { kind: type };
  throw new Error('installed OECP worker schema cannot be converted to a graph contract');
}

function graph() {
  const input = schemaDefinition('LegacyShipRequest');
  const output = schemaDefinition('LegacyShipResult');
  return {
    initialInput: input,
    policy: { default: 'deny', policy: 'policy.strict@1' },
    profile: 'openengine.graph.single-worker/v1',
    root: {
      attempts: 1,
      input,
      inputBindings: [],
      kind: 'step',
      name: 'zeroshot',
      output,
      timeoutMs: 60 * 60 * 1_000,
      worker: WORKER,
      writeBindings: [],
    },
  };
}

function clusterLibrary() {
  try {
    return require('../../lib/cluster/index.cjs');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      throw new Error('OECP client is not built; run npm run build:cluster');
    }
    throw error;
  }
}

async function watchRun(client, runId) {
  const watch = await client.watch({ runId });
  let outcome = null;
  for await (const item of watch.stream) {
    if (item.type === 'closed') throw new Error(`OECP watch closed early: ${item.reason}`);
    const event = item.event;
    if (event.type === 'node_begin') console.log(`Worker ${event.node.node} started`);
    if (event.type === 'node_end') outcome = event.outcome;
    if (event.type === 'finished') break;
  }
  await watch.stream.cancel();
  return outcome;
}

async function applyRun(client, requestInput) {
  const specification = graph();
  const planned = await client.plan({ graph: specification });
  if (!planned.ok) {
    const detail = planned.diagnostics.map((item) => item.message).join('; ');
    throw new Error(`OECP plan rejected the hosted graph${detail ? `: ${detail}` : ''}`);
  }
  const applied = await client.apply({
    graph: specification,
    input: requestInput,
    idempotencyKey: crypto.randomUUID(),
    ifGeneration: 0,
  });
  if (!applied.runId) throw new Error('OECP apply returned no run id');
  console.log(`Run ${applied.runId} admitted`);
  const outcome = await watchRun(client, applied.runId);
  const final = await client.get({});
  if (final.status.phase !== 'finished') throw new Error('OECP run did not reach finished');
  if (!outcome) throw new Error('OECP run finished without a worker outcome');
  if (outcome.status !== 'verified') {
    throw new Error(`hosted worker failed (${outcome.code || outcome.status})`);
  }
  const result = outcome.output;
  if (result?.summary) console.log(result.summary);
  return result;
}

async function executeOecp(target, grant, requestInput) {
  const WebSocket = require('ws');
  const { ClusterClient, connect } = clusterLibrary();
  const connection = await connect(websocketUrl(target, grant.websocket_url), {
    webSocketFactory: (url, protocols) =>
      new WebSocket(url, protocols || [], {
        headers: { authorization: `Bearer ${grant.access_token}` },
        perMessageDeflate: false,
      }),
  });
  try {
    return await applyRun(new ClusterClient(connection), requestInput);
  } catch (error) {
    const reason = error?.data?.details?.reason;
    if (typeof reason === 'string' && reason) {
      throw new Error(`${error.message}: ${reason}`, { cause: error });
    }
    throw error;
  } finally {
    await connection.close();
  }
}

async function terminateCapsule(targetName, target, organization, capsuleId, session) {
  const pathname = `/api/v1/orgs/${organization}/capsules/${capsuleId}`;
  try {
    await request(target.endpoint, pathname, {
      method: 'DELETE',
      bearer: session.accessToken,
      accept: [202],
    });
    return session;
  } catch (error) {
    if (!(error instanceof HostedHttpError) || ![401, 403].includes(error.status)) throw error;
  }
  const rotated = await rotateCapsuleSession(targetName, target, session);
  await request(target.endpoint, pathname, {
    method: 'DELETE',
    bearer: rotated.accessToken,
    accept: [202],
  });
  return rotated;
}

async function runHosted(input, options) {
  validateHostedOptions(options);
  const targetName = options.target;
  const target = getTarget(targetName);
  const resolved = await resolveInput(input, options);
  const credentials = {
    githubToken: githubToken(),
    openrouterApiKey: providerKey(),
    repository: resolved.repository,
    model: options.model || DEFAULT_MODEL,
  };
  let session = await capsuleSession(targetName, target);
  const organization = organizationFromToken(session.accessToken);
  let capsuleId = null;
  try {
    const created = (
      await request(target.endpoint, `/api/v1/orgs/${organization}/capsules`, {
        method: 'POST',
        bearer: session.accessToken,
        headers: { 'idempotency-key': crypto.randomUUID() },
        json: { label: 'zeroshot-cli', size: options.size || 'standard' },
        accept: [201],
      })
    ).body;
    capsuleId = created?.capsule_id;
    if (typeof capsuleId !== 'string') throw new Error('Zero Cloud returned no capsule id');
    console.log(`Capsule ${capsuleId} provisioning`);
    await waitForReady(target, organization, capsuleId, session.accessToken);
    console.log(`Capsule ${capsuleId} ready`);
    const grant = await mintAccess(target, capsuleId, session.accessToken);
    await request(target.endpoint, `/api/v1/capsules/${capsuleId}/credentials`, {
      method: 'PUT',
      bearer: grant.access_token,
      json: credentials,
      accept: [204],
    });
    return await executeOecp(target, grant, resolved.request);
  } finally {
    if (capsuleId) {
      try {
        await terminateCapsule(targetName, target, organization, capsuleId, session);
        console.log(`Capsule ${capsuleId} termination requested`);
      } catch (error) {
        console.error(`Warning: capsule cleanup failed: ${error.message}`);
      }
    }
  }
}

module.exports = {
  graph,
  issueInput,
  payloadType,
  repositoryFromRemote,
  resolveInput,
  runHosted,
  validateHostedOptions,
  websocketUrl,
};
