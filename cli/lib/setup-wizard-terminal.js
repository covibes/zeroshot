const CANCEL_KEYS = new Set(['escape', 'ctrl-c']);

function line(stdout, text = '') {
  stdout.write(`${text}\n`);
}

function keyForCharacter(character) {
  if (character === '\x03') return 'ctrl-c';
  if (character === '\x1b') return 'escape';
  if (character === '\r' || character === '\n') return 'enter';
  return /^[1-9]$/.test(character) ? character : null;
}

function parseKeys(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const keys = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('\x1b[A', index) || text.startsWith('\x1b[B', index)) {
      keys.push(text[index + 2] === 'A' ? 'up' : 'down');
      index += 3;
      continue;
    }
    const key = keyForCharacter(text[index]);
    if (key) keys.push(key);
    index += 1;
  }
  return keys;
}

function createKeyReader(stdin) {
  const queued = [];
  const waiters = [];
  const onData = (chunk) => {
    for (const key of parseKeys(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(key);
      else queued.push(key);
    }
  };
  stdin.on('data', onData);
  return {
    read() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      stdin.off('data', onData);
    },
  };
}

function beginTerminal(stdin, stdout) {
  const wasRaw = stdin.isRaw === true;
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  if (typeof stdin.resume === 'function') stdin.resume();
  stdout.write('\x1b[?25l');
  return () => {
    stdout.write('\x1b[?25h');
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
    if (typeof stdin.pause === 'function') stdin.pause();
  };
}

function renderChoices(stdout, title, choices, selected) {
  line(stdout, `\n${title}`);
  choices.forEach((choice, index) => {
    const marker = index === selected ? '>' : ' ';
    line(stdout, `  ${index + 1}) ${marker} ${choice.label}`);
  });
  line(stdout, 'Use arrows or number keys, then Enter. Escape cancels.');
}

function nextEnabledChoice(choices, selected, direction) {
  let next = selected;
  do {
    next = (next + direction + choices.length) % choices.length;
  } while (choices[next].disabled && next !== selected);
  return next;
}

function numberedChoice(key, choices) {
  if (!/^[1-9]$/.test(key)) return undefined;
  const choice = choices[Number(key) - 1];
  return choice && !choice.disabled ? choice.value : undefined;
}

async function selectChoice({ stdout, reader, title, choices, initial = 0 }) {
  let selected = Math.max(
    0,
    choices.findIndex((choice, index) => index >= initial && !choice.disabled)
  );
  renderChoices(stdout, title, choices, selected);
  while (true) {
    const key = await reader.read();
    if (CANCEL_KEYS.has(key)) return null;
    const numbered = numberedChoice(key, choices);
    if (numbered !== undefined) return numbered;
    if (key === 'up' || key === 'down') {
      selected = nextEnabledChoice(choices, selected, key === 'up' ? -1 : 1);
      line(stdout, `Selected: ${choices[selected].label}`);
    }
    if (key === 'enter' && !choices[selected].disabled) return choices[selected].value;
  }
}

module.exports = { beginTerminal, createKeyReader, line, parseKeys, selectChoice };
