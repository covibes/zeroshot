import { createAcpAdapter } from './adapters/acp';
import { claudeAdapter } from './adapters/claude';
import { codexAdapter } from './adapters/codex';
import { copilotAdapter } from './adapters/copilot';
import { gatewayAdapter, gatewaySettingsDefaults, validateGatewaySettings } from './adapters/gateway';
import { geminiAdapter } from './adapters/gemini';
import { opencodeAdapter } from './adapters/opencode';
import { piAdapter } from './adapters/pi';
import { resolveClaudeCommand } from './claude-command';
import type { ModelLevel, ProviderAdapter } from './types';

export type ProviderCapabilityState = boolean | 'experimental';

export interface ProviderCapabilities {
  readonly dockerIsolation: ProviderCapabilityState;
  readonly worktreeIsolation: ProviderCapabilityState;
  readonly mcpServers: ProviderCapabilityState;
  readonly jsonSchema: ProviderCapabilityState;
  readonly streamJson: ProviderCapabilityState;
  readonly thinkingMode: ProviderCapabilityState;
  readonly reasoningEffort: ProviderCapabilityState;
}

interface FixedProviderCommandSpec {
  readonly kind: 'fixed';
  readonly command: string;
  readonly args: readonly string[];
}

interface ConfiguredClaudeCommandSpec {
  readonly kind: 'configured-claude';
}

export interface SpawnProviderInvokeSpec {
  readonly lane: 'spawn';
}

export interface AcpStdioProviderInvokeSpec {
  readonly lane: 'acp-stdio';
  readonly transport: 'stdio';
}

export type ProviderInvokeSpec = SpawnProviderInvokeSpec | AcpStdioProviderInvokeSpec;

export type ProviderCommandSpec = FixedProviderCommandSpec | ConfiguredClaudeCommandSpec;

export interface ProviderDocsMetadata {
  readonly label: string;
  readonly setupHeading: string;
}

export interface ProviderDockerMountPreset {
  readonly host: string;
  readonly container: string;
  readonly readonly: boolean;
}

export interface ProviderDockerMetadata {
  readonly mount: ProviderDockerMountPreset;
  readonly envPassthrough: readonly string[];
  // False when the mounted dir doesn't hold the secret (auth is via an envPassthrough token).
  readonly credentialInMount?: boolean;
  // Shell command that installs this provider's CLI inside the Debian-based cluster image, run as
  // a docker-cached build layer for the per-provider image variant. Omit for providers already
  // baked into the base image (e.g. Claude) or not installable via a single command.
  readonly install?: string;
}

export interface ProviderRegistryEntry {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly displayName: string;
  readonly binary: string;
  readonly command: ProviderCommandSpec;
  readonly invoke: ProviderInvokeSpec;
  readonly installInstructions: string;
  readonly authInstructions: string;
  readonly credentialPaths: readonly string[];
  readonly credentialEnvKeys: readonly string[];
  readonly settingsFields: readonly string[];
  readonly settingsDefaults?: Readonly<Record<string, unknown>>;
  readonly settingsValidator?: (settings: Record<string, unknown>) => string | null;
  readonly availabilityProbe?: 'command' | 'help-or-version';
  readonly capabilities: ProviderCapabilities;
  readonly docs: ProviderDocsMetadata;
  readonly docker: ProviderDockerMetadata;
  readonly defaultLevels: Readonly<{
    readonly min: ModelLevel;
    readonly default: ModelLevel;
    readonly max: ModelLevel;
  }>;
  readonly adapter: ProviderAdapter;
}

const STANDARD_CAPABILITIES: Readonly<
  Pick<ProviderCapabilities, 'dockerIsolation' | 'worktreeIsolation' | 'mcpServers' | 'streamJson' | 'thinkingMode'>
> = {
  dockerIsolation: true,
  worktreeIsolation: true,
  mcpServers: true,
  streamJson: true,
  thinkingMode: true,
};

const CLAUDE_DOCKER_ENV_PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'CLAUDE_CODE_USE_BEDROCK',
] as const;

const SPAWN_INVOKE = Object.freeze({ lane: 'spawn' }) as SpawnProviderInvokeSpec;
const ACP_STDIO_INVOKE = Object.freeze({
  lane: 'acp-stdio',
  transport: 'stdio',
}) as AcpStdioProviderInvokeSpec;

const kiroAdapter = createAcpAdapter({
  provider: 'kiro',
  displayName: 'Kiro',
  binary: 'kiro-cli',
  commandArgs: ['acp'],
  credentialEnvKeys: ['KIRO_API_KEY'],
  supportsPromptImages: true,
  supportsLoadSession: false,
  supportsSessionCancel: true,
  supportsSessionSetModel: false,
  supportsSessionSetMode: false,
  retryableErrorPatterns: [
    /\brate(?:[ _])?limit\b/i,
    /\btemporar(?:y|ily)\b/i,
    /\btimeout\b/i,
    /\bunavailable\b/i,
  ],
  permanentErrorPatterns: [
    /\bauth(?:entication)?\b/i,
    /\bapi[_ -]?key\b/i,
    /\bforbidden\b/i,
    /\bunauthorized\b/i,
    /\bcancelled\b/i,
    /\bmalformed\b/i,
    /\bunsupported\b/i,
  ],
});

export const providerRegistry = [
  {
    id: 'claude',
    aliases: ['anthropic'],
    displayName: 'Claude',
    binary: 'claude',
    command: { kind: 'configured-claude' },
    invoke: SPAWN_INVOKE,
    installInstructions:
      'npm install -g @anthropic-ai/claude-code\nOr (macOS): brew install claude',
    authInstructions: 'claude login',
    credentialPaths: ['~/.claude'],
    credentialEnvKeys: claudeAdapter.credentialEnvKeys,
    settingsFields: ['anthropicApiKey', 'bedrockApiKey', 'bedrockRegion'],
    capabilities: {
      ...STANDARD_CAPABILITIES,
      jsonSchema: true,
      reasoningEffort: true,
    },
    docs: {
      label: 'Claude',
      setupHeading: 'Claude Setup',
    },
    docker: {
      mount: {
        host: '~/.claude',
        container: '$HOME/.claude',
        readonly: true,
      },
      envPassthrough: CLAUDE_DOCKER_ENV_PASSTHROUGH,
    },
    defaultLevels: {
      min: claudeAdapter.defaultMinLevel,
      default: claudeAdapter.defaultLevel,
      max: claudeAdapter.defaultMaxLevel,
    },
    adapter: claudeAdapter,
  },
  {
    id: 'codex',
    aliases: ['openai'],
    displayName: 'Codex',
    binary: 'codex',
    command: { kind: 'fixed', command: 'codex', args: ['exec'] },
    invoke: SPAWN_INVOKE,
    installInstructions: 'npm install -g @openai/codex',
    authInstructions: 'codex login',
    credentialPaths: ['~/.config/codex', '~/.codex'],
    credentialEnvKeys: codexAdapter.credentialEnvKeys,
    settingsFields: [],
    capabilities: {
      ...STANDARD_CAPABILITIES,
      jsonSchema: true,
      reasoningEffort: true,
    },
    docs: {
      label: 'Codex',
      setupHeading: 'Codex Setup',
    },
    docker: {
      mount: {
        host: '~/.config/codex',
        container: '$HOME/.config/codex',
        readonly: true,
      },
      install: 'npm install -g @openai/codex',
      envPassthrough: [],
    },
    defaultLevels: {
      min: codexAdapter.defaultMinLevel,
      default: codexAdapter.defaultLevel,
      max: codexAdapter.defaultMaxLevel,
    },
    adapter: codexAdapter,
  },
  {
    id: 'gateway',
    aliases: [],
    displayName: 'Gateway',
    binary: 'node',
    command: { kind: 'fixed', command: 'node', args: [] },
    invoke: SPAWN_INVOKE,
    installInstructions: 'Bundled with Zeroshot; no external provider CLI install is required.',
    authInstructions:
      'Configure providerSettings.gateway.protocol, baseUrl, apiKey, model, maxTokens when required, and toolPolicy in Zeroshot settings.',
    credentialPaths: [],
    credentialEnvKeys: gatewayAdapter.credentialEnvKeys,
    settingsFields: [
      'protocol',
      'baseUrl',
      'apiKey',
      'headers',
      'model',
      'maxTokens',
      'toolPolicy',
    ],
    settingsDefaults: gatewaySettingsDefaults,
    settingsValidator: validateGatewaySettings,
    capabilities: {
      ...STANDARD_CAPABILITIES,
      mcpServers: false,
      jsonSchema: false,
      reasoningEffort: false,
    },
    docs: {
      label: 'Gateway',
      setupHeading: 'Gateway Setup',
    },
    docker: {
      mount: {
        host: '~/.zeroshot',
        container: '$HOME/.zeroshot',
        readonly: true,
      },
      envPassthrough: [],
    },
    defaultLevels: {
      min: gatewayAdapter.defaultMinLevel,
      default: gatewayAdapter.defaultLevel,
      max: gatewayAdapter.defaultMaxLevel,
    },
    adapter: gatewayAdapter,
  },
  {
    id: 'gemini',
    aliases: ['google'],
    displayName: 'Gemini',
    binary: 'gemini',
    command: { kind: 'fixed', command: 'gemini', args: [] },
    invoke: SPAWN_INVOKE,
    installInstructions: 'npm install -g @google/gemini-cli',
    authInstructions: 'gemini auth login',
    credentialPaths: ['~/.config/gcloud', '~/.config/gemini', '~/.gemini'],
    credentialEnvKeys: geminiAdapter.credentialEnvKeys,
    settingsFields: [],
    capabilities: {
      ...STANDARD_CAPABILITIES,
      jsonSchema: 'experimental',
      reasoningEffort: false,
    },
    docs: {
      label: 'Gemini',
      setupHeading: 'Gemini Setup',
    },
    docker: {
      mount: {
        host: '~/.config/gemini',
        container: '$HOME/.config/gemini',
        readonly: true,
      },
      install: 'npm install -g @google/gemini-cli',
      envPassthrough: [],
    },
    defaultLevels: {
      min: geminiAdapter.defaultMinLevel,
      default: geminiAdapter.defaultLevel,
      max: geminiAdapter.defaultMaxLevel,
    },
    adapter: geminiAdapter,
  },
  {
    id: 'opencode',
    aliases: [],
    displayName: 'Opencode',
    binary: 'opencode',
    command: { kind: 'fixed', command: 'opencode', args: ['run'] },
    invoke: SPAWN_INVOKE,
    installInstructions: 'See https://opencode.ai for installation instructions.',
    authInstructions: 'opencode auth login',
    credentialPaths: ['~/.local/share/opencode'],
    credentialEnvKeys: opencodeAdapter.credentialEnvKeys,
    settingsFields: [],
    capabilities: {
      ...STANDARD_CAPABILITIES,
      jsonSchema: 'experimental',
      reasoningEffort: true,
    },
    docs: {
      label: 'Opencode',
      setupHeading: 'Opencode Setup',
    },
    docker: {
      mount: {
        host: '~/.local/share/opencode',
        container: '$HOME/.local/share/opencode',
        readonly: true,
      },
      envPassthrough: [],
    },
    defaultLevels: {
      min: opencodeAdapter.defaultMinLevel,
      default: opencodeAdapter.defaultLevel,
      max: opencodeAdapter.defaultMaxLevel,
    },
    adapter: opencodeAdapter,
  },
  {
    id: 'pi',
    aliases: [],
    displayName: 'Pi',
    binary: 'pi',
    command: { kind: 'fixed', command: 'pi', args: [] },
    invoke: SPAWN_INVOKE,
    installInstructions:
      'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.3',
    authInstructions: 'pi\n/login',
    credentialPaths: ['~/.pi'],
    credentialEnvKeys: piAdapter.credentialEnvKeys,
    settingsFields: [],
    availabilityProbe: 'help-or-version',
    capabilities: {
      ...STANDARD_CAPABILITIES,
      mcpServers: false,
      jsonSchema: false,
      reasoningEffort: false,
    },
    docs: {
      label: 'Pi',
      setupHeading: 'Pi Setup',
    },
    docker: {
      mount: {
        host: '~/.pi',
        container: '$HOME/.pi',
        readonly: true,
      },
      envPassthrough: [],
    },
    defaultLevels: {
      min: piAdapter.defaultMinLevel,
      default: piAdapter.defaultLevel,
      max: piAdapter.defaultMaxLevel,
    },
    adapter: piAdapter,
  },
  {
    id: 'kiro',
    aliases: [],
    displayName: 'Kiro',
    binary: 'kiro-cli',
    command: { kind: 'fixed', command: 'kiro-cli', args: ['acp'] },
    invoke: ACP_STDIO_INVOKE,
    installInstructions: 'See https://kiro.dev/docs/cli/',
    authInstructions: 'See https://kiro.dev/docs/cli/authentication/',
    credentialPaths: ['~/.kiro'],
    credentialEnvKeys: kiroAdapter.credentialEnvKeys,
    settingsFields: [],
    capabilities: {
      ...STANDARD_CAPABILITIES,
      mcpServers: false,
      jsonSchema: false,
      reasoningEffort: false,
    },
    docs: {
      label: 'Kiro',
      setupHeading: 'Kiro Setup',
    },
    docker: {
      mount: {
        host: '~/.kiro',
        container: '$HOME/.kiro',
        readonly: true,
      },
      envPassthrough: ['KIRO_API_KEY'],
    },
    defaultLevels: {
      min: kiroAdapter.defaultMinLevel,
      default: kiroAdapter.defaultLevel,
      max: kiroAdapter.defaultMaxLevel,
    },
    adapter: kiroAdapter,
  },
  {
    id: 'copilot',
    aliases: [],
    displayName: 'Copilot',
    binary: 'copilot',
    command: { kind: 'fixed', command: 'copilot', args: [] },
    invoke: SPAWN_INVOKE,
    installInstructions: 'npm install -g @github/copilot',
    // Docker/CI can't use the keychain token; export COPILOT_GITHUB_TOKEN instead.
    authInstructions: 'copilot\n/login\n(Docker/CI: export COPILOT_GITHUB_TOKEN=<token>)',
    credentialPaths: ['~/.copilot'],
    credentialEnvKeys: copilotAdapter.credentialEnvKeys,
    settingsFields: [],
    availabilityProbe: 'help-or-version',
    // MCP servers pass through via the `--additional-mcp-config` CLI flag (see copilot adapter
    // addMcpArgs). No native output-schema or reasoning-effort flag.
    capabilities: {
      ...STANDARD_CAPABILITIES,
      mcpServers: true,
      jsonSchema: false,
      reasoningEffort: false,
    },
    docs: {
      label: 'Copilot',
      setupHeading: 'Copilot Setup',
    },
    docker: {
      mount: {
        host: '~/.copilot',
        container: '$HOME/.copilot',
        readonly: true,
      },
      install: 'npm install -g @github/copilot',
      envPassthrough: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
      credentialInMount: false, // token is in the OS keychain, not ~/.copilot
    },
    defaultLevels: {
      min: copilotAdapter.defaultMinLevel,
      default: copilotAdapter.defaultLevel,
      max: copilotAdapter.defaultMaxLevel,
    },
    adapter: copilotAdapter,
  },
] as const satisfies readonly ProviderRegistryEntry[];

type RegistryProviderId = (typeof providerRegistry)[number]['id'];
type RegistryProviderAlias = (typeof providerRegistry)[number]['aliases'][number];

export const providerIds = providerRegistry.map((entry) => entry.id) as readonly RegistryProviderId[];
export const providerAliases = providerRegistry.flatMap((entry) => entry.aliases) as readonly RegistryProviderAlias[];
export const knownProviderNames = providerRegistry.flatMap((entry) => [entry.id, ...entry.aliases]) as readonly (
  | RegistryProviderId
  | RegistryProviderAlias
)[];

export const providerAliasMap: Readonly<Record<string, RegistryProviderId>> = Object.freeze(
  providerRegistry.reduce<Record<string, RegistryProviderId>>((result, entry) => {
    result[entry.id] = entry.id;
    for (const alias of entry.aliases) {
      result[alias] = entry.id;
    }
    return result;
  }, {})
);

export function normalizeProviderName(name: string): RegistryProviderId | string {
  const normalized = name.toLowerCase();
  return providerAliasMap[normalized] ?? name;
}

export function listProviderRegistryEntries(): readonly ProviderRegistryEntry[] {
  return providerRegistry;
}

export function findProviderRegistryEntry(name: string | null | undefined): ProviderRegistryEntry | undefined {
  if (!name) return undefined;
  const normalized = normalizeProviderName(name);
  return providerRegistry.find((entry) => entry.id === normalized);
}

export function getProviderRegistryEntry(name: string): ProviderRegistryEntry {
  const entry = findProviderRegistryEntry(name);
  if (entry) return entry;
  throw new Error(`Unknown provider: ${name}. Valid: ${providerIds.join(', ')}`);
}

export function resolveProviderCommand(name: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const entry = getProviderRegistryEntry(name);
  if (entry.command.kind === 'configured-claude') {
    return resolveClaudeCommand();
  }
  return {
    command: entry.command.command,
    args: entry.command.args,
  };
}

export function supportsProviderCapability(
  name: string,
  capability: keyof ProviderCapabilities
): boolean {
  return getProviderRegistryEntry(name).capabilities[capability] === true;
}
