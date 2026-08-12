import js from '@eslint/js';
import unusedImports from 'eslint-plugin-unused-imports';
import securityPlugin from 'eslint-plugin-security';
import sonarPlugin from 'eslint-plugin-sonarjs';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default [
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error', // Fail on eslint-disable that suppresses nothing
    },
  },
  js.configs.recommended,
  {
    plugins: {
      'unused-imports': unusedImports,
      security: securityPlugin,
      sonarjs: sonarPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      // SonarJS recommended rules (override errors → warnings for gradual adoption)
      ...sonarPlugin.configs.recommended.rules,

      // Code quality - WARN not ERROR (too many violations, fix gradually)
      'sonarjs/cognitive-complexity': 'warn',
      'sonarjs/no-nested-conditional': 'warn',
      'sonarjs/no-nested-functions': 'warn',
      'sonarjs/no-invariant-returns': 'warn',
      'sonarjs/no-all-duplicated-branches': 'warn',
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/single-character-alternation': 'warn',
      'sonarjs/no-collection-size-mischeck': 'warn',
      'sonarjs/concise-regex': 'off', // Style preference
      'sonarjs/public-static-readonly': 'off', // JS doesn't have readonly modifier
      'sonarjs/single-char-in-character-classes': 'warn', // Style preference
      // Disable sonarjs/no-unused-vars - we use unused-imports plugin with varsIgnorePattern: '^_'
      'sonarjs/no-unused-vars': 'off',

      // Dead code detection - AGGRESSIVE
      'no-unused-vars': 'off', // Disabled in favor of unused-imports plugin
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],

      // Variables
      'no-undef': 'error',
      'no-shadow': ['error', { builtinGlobals: false }],
      'no-use-before-define': ['error', { functions: false }],

      // Best practices
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-return-await': 'error',
      'require-await': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      // WARN for now - many violations exist (fix gradually)
      'no-param-reassign': 'warn',

      // Code quality
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 4],
      'max-params': ['warn', 5],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'sonarjs/no-identical-functions': 'error',

      // Security - eslint-plugin-security
      // NOTE: detect-child-process off because we have safe-exec wrapper enforcement via no-restricted-syntax
      'security/detect-child-process': 'off',
      'security/detect-eval-with-expression': 'error',
      // NOTE: detect-object-injection off - high false positive for CLI tools with controlled object access
      'security/detect-object-injection': 'off',
      // NOTE: warn not error - false positives on anchored patterns with controlled input
      'security/detect-unsafe-regex': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      // NOTE: detect-non-literal-fs-filename off - CLI tools legitimately use variable paths
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-require': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-bidi-characters': 'error',

      // Disable pedantic sonarjs rules (high false positive rate for CLI/orchestrator)
      'sonarjs/todo-tag': 'off',
      'sonarjs/deprecation': 'off',
      'sonarjs/constructor-for-side-effects': 'off',
      'sonarjs/publicly-writable-directories': 'off',
      'sonarjs/file-permissions': 'off',
      'sonarjs/arguments-order': 'off',
      'sonarjs/slow-regex': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/prefer-immediate-return': 'off',
      'sonarjs/prefer-single-boolean-return': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/no-commented-code': 'off',
      'sonarjs/no-gratuitous-expressions': 'off',
      // NOTE: os-command and no-os-command-from-path off - zeroshot IS an orchestrator that spawns commands
      'sonarjs/os-command': 'off',
      'sonarjs/no-os-command-from-path': 'off',

      // Basic security
      'no-unsafe-optional-chaining': 'error',
      'no-prototype-builtins': 'error',

      // Dangerous fallbacks - FORBIDDEN
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "LogicalExpression[operator='||'][right.value=/localhost|127\\.0\\.0|^\\d{4,5}$/]",
          message: 'FORBIDDEN: Dangerous fallback. Throw error if missing instead.',
        },
        {
          // Catches: const { exec } = require('child_process')
          selector:
            "VariableDeclarator[init.callee.name='require'][init.arguments.0.value='child_process'] > ObjectPattern > Property[key.name='exec']",
          message:
            "FORBIDDEN: Direct exec() from child_process can hang forever. Use require('./lib/safe-exec') instead.",
        },
        {
          // Catches: const { execSync } = require('child_process')
          selector:
            "VariableDeclarator[init.callee.name='require'][init.arguments.0.value='child_process'] > ObjectPattern > Property[key.name='execSync']",
          message:
            "FORBIDDEN: Direct execSync() from child_process can hang forever. Use require('./lib/safe-exec') instead.",
        },
      ],

      // Style (keep existing)
      'no-console': 'off',
      'no-case-declarations': 'off',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      // Tests have nested describe/it blocks - allow deeper nesting
      'sonarjs/no-nested-functions': 'off',
      // Test files can be large (many test cases)
      'max-lines': 'off',
      // Allow unused vars in tests (setup fixtures)
      'sonarjs/no-unused-vars': 'off',
      // Allow unused collections in tests (assertion helpers)
      'sonarjs/no-unused-collection': 'off',
      // Math.random() fine in tests
      'sonarjs/pseudo-random': 'off',
    },
  },
  {
    // Allow direct child_process in safe-exec wrapper, tests, CLI, and lib/
    // - safe-exec.js: IS the wrapper
    // - tests/: Need to test subprocess behavior directly
    // - cli/: Has its own timeout handling for user-facing commands
    // - lib/: Utility code with specific timeout requirements
    files: ['src/lib/safe-exec.js', 'tests/**/*.js', 'cli/**/*.js', 'lib/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Keep the dangerous fallback rule, just disable the exec rule
        {
          selector:
            "LogicalExpression[operator='||'][right.value=/localhost|127\\.0\\.0|^\\d{4,5}$/]",
          message: 'FORBIDDEN: Dangerous fallback. Throw error if missing instead.',
        },
      ],
    },
  },
  {
    files: [
      'src/agent-cli-provider/**/*.ts',
      'tests/agent-cli-provider/**/*.ts',
      'src/legacy-lib/**/*.ts',
      'src/*.ts',
      'src/agent/**/*.ts',
      'src/agents/**/*.ts',
      'src/attach/**/*.ts',
      'src/issue-providers/**/*.ts',
      'src/providers/**/*.ts',
      'src/schemas/**/*.ts',
      'src/template-validation/**/*.ts',
      'src/lib/**/*.ts',
      'task-lib/**/*.ts',
      'cli/**/*.ts',
      'bin/**/*.ts',
      'cluster-scripts/**/*.ts',
      'scripts/*.ts',
    ],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          './tsconfig.agent-cli-provider.json',
          './tsconfig.legacy-lib.json',
          './tsconfig.legacy-runtime.json',
          './tsconfig.task-lib.json',
        ],
        tsconfigRootDir,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-check': false,
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // TUI/CLI/streaming files use ANSI escape codes for terminal colors - allow control characters
    files: [
      'src/streaming/*.js',
      'src/streaming/**/*.js',
      'src/status-footer.js',
      'task-lib/tui.js',
      'task-lib/tui/**/*.js',
      'cli/**/*.js',
    ],
    rules: {
      'no-control-regex': 'off',
      'sonarjs/no-control-regex': 'off',
      // Unused vars common in streaming (partial destructuring)
      'sonarjs/no-unused-vars': 'off',
    },
  },
  {
    // lib/tui-backend output is generated by tsc; allow compiler helpers and comparisons
    files: ['lib/tui-backend/**/*.js'],
    rules: {
      'no-global-this': 'off',
      'sonarjs/no-global-this': 'off',
      'no-shadow': 'off',
      eqeqeq: 'off',
    },
  },
  {
    // Large files that need refactoring - temporary overrides
    // TODO: Split these files into smaller modules
    files: ['cli/index.js', 'src/agent/agent-task-executor.js', 'src/agent/agent-lifecycle.js'],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // Math.random() used for non-security purposes (jitter, distribution)
    files: ['src/**/*.js', 'lib/**/*.js', 'task-lib/**/*.{js,ts}'],
    rules: {
      'sonarjs/pseudo-random': 'warn',
    },
  },
  {
    // Message formatters always return true (handled) - valid handler pattern
    files: ['cli/message-formatters-*.js'],
    rules: {
      'sonarjs/no-invariant-returns': 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'cluster-hooks/**',
      'hooks/**',
      'lib/tui-backend/**',
      'lib/agent-cli-provider/**',
      'lib/cluster/**',
      'lib/hosted-session/**',
      'lib/target/**',
      'cli/event-copy.js',
      'cli/message-formatter-utils.js',
      'cli/json-export.js',
      'cli/message-formatters-watch.js',
      'lib/clusters-registry.js',
      'lib/completion.js',
      'lib/compose-utils.js',
      'lib/detached-startup.js',
      'lib/docker-config.js',
      'lib/docker-env-auth.js',
      'lib/git-remote-utils.js',
      'lib/id-detector.js',
      'lib/path-check.js',
      'lib/process-liveness.js',
      'lib/provider-credential-path.js',
      'lib/provider-defaults.js',
      'lib/provider-detection.js',
      'lib/provider-names.js',
      'lib/repo-settings.js',
      'lib/run-mode.js',
      'lib/run-plan.js',
      'lib/settings-defaults.js',
      'lib/settings-error.js',
      'lib/settings-issue-providers.js',
      'lib/settings-models.js',
      'lib/settings-storage.js',
      'lib/settings-validation.js',
      'lib/settings.js',
      'lib/settings/claude-auth.js',
      'lib/setup-apply-types.js',
      'lib/setup-apply.js',
      'lib/setup-journal.js',
      'lib/setup-plan-types.js',
      'lib/setup-plan.js',
      'lib/setup-undo.js',
      'lib/start-cluster-config.js',
      'lib/start-cluster-environment.js',
      'lib/start-cluster-run-options.js',
      'lib/start-cluster.js',
      'lib/stream-json-parser.js',
      'src/claude-credentials.js',
      'src/config-router.js',
      'src/copy-worker.js',
      'src/darwin-keychain-boundary.js',
      'src/guidance-topics.js',
      'src/input-helpers.js',
      'src/ledger-sequence.js',
      'src/message-bus-bridge.js',
      'src/message-buffer.js',
      'src/state-snapshot-normalization.js',
      'src/state-snapshot.js',
      'src/state-snapshotter.js',
      'src/task-startup-error.js',
      'src/task-runner.js',
      'src/worktree-tooling-env.js',
      'src/omp-blob-root.js',
      'src/omp-config-overlay.js',
      'task-lib/completion.js',
      'task-lib/config.js',
      'task-lib/name-generator.js',
      'task-lib/process-termination.js',
      'task-lib/omp-storage-root.js',
      'src/omp-execution-fingerprint.js',
      'src/omp-session-limits.js',
      'src/agent/agent-input-injector.js',
      'src/agent/agent-config.js',
      'src/agent/agent-config-settings.js',
      'src/agent/agent-stuck-detector.js',
      'src/agent/pi-terminal-lifecycle.js',
      'src/agent/pi-terminal-lifecycle-types.js',
      'src/agent/provider-terminal-failure.js',
      'src/agent/provider-terminal-failure-types.js',
      'src/agent/output-reformatter.js',
      'src/agent/output-reformatter-types.js',
      'src/agent/output-reformatter-errors.js',
      'src/agent/output-extraction.js',
      'src/agent/output-extraction-types.js',
      'src/agent/output-extraction-json.js',
      'src/agent/output-extraction-error-detail.js',
      'src/agent/output-extraction-pi.js',
      'src/agent/output-extraction-failures.js',
      'src/agent/agent-trigger-evaluator.js',
      'src/agent/agent-context-sections.js',
      'src/agent/agent-context-types.js',
      'src/agent/agent-context-environment-sections.js',
      'src/agent/agent-context-prompt-sections.js',
      'src/agent/agent-context-validation-sections.js',
      'src/agent/context-pack-builder.js',
      'src/agent/context-pack-core.js',
      'src/agent/context-pack-selection.js',
      'src/agent/context-pack-truncation.js',
      'src/agent/context-pack-types.js',
      'src/agent/context-replay-policy.js',
      'src/agent/critical-agent-policy.js',
      'src/agent/provider-control-plane.js',
      'src/agent/structured-output-error.js',
      'src/agent/validation-platform.js',
      'src/attach/socket-paths.js',
      'src/attach/ring-buffer.js',
      'src/attach/protocol.js',
      'src/attach/send-input.js',
      'src/attach/socket-discovery.js',
      'src/attach/attach-client.js',
      'src/attach/attach-server.js',
      'src/attach/attach-server-types.js',
      'src/attach/attach-server-runtime.js',
      'src/attach/attach-server-clients.js',
      'src/attach/attach-server-cleanup.js',
      'src/attach/attach-server-socket.js',
      'src/attach/attach-server-pty.js',
      'src/attach/attach-server-events.js',
      'src/attach/index.js',
      'src/providers/anthropic/index.js',
      'src/providers/capabilities.js',
      'src/providers/google/index.js',
      'src/providers/openai/index.js',
      'src/providers/opencode/index.js',
      'src/schemas/sub-cluster.js',
      'src/template-validation/report-formatter.js',
      'src/template-validation/consensus-gate-contracts.js',
      'src/template-validation/consensus-gate-stage.js',
      'src/template-validation/consensus-gate-scenarios.js',
      'src/template-validation/simulate-consensus-gates.js',
      'src/template-validation/simulate-two-stage-validation.js',
      'src/template-validation/simulation-runtime.js',
      'src/template-validation/simulation-agent.js',
      'src/template-validation/two-stage-contracts.js',
      'src/template-validation/two-stage-inputs.js',
      'src/template-validation/two-stage-results.js',
      'src/template-validation/simulation-agent-runtime.js',
      'src/template-validation/random-topology-contracts.js',
      'src/template-validation/random-topology-schema.js',
      'src/template-validation/random-topology-runtime.js',
      'src/template-validation/random-topology-operations.js',
      'src/template-validation/random-topology-dispatch.js',
      'src/template-validation/random-topology-trigger-evaluation.js',
      'src/template-validation/random-topology-trigger.js',
      'src/template-validation/random-topology-state.js',
      'src/template-validation/random-topology-message-loop.js',
      'src/template-validation/random-topology-scenario.js',
      'src/template-validation/simulate-random-topology.js',
      'src/template-validation/two-stage-scenario.js',
    ],
  },
  prettierConfig,
];
