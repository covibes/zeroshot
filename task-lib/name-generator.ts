/**
 * Human-readable name generator (like Weights & Biases)
 * Generates names like "wandering-forest-42" or "bright-star-17"
 *
 * No prefix - short forms used everywhere for simplicity
 */

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
];

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
];

// 96 adjectives × 96 nouns × 100 numbers = 921,600 combinations

/**
 * Generate a human-readable name
 * @param {string} _prefix - DEPRECATED: Ignored for backwards compat, short form always used
 * @returns {string} Human-readable name (e.g., 'wandering-forest-42')
 */
export function generateName(_prefix = ''): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] ?? 'amber';
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)] ?? 'forest';
  const number = Math.floor(Math.random() * 100);

  return `${adjective}-${noun}-${number}`;
}

/**
 * Generate a short unique suffix (for collision prevention)
 * @returns {string} Short random suffix (e.g., 'a3f9')
 */
export function generateSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
