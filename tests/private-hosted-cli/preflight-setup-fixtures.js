'use strict';

const UNSAFE_CLUSTER_CONFIG = JSON.stringify({
  name: 'unsafe',
  agents: [
    {
      id: 'worker',
      role: 'implementation',
      triggers: [
        {
          topic: 'ISSUE_OPENED',
          action: 'execute_task',
          logic: { engine: 'javascript', script: 'return true;' },
        },
      ],
    },
  ],
});

const RESERVED_RUNTIME_NAMES = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'HOME',
  'LANG',
  'NODE_ENV',
  'PATH',
  'TMPDIR',
  'ZEROSHOT_HOSTED_BASE_REVISION',
  'ZEROSHOT_HOSTED_DELIVERY_MODE',
  'ZEROSHOT_HOSTED_DELIVERY_TARGET',
  'ZEROSHOT_HOSTED_DELIVERY_VERSION',
  'ZEROSHOT_HOSTED_EXECUTABLE',
  'ZEROSHOT_HOSTED_EXEC_ROOT',
  'ZEROSHOT_HOSTED_MODEL',
  'ZEROSHOT_HOSTED_PROVIDER',
  'ZEROSHOT_HOSTED_REPOSITORY',
  'ZEROSHOT_ISOLATION_PROFILE',
  'ZEROSHOT_PROVIDER_PROFILE',
  'ZEROSHOT_SETTINGS_FILE',
]);

module.exports = { RESERVED_RUNTIME_NAMES, UNSAFE_CLUSTER_CONFIG };
