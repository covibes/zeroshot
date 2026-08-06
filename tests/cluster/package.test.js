'use strict';

const assert = require('node:assert').strict;
const fileSystem = require('node:fs');
const operatingSystem = require('node:os');
const paths = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const root = paths.resolve(__dirname, '../..');

function execute(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let cachedConsumer;
let cachedRuntimeConsumer;

function packedConsumer(installOptional = false) {
  const cached = installOptional ? cachedRuntimeConsumer : cachedConsumer;
  if (cached) return cached;
  const directory = fileSystem.mkdtempSync(
    paths.join(operatingSystem.tmpdir(), 'zeroshot-cluster-package-')
  );
  const output = execute('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    directory,
  ]);
  const [{ filename, files }] = JSON.parse(output);
  const tarball = paths.join(directory, filename);
  fileSystem.writeFileSync(
    paths.join(directory, 'package.json'),
    JSON.stringify({ private: true })
  );
  const installArgs = [
    'install',
    '--ignore-scripts',
    ...(installOptional ? [] : ['--omit=optional']),
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    tarball,
  ];
  execute('npm', installArgs, directory);
  const consumer = { directory, files };
  if (installOptional) cachedRuntimeConsumer = consumer;
  else cachedConsumer = consumer;
  return consumer;
}

test('packed tarball resolves CJS, ESM, root, package metadata, and preserved deep imports', () => {
  const { directory, files } = packedConsumer();
  const names = new Set(files.map(({ path: file }) => file));
  for (const required of [
    'lib/cluster/index.cjs',
    'lib/cluster/index.mjs',
    'lib/cluster/index.d.ts',
    'lib/cluster/generated/protocol.d.ts',
    'lib/hosted-session/index.cjs',
    'lib/hosted-session/index.mjs',
    'lib/hosted-session/index.d.ts',
    'lib/hosted-target/index.cjs',
    'lib/hosted-target/index.mjs',
    'lib/hosted-target/index.d.ts',
    'lib/hosted-target/index.d.cts',
    'lib/hosted-target/index.d.mts',
    'lib/target/target-registry.js',
  ])
    assert.ok(names.has(required), required);
  const installedRoot = paths.join(directory, 'node_modules', '@the-open-engine', 'zeroshot');
  for (const artifact of files
    .map(({ path: artifactPath }) => artifactPath)
    .filter((artifactPath) =>
      /^lib\/(?:hosted-target|hosted-session)\/.*\.(?:cjs|mjs)$/.test(artifactPath)
    )) {
    const source = fileSystem.readFileSync(paths.join(installedRoot, artifact), 'utf8');
    assert.equal(
      /(?:from\s+|require\()['"][^'"]+\.ts['"]/.test(source),
      false,
      `${artifact} imports source TypeScript`
    );
  }
  execute(
    process.execPath,
    [
      '-e',
      "const c=require('@the-open-engine/zeroshot/cluster');const h=require('@the-open-engine/zeroshot/hosted-session');const t=require('@the-open-engine/zeroshot/lib/hosted-target/index.cjs');if(typeof c.connect!=='function'||typeof c.ClusterClient!=='function'||typeof h.HostedSessionCoordinator!=='function'||typeof t.createTargetAdapter!=='function')process.exit(1)",
    ],
    directory
  );
  execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {connect,ClusterClient} from '@the-open-engine/zeroshot/cluster';import {HostedSessionCoordinator} from '@the-open-engine/zeroshot/hosted-session';import {createTargetAdapter} from '@the-open-engine/zeroshot/lib/hosted-target/index.mjs';if(typeof connect!=='function'||typeof ClusterClient!=='function'||typeof HostedSessionCoordinator!=='function'||typeof createTargetAdapter!=='function')process.exit(1)",
    ],
    directory
  );
  execute(
    process.execPath,
    [
      '-e',
      "require('@the-open-engine/zeroshot');require('@the-open-engine/zeroshot/src/orchestrator.js');require('@the-open-engine/zeroshot/lib/settings.js');require('@the-open-engine/zeroshot/lib/target/target-registry.js');require('@the-open-engine/zeroshot/package.json')",
    ],
    directory
  );
});

test('packed declarations resolve under node16 and bundler modes', () => {
  const { directory } = packedConsumer();
  fileSystem.writeFileSync(
    paths.join(directory, 'consumer.ts'),
    [
      "import type { ClusterClient, Connection, WatchParams } from '@the-open-engine/zeroshot/cluster';",
      "import type { HostedAccess, HostedSessionCoordinator } from '@the-open-engine/zeroshot/hosted-session';",
      "import type { TargetAdapter } from '@the-open-engine/zeroshot/lib/hosted-target/index.cjs';",
      'declare const client: ClusterClient;',
      'declare const connection: Connection;',
      'declare const hostedSession: HostedSessionCoordinator;',
      'declare const access: HostedAccess;',
      'declare const targetAdapter: TargetAdapter;',
      'void hostedSession;',
      'void access;',
      'void targetAdapter;',
      'const params: WatchParams = {};',
      'void client.watch(params);',
      "void connection.call('get', {});",
      "void connection.openSubscription('watch', {});",
      '// @ts-expect-error subscriptions cannot bypass openSubscription',
      "void connection.call('watch', {});",
      '// @ts-expect-error unary calls cannot use openSubscription',
      "void connection.openSubscription('get', {});",
      '// @ts-expect-error raw cancellation notifications are ownership-private',
      "void connection.sendNotification('subscription/cancel', { subscriptionId: 'guessed' });",
    ].join('\n')
  );
  const tsc = paths.join(root, 'node_modules/.bin/tsc');

  for (const [moduleResolution, module] of [
    ['node16', 'Node16'],
    ['bundler', 'ES2022'],
  ]) {
    fileSystem.writeFileSync(
      paths.join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          moduleResolution,
          module,
          skipLibCheck: false,
        },
        files: ['consumer.ts'],
      })
    );
    execute(tsc, ['--project', 'tsconfig.json'], directory);
  }
});

test('packed CJS and ESM consumers use the installed default ws runtime', () => {
  const { directory } = packedConsumer(true);
  const script = String.raw`
    const { once } = require('node:events');
    const { WebSocketServer } = require('ws');
    (async()=>{
      delete globalThis.WebSocket;
      const server = new WebSocketServer({ port: 0 });
      server.on('connection', socket => socket.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.method === 'initialize') socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            protocolVersion: 'openengine.cluster/v1',
            capabilities: {},
            status: { phase: 'empty' },
          },
        }));
      }));
      await once(server, 'listening');
      const address = server.address();
      const url = 'ws://127.0.0.1:' + address.port;
      const commonjs = require('@the-open-engine/zeroshot/cluster');
      const first = await commonjs.connect(url);
      await first.close();
      const modules = await import('@the-open-engine/zeroshot/cluster');
      const second = await modules.connect(url);
      await second.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })().catch(error=>{console.error(error);process.exit(1)});
  `;
  execute(process.execPath, ['-e', script], directory);
});

test('injected WebSocket factory overrides the installed default runtime', () => {
  const { directory } = packedConsumer(true);
  const script = String.raw`
    const assert = require('node:assert').strict;
    delete globalThis.WebSocket;
    const { connect } = require('@the-open-engine/zeroshot/cluster');
    class Socket {
      constructor(){this.readyState=1;this.listeners=new Map()}
      addEventListener(t,f){const a=this.listeners.get(t)||[];a.push(f);this.listeners.set(t,a)}
      removeEventListener(t,f){this.listeners.set(t,(this.listeners.get(t)||[]).filter(x=>x!==f))}
      send(text){const frame=JSON.parse(text);if(frame.method==='initialize')queueMicrotask(()=>this.emit('message',{data:JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{protocolVersion:'openengine.cluster/v1',capabilities:{},status:{phase:'empty'}}})}))}
      emit(t,e){for(const f of this.listeners.get(t)||[])f(e)}
      close(){this.readyState=3;this.emit('close',{})}
    }
    (async()=>{
      const calls = [];
      const socket = new Socket();
      const connection = await connect('ws://example',{
        protocols: ['openengine.cluster'],
        headers: { Authorization: 'Bearer test' },
        webSocketFactory: (...args) => {
          calls.push(args);
          return socket;
        },
      });
      assert.deepEqual(calls, [[
        'ws://example',
        ['openengine.cluster'],
        { headers: { Authorization: 'Bearer test' } },
      ]]);
      await connection.close();
      assert.equal(socket.readyState, 3);
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  execute(process.execPath, ['-e', script], directory);
});
