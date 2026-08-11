const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveMounts } = require('../../lib/docker-config');
const credentialPathModule = require('../../lib/provider-credential-path');
const { expandProviderCredentialPath, resolveProviderCredentialPaths } = credentialPathModule;
const { getProviderMetadata } = require('../../lib/provider-names');
const IsolationManager = require('../../src/isolation-manager');

function mountSpecs(args) {
  const mounts = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-v') mounts.push(args[index + 1]);
  }
  return mounts;
}

describe('provider credential path CommonJS contract', function () {
  it('preserves the exact export surface and function arities', function () {
    assert.deepEqual(Reflect.ownKeys(credentialPathModule), [
      'expandProviderCredentialPath',
      'resolveProviderCredentialPaths',
    ]);
    assert.deepEqual(
      Reflect.ownKeys(credentialPathModule).map((key) => credentialPathModule[key].length),
      [1, 1]
    );
  });
});

describe('Pi Docker credential isolation', function () {
  it('mounts Pi state writable so native refresh locks and rotations persist', function () {
    const manager = new IsolationManager();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-pi-docker-'));
    const source = path.join(tempRoot, 'agent');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'auth.json'), '{}');
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = source;

    try {
      const plan = manager._buildCredentialPlan(
        {},
        { dockerMounts: [], dockerEnvPassthrough: [] },
        '/home/node',
        'pi'
      );
      assert.deepEqual(mountSpecs(plan.args), [`${source}:/home/node/.pi/agent`]);
      assert.deepEqual(plan.mountedHosts, [source]);

      fs.mkdirSync(path.join(source, 'auth.json.lock'));
      fs.writeFileSync(path.join(source, 'auth.json'), '{"refreshed":true}');
      assert.equal(fs.readFileSync(path.join(source, 'auth.json'), 'utf8'), '{"refreshed":true}');
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('maps PI_CODING_AGENT_DIR to the canonical container path only', function () {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '/tmp/custom-pi-agent';
    try {
      assert.deepEqual(resolveMounts(['pi'], { containerHome: '/home/node' }), [
        {
          host: '/tmp/custom-pi-agent',
          container: '/home/node/.pi/agent',
          readonly: false,
        },
      ]);
      assert.equal(
        expandProviderCredentialPath('$PI_CODING_AGENT_DIR/auth.json'),
        '/tmp/custom-pi-agent/auth.json'
      );
      assert.deepEqual(resolveProviderCredentialPaths(getProviderMetadata('pi')), [
        '/tmp/custom-pi-agent/auth.json',
      ]);
      assert.deepEqual(resolveProviderCredentialPaths(getProviderMetadata('pi'), {}), [
        path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
      ]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe('Pi Docker credential path expansion', function () {
  it('resolves a relative PI_CODING_AGENT_DIR before building the Docker bind', function () {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = 'relative-pi-agent';
    try {
      assert.deepEqual(resolveMounts(['pi'], { containerHome: '/home/node' }), [
        {
          host: path.resolve('relative-pi-agent'),
          container: '/home/node/.pi/agent',
          readonly: false,
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it('expands a home-relative PI_CODING_AGENT_DIR like Pi does', function () {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '~/custom-pi-agent';
    try {
      const source = path.join(os.homedir(), 'custom-pi-agent');
      assert.deepEqual(resolveMounts(['pi'], { containerHome: '/home/node' }), [
        {
          host: source,
          container: '/home/node/.pi/agent',
          readonly: false,
        },
      ]);
      assert.deepEqual(resolveProviderCredentialPaths(getProviderMetadata('pi')), [
        path.join(source, 'auth.json'),
      ]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe('Pi Docker credential isolation passthrough', function () {
  for (const passthrough of ['PI_CODING_AGENT_DIR', 'PI_*']) {
    it(`never forwards the host-only config root through ${passthrough}`, function () {
      const manager = new IsolationManager();
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = '/host/private/pi-agent';
      try {
        const plan = manager._buildCredentialPlan(
          {},
          { dockerMounts: [], dockerEnvPassthrough: [passthrough] },
          '/home/node',
          'pi'
        );

        assert.strictEqual(plan.forwardedEnv.PI_CODING_AGENT_DIR, undefined);
        assert.strictEqual(plan.explicitEnvNames.has('PI_CODING_AGENT_DIR'), false);
        assert.doesNotMatch(JSON.stringify(plan.args), /PI_CODING_AGENT_DIR|\/host\/private/);
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    });
  }

  it('keeps an explicitly mounted Pi root host-only during another provider run', function () {
    const manager = new IsolationManager();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '/host/private/pi-agent';
    try {
      const plan = manager._buildCredentialPlan(
        {},
        { dockerMounts: ['pi'], dockerEnvPassthrough: ['PI_*'] },
        '/home/node',
        'codex'
      );

      assert.strictEqual(plan.forwardedEnv.PI_CODING_AGENT_DIR, undefined);
      assert.doesNotMatch(JSON.stringify(plan.args), /PI_CODING_AGENT_DIR/);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
