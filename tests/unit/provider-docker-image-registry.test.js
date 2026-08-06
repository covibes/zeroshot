const {
  IsolationManager,
  OMP_DOCKER_INSTALL_COMMAND,
  OMP_RELEASE_DOWNLOAD_BASE_URL,
  OMP_SUPPORTED_VERSION,
  assert,
  findOmpReleaseAsset,
  getProviderMetadata,
} = require('../helpers/provider-docker-image-harness');

describe('IsolationManager: per-provider image selection', function () {
  describe('providerBuildArgs', function () {
    it('returns no build args for a baked-in provider (claude)', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('claude'), []);
    });

    it('emits PROVIDER_INSTALL for copilot from the registry command (no config roots)', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('copilot'), [
        'PROVIDER_INSTALL=npm install -g @github/copilot',
      ]);
    });

    it('emits PROVIDER_INSTALL for codex from the registry command', function () {
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('codex'), [
        'PROVIDER_INSTALL=npm install -g @openai/codex',
      ]);
    });

    it('matches the value the registry advertises (no hardcoded drift)', function () {
      const registryInstall = getProviderMetadata('copilot').docker.install;
      assert.deepStrictEqual(IsolationManager.providerBuildArgs('copilot'), [
        `PROVIDER_INSTALL=${registryInstall}`,
      ]);
    });

    it('emits the pinned digest-verified install command plus PROVIDER_CONFIG_ROOTS for omp', function () {
      const args = IsolationManager.providerBuildArgs('omp');
      assert.strictEqual(args.length, 2);
      assert.strictEqual(args[0], `PROVIDER_INSTALL=${OMP_DOCKER_INSTALL_COMMAND}`);
      assert.strictEqual(args[1], 'PROVIDER_CONFIG_ROOTS=/home/node/.omp');

      const asset = findOmpReleaseAsset('linux-x64');
      assert.ok(args[0].includes(`${OMP_RELEASE_DOWNLOAD_BASE_URL}/${asset.name}`));
      assert.ok(args[0].includes(asset.sha256));
      assert.ok(args[0].includes('sha256sum -c -'));
      assert.ok(args[0].includes(`"$v" = "${OMP_SUPPORTED_VERSION}"`));
      assert.ok(args[0].includes('omp --version'));
    });

    it('honors a custom containerHome for PROVIDER_CONFIG_ROOTS', function () {
      const args = IsolationManager.providerBuildArgs('omp', '/root');
      assert.ok(args.includes('PROVIDER_CONFIG_ROOTS=/root/.omp'));
    });
  });

  describe('registry docker.install', function () {
    it('is set for npm-installable providers and absent for baked-in claude', function () {
      assert.ok(
        getProviderMetadata('copilot').docker.install,
        'copilot should have docker.install'
      );
      assert.ok(getProviderMetadata('codex').docker.install, 'codex should have docker.install');
      assert.ok(getProviderMetadata('gemini').docker.install, 'gemini should have docker.install');
      assert.ok(getProviderMetadata('omp').docker.install, 'omp should have docker.install');
      assert.strictEqual(
        getProviderMetadata('claude').docker.install,
        undefined,
        'claude is baked into the base image and must not declare docker.install'
      );
    });
  });

  describe('registry docker.platform', function () {
    it('is set to linux/amd64 for omp only', function () {
      assert.strictEqual(getProviderMetadata('omp').docker.platform, 'linux/amd64');
      assert.strictEqual(getProviderMetadata('claude').docker.platform, undefined);
      assert.strictEqual(getProviderMetadata('copilot').docker.platform, undefined);
    });

    it('IsolationManager.providerDockerPlatform reads it from the registry', function () {
      assert.strictEqual(IsolationManager.providerDockerPlatform('omp'), 'linux/amd64');
      assert.strictEqual(IsolationManager.providerDockerPlatform('claude'), null);
    });
  });

  describe('registry docker.configRoots', function () {
    it('is set to $HOME/.omp for omp only', function () {
      assert.deepStrictEqual(getProviderMetadata('omp').docker.configRoots, ['$HOME/.omp']);
      assert.strictEqual(getProviderMetadata('claude').docker.configRoots, undefined);
    });

    it('IsolationManager.providerConfigRoots expands $HOME to containerHome', function () {
      assert.deepStrictEqual(IsolationManager.providerConfigRoots('omp', '/home/node'), [
        '/home/node/.omp',
      ]);
      assert.deepStrictEqual(IsolationManager.providerConfigRoots('claude', '/home/node'), []);
    });
  });
});
