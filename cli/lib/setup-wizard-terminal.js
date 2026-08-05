const chalk = require('chalk');
const {
  CANCEL_KEYS,
  beginTerminal,
  createKeyReader,
  createSelectionState,
  parseKeys,
  reduceSelection,
} = require('./setup-wizard-input');

const WIZARD_WIDTH = 74;
const WIZARD_SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function forcedColorLevel(env) {
  if (!Object.prototype.hasOwnProperty.call(env, 'FORCE_COLOR')) return null;
  const forced = String(env.FORCE_COLOR).trim();
  if (forced === '' || forced === 'true') return 1;
  const parsed = Number(forced);
  return Number.isInteger(parsed) ? Math.max(0, Math.min(3, parsed)) : 1;
}

function colorLevel(stdout, env) {
  if (Object.prototype.hasOwnProperty.call(env, 'NO_COLOR') || env.TERM === 'dumb') return 0;
  const forced = forcedColorLevel(env);
  if (forced !== null) return forced;
  if (!stdout.isTTY) return 0;
  const depth = typeof stdout.getColorDepth === 'function' ? stdout.getColorDepth(env) : 8;
  if (depth >= 24) return 3;
  if (depth >= 8) return 2;
  return 1;
}

function accentStyle(colors, level) {
  if (level >= 3) return colors.hex('#c2240c');
  if (level >= 2) return colors.ansi256(130);
  return colors.red;
}

function createWizardTheme(stdout, env = process.env) {
  const level = colorLevel(stdout, env);
  const colors = new chalk.Instance({ level });
  const accent = accentStyle(colors, level);
  return {
    color: level > 0,
    accent,
    bold: colors.bold,
    dim: colors.dim,
    success: colors.green,
    warning: colors.yellow,
    danger: colors.red,
    plain: (text) => String(text),
  };
}

function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, '');
}

function displayWidth(text) {
  return [...stripAnsi(text)].length;
}

function fit(text, maxWidth) {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  const plain = stripAnsi(text);
  return `${[...plain].slice(0, maxWidth - 1).join('')}…`;
}

function terminalWidth(stdout) {
  const columns = Number.isInteger(stdout.columns) ? stdout.columns : WIZARD_WIDTH;
  return Math.max(12, Math.min(WIZARD_WIDTH, columns - 2));
}

function padEndPlain(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function stepGlyph(state) {
  if (state === 'done') return '◆';
  if (state === 'active') return '*';
  if (state === 'failed') return '!';
  return '◇';
}

function stepGlyphStyle(theme, state) {
  if (state === 'failed') return theme.danger;
  if (state === 'active') return theme.accent;
  return theme.plain;
}

function stepHead(theme, state, title, { meta = '', width = WIZARD_WIDTH } = {}) {
  const glyph = stepGlyph(state);
  const glyphStyle = stepGlyphStyle(theme, state);
  const titleStyle = state === 'active' ? theme.bold : theme.plain;
  const left = `${glyph} ${title}`;
  const right = fit(meta, Math.max(0, width - displayWidth(left) - 3));
  const dots = Math.max(2, width - displayWidth(left) - displayWidth(right) - (right ? 2 : 1));
  return ` ${glyphStyle(glyph)} ${titleStyle(title)} ${theme.dim('·'.repeat(dots))}${right ? ` ${right}` : ''}`;
}

function gutter(theme, text = '') {
  return ` ${theme.dim('|')}${text ? ` ${text}` : ''}`;
}

function line(stdout, text = '') {
  stdout.write(`${text}\n`);
}

class LiveRegion {
  constructor(stdout) {
    this.stdout = stdout;
    this.lineCount = 0;
  }

  _erase() {
    if (this.lineCount === 0) return;
    this.stdout.write('\r');
    if (this.lineCount > 1) this.stdout.write(`\x1b[${this.lineCount - 1}A`);
    for (let index = 0; index < this.lineCount; index += 1) {
      this.stdout.write('\x1b[2K');
      if (index < this.lineCount - 1) this.stdout.write('\n');
    }
    if (this.lineCount > 1) this.stdout.write(`\x1b[${this.lineCount - 1}A`);
    this.stdout.write('\r');
    this.lineCount = 0;
  }

  paint(lines) {
    this._erase();
    const normalized = lines.map((item) => String(item));
    if (normalized.length === 0) return;
    this.stdout.write(normalized.join('\n'));
    this.lineCount = normalized.length;
  }

  clear() {
    this._erase();
  }

  commit(lines) {
    this.paint(lines);
    if (this.lineCount > 0) this.stdout.write('\n');
    this.lineCount = 0;
  }
}

function choiceRadio(theme, choice, selected) {
  if (choice.disabled) return theme.dim('○');
  return selected ? theme.accent('◉') : '○';
}

function choiceLabel(theme, choice, selected) {
  if (choice.disabled) return theme.dim(choice.label);
  return selected ? theme.bold(choice.label) : choice.label;
}

function defaultChoiceFrame({ theme, title, meta, choices, state, stdout, orientation }) {
  const width = terminalWidth(stdout);
  const rows = [stepHead(theme, 'active', title, { meta, width }), gutter(theme)];
  if (orientation === 'horizontal') {
    const actions = choices
      .map((choice, index) => {
        const selected = index === state.selected;
        const label = selected ? theme.bold(choice.label) : theme.dim(choice.label);
        return `${selected ? '▸' : ' '} ${label}`;
      })
      .join('   ');
    rows.push(gutter(theme, fit(actions, width - 3)));
    rows.push(gutter(theme));
    rows.push(gutter(theme, theme.dim('←→ choose · ↵ confirm · esc cancel')));
    return rows;
  }
  choices.forEach((choice, index) => {
    const selected = index === state.selected;
    const marker = selected ? theme.accent('▸') : ' ';
    const radio = choiceRadio(theme, choice, selected);
    const label = choiceLabel(theme, choice, selected);
    rows.push(gutter(theme, fit(`${marker} ${radio} ${label}`, width - 3)));
  });
  rows.push(gutter(theme));
  rows.push(gutter(theme, theme.dim('↑↓ move · ↵ confirm · esc cancel')));
  return rows;
}

async function selectChoice({
  stdout,
  reader,
  live = new LiveRegion(stdout),
  theme = createWizardTheme(stdout),
  title,
  meta = '',
  choices,
  initial = 0,
  orientation = 'vertical',
  renderFrame = defaultChoiceFrame,
}) {
  let state = createSelectionState(choices, initial);
  if (state.selected < 0) return null;
  live.paint(renderFrame({ theme, title, meta, choices, state, stdout, orientation }));
  while (state.status === 'active') {
    const key = await reader.read();
    const next = reduceSelection(state, key, choices, orientation);
    if (key === 'resize' || next !== state) {
      state = next;
      if (state.status === 'active') {
        live.paint(renderFrame({ theme, title, meta, choices, state, stdout, orientation }));
      }
    }
  }
  live.clear();
  return state.status === 'confirmed' ? state.value : null;
}

module.exports = {
  CANCEL_KEYS,
  LiveRegion,
  WIZARD_SPINNER,
  WIZARD_WIDTH,
  beginTerminal,
  createKeyReader,
  createSelectionState,
  createWizardTheme,
  displayWidth,
  fit,
  gutter,
  line,
  padEndPlain,
  parseKeys,
  reduceSelection,
  selectChoice,
  stepHead,
  stripAnsi,
  terminalWidth,
};
