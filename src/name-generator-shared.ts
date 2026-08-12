const ADJECTIVES = [
  // Colors
  'amber',
  'azure',
  'crimson',
  'emerald',
  'golden',
  'indigo',
  'jade',
  'ruby',
  'sapphire',
  'silver',
  'violet',
  'bronze',
  'coral',
  'ivory',
  'pearl',
  'platinum',
  'scarlet',
  'cobalt',
  'copper',
  'obsidian',
  'onyx',
  'opal',
  'topaz',
  'turquoise',
  // Nature
  'wandering',
  'bright',
  'silent',
  'ancient',
  'swift',
  'noble',
  'bold',
  'wild',
  'gentle',
  'hidden',
  'fierce',
  'calm',
  'frozen',
  'misty',
  'stormy',
  'sunny',
  // Cosmic
  'cosmic',
  'crystal',
  'electric',
  'lunar',
  'solar',
  'stellar',
  'astral',
  'orbital',
  'mystic',
  'quantum',
  'radiant',
  'twilight',
  'vivid',
  'zen',
  'infinite',
  'eternal',
  // Tech/Abstract
  'clever',
  'rapid',
  'steady',
  'agile',
  'nimble',
  'keen',
  'sharp',
  'quick',
  'prime',
  'binary',
  'neural',
  'atomic',
  'sonic',
  'hyper',
  'mega',
  'ultra',
  // Descriptive
  'blazing',
  'gleaming',
  'glowing',
  'shining',
  'burning',
  'flaming',
  'sparkling',
  'dazzling',
  'roaring',
  'rushing',
  'soaring',
  'flying',
  'rising',
  'falling',
  'spinning',
  'dancing',
] as const;

const NOUNS = [
  // Nature
  'forest',
  'river',
  'mountain',
  'ocean',
  'thunder',
  'canyon',
  'summit',
  'valley',
  'cascade',
  'glacier',
  'volcano',
  'desert',
  'meadow',
  'tundra',
  'jungle',
  'reef',
  // Space
  'star',
  'comet',
  'nebula',
  'galaxy',
  'pulsar',
  'quasar',
  'aurora',
  'eclipse',
  'meteor',
  'nova',
  'cosmos',
  'orbit',
  'void',
  'horizon',
  'zenith',
  'equinox',
  // Mythical
  'phoenix',
  'dragon',
  'griffin',
  'sphinx',
  'hydra',
  'kraken',
  'titan',
  'atlas',
  'oracle',
  'rune',
  'sigil',
  'glyph',
  'totem',
  'aegis',
  'aether',
  'flux',
  // Animals
  'falcon',
  'eagle',
  'wolf',
  'bear',
  'tiger',
  'hawk',
  'lion',
  'panther',
  'raven',
  'serpent',
  'shark',
  'owl',
  'fox',
  'lynx',
  'viper',
  'condor',
  // Architecture
  'citadel',
  'temple',
  'spire',
  'tower',
  'fortress',
  'bastion',
  'vault',
  'sanctum',
  'beacon',
  'arch',
  'bridge',
  'gate',
  'hall',
  'keep',
  'dome',
  'obelisk',
  // Abstract
  'cipher',
  'echo',
  'nexus',
  'prism',
  'relic',
  'vertex',
  'vortex',
  'pulse',
  'surge',
  'spark',
  'flame',
  'storm',
  'wave',
  'drift',
  'shift',
  'core',
] as const;

interface NameRandomSource {
  (): number;
}

function isNameRandomSource(value: unknown): value is NameRandomSource {
  return typeof value === 'function';
}

function nextNameRandomValue(): number {
  const randomSource: unknown = Reflect.get(Math, 'random');
  if (!isNameRandomSource(randomSource)) {
    throw new TypeError('Math.random must be a function');
  }
  return randomSource.call(Math);
}

function generateReadableName(adjectiveFallback?: string, nounFallback?: string): string {
  const adjective =
    ADJECTIVES[Math.floor(nextNameRandomValue() * ADJECTIVES.length)] ?? adjectiveFallback;
  const noun = NOUNS[Math.floor(nextNameRandomValue() * NOUNS.length)] ?? nounFallback;
  const number = Math.floor(nextNameRandomValue() * 100);

  return `${adjective}-${noun}-${number}`;
}

function generateNameSuffix(): string {
  return nextNameRandomValue().toString(36).slice(2, 6);
}

export = { generateReadableName, generateNameSuffix };
