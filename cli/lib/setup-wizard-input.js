const CANCEL_KEYS = new Set(['escape', 'ctrl-c', 'q']);

function keyForCharacter(character) {
  if (character === '\x03') return 'ctrl-c';
  if (character === '\x1b') return 'escape';
  if (character === '\r' || character === '\n') return 'enter';
  if (character === ' ') return 'space';
  if (/^[1-9]$/.test(character)) return character;
  const aliases = { j: 'down', k: 'up', h: 'left', l: 'right', q: 'q' };
  return aliases[character] || null;
}

function parseKeys(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const keys = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('\x1b[A', index)) {
      keys.push('up');
      index += 3;
      continue;
    }
    if (text.startsWith('\x1b[B', index)) {
      keys.push('down');
      index += 3;
      continue;
    }
    if (text.startsWith('\x1b[C', index)) {
      keys.push('right');
      index += 3;
      continue;
    }
    if (text.startsWith('\x1b[D', index)) {
      keys.push('left');
      index += 3;
      continue;
    }
    const key = keyForCharacter(text[index]);
    if (key) keys.push(key);
    index += 1;
  }
  return keys;
}

function createKeyReader(stdin, stdout) {
  const queued = [];
  const waiters = [];
  const deliver = (key) => {
    const waiter = waiters.shift();
    if (waiter) waiter(key);
    else queued.push(key);
  };
  const onData = (chunk) => {
    for (const key of parseKeys(chunk)) deliver(key);
  };
  const onResize = () => deliver('resize');
  stdin.on('data', onData);
  if (stdout && typeof stdout.on === 'function') stdout.on('resize', onResize);
  return {
    read() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      stdin.off('data', onData);
      if (stdout && typeof stdout.off === 'function') stdout.off('resize', onResize);
    },
  };
}

function beginTerminal(stdin, stdout) {
  const wasRaw = stdin.isRaw === true;
  let restored = false;
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  if (typeof stdin.resume === 'function') stdin.resume();
  stdout.write('\x1b[?25l');
  return () => {
    if (restored) return;
    restored = true;
    stdout.write('\x1b[?25h');
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
    if (typeof stdin.pause === 'function') stdin.pause();
  };
}

function firstEnabledChoice(choices, initial) {
  for (let offset = 0; offset < choices.length; offset += 1) {
    const index = (Math.max(0, initial) + offset) % choices.length;
    if (!choices[index].disabled) return index;
  }
  return -1;
}

function nextEnabledChoice(choices, selected, direction) {
  if (choices.length === 0 || selected < 0) return selected;
  let next = selected;
  do {
    next = (next + direction + choices.length) % choices.length;
    if (!choices[next].disabled) return next;
  } while (next !== selected);
  return selected;
}

function createSelectionState(choices, initial = 0) {
  return { selected: firstEnabledChoice(choices, initial), status: 'active', value: undefined };
}

function numberedSelection(state, key, choices) {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  if (!choices[index] || choices[index].disabled) return state;
  return { selected: index, status: 'confirmed', value: choices[index].value };
}

function selectionDirection(key, orientation) {
  if (orientation === 'horizontal') {
    if (key === 'left' || key === 'up') return -1;
    if (key === 'right' || key === 'down') return 1;
    return 0;
  }
  if (key === 'up') return -1;
  if (key === 'down') return 1;
  return 0;
}

function reduceSelection(state, key, choices, orientation = 'vertical') {
  if (state.status !== 'active') return state;
  if (CANCEL_KEYS.has(key)) return { ...state, status: 'cancelled', value: null };
  const numbered = numberedSelection(state, key, choices);
  if (numbered) return numbered;
  const direction = selectionDirection(key, orientation);
  if (direction !== 0) {
    return { ...state, selected: nextEnabledChoice(choices, state.selected, direction) };
  }
  if (key !== 'enter' || state.selected < 0 || choices[state.selected].disabled) return state;
  return { ...state, status: 'confirmed', value: choices[state.selected].value };
}

module.exports = {
  CANCEL_KEYS,
  beginTerminal,
  createKeyReader,
  createSelectionState,
  parseKeys,
  reduceSelection,
};
