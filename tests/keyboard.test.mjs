import assert from 'node:assert/strict';
import test from 'node:test';

const { createReaderKeyboard } = await import('../src/keyboard.ts');

function makeKeyboard({ active = true } = {}) {
  const commands = [];
  const pendingValues = [];
  let readerActive = active;
  const keyboard = createReaderKeyboard({
    execute: command => commands.push(command),
    isReaderActive: () => readerActive,
    onPendingChange: pending => pendingValues.push(pending),
  });
  return {
    commands,
    pendingValues,
    keyboard,
    setActive(value) { readerActive = value; },
  };
}

function key(overrides = {}) {
  return {
    type: 'keydown',
    key: '',
    isComposing: false,
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    ...overrides,
  };
}

test('h/j/k/l classify handled scroll commands with documented directions', () => {
  const { keyboard, commands } = makeKeyboard();
  const expected = [
    ['h', { type: 'scroll', dx: -1, dy: 0 }],
    ['j', { type: 'scroll', dx: 0, dy: 1 }],
    ['k', { type: 'scroll', dx: 0, dy: -1 }],
    ['l', { type: 'scroll', dx: 1, dy: 0 }],
  ];
  for (const [name, command] of expected) {
    assert.equal(keyboard.handle(key({ key: name })), 'handled');
    assert.deepEqual(commands.at(-1), command);
  }
  assert.deepEqual(commands, expected.map(([, command]) => command));
});

test('Ctrl+D/U/F/B classify half and full viewport scroll commands', () => {
  const { keyboard, commands } = makeKeyboard();
  const expected = [
    ['d', { type: 'scroll-half', dy: 1 }],
    ['u', { type: 'scroll-half', dy: -1 }],
    ['f', { type: 'scroll-page', dy: 1 }],
    ['b', { type: 'scroll-page', dy: -1 }],
  ];
  for (const [name, command] of expected) {
    assert.equal(keyboard.handle(key({ key: name, ctrlKey: true })), 'handled');
    assert.deepEqual(commands.at(-1), command);
  }
  assert.deepEqual(commands, expected.map(([, command]) => command));
});

test('gg jumps to the first page and G to the last', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'g' })), 'handled');
  assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
  assert.deepEqual(commands, [
    { type: 'go', page: 'first' },
    { type: 'go', page: 'last' },
  ]);
});

test('a count prefix jumps to a physical page with g or G', () => {
  for (const [sequence, page] of [[['4', '2', 'g', 'g'], 42], [['4', '2', 'G'], 42]]) {
    const { keyboard, commands } = makeKeyboard();
    for (const name of sequence.slice(0, -1)) {
      assert.equal(keyboard.handle(key({ key: name })), 'ignored');
    }
    assert.equal(keyboard.handle(key({ key: sequence.at(-1) })), 'handled');
    assert.deepEqual(commands, [{ type: 'go', page }]);
  }
});

test('a leading zero count reaches execute as page 0 for bounds validation', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: '0' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 0 }]);
});

test('+ zooms in, - out, and = resets to 100 percent', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: '+' })), 'handled');
  assert.equal(keyboard.handle(key({ key: '-' })), 'handled');
  assert.equal(keyboard.handle(key({ key: '=' })), 'handled');
  assert.deepEqual(commands, [
    { type: 'zoom', action: 'in' },
    { type: 'zoom', action: 'out' },
    { type: 'zoom', action: 'reset' },
  ]);
});

test('Shift+= producing key + zooms in, classified by key value only', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: '+', shiftKey: true })), 'handled');
  assert.deepEqual(commands, [{ type: 'zoom', action: 'in' }]);
});

test('a fits page and s fits width', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: 'a' })), 'handled');
  assert.equal(keyboard.handle(key({ key: 's' })), 'handled');
  assert.deepEqual(commands, [
    { type: 'fit', mode: 'page' },
    { type: 'fit', mode: 'width' },
  ]);
});

test('bound keys reject conflicting modifiers', () => {
  const { keyboard, commands } = makeKeyboard();
  const conflicts = [
    key({ key: 'h', ctrlKey: true }),
    key({ key: 'l', metaKey: true }),
    key({ key: 'j', shiftKey: true }),
    key({ key: 'k', altKey: true }),
    key({ key: 'a', ctrlKey: true }),
    key({ key: 's', metaKey: true }),
    key({ key: '+', ctrlKey: true }),
    key({ key: '-', metaKey: true }),
    key({ key: '=', altKey: true }),
    key({ key: 'd', ctrlKey: true, metaKey: true }),
    key({ key: 'u', ctrlKey: true, altKey: true }),
    key({ key: 'f', ctrlKey: true, shiftKey: true }),
    key({ key: 'b', ctrlKey: true, shiftKey: true, metaKey: true }),
  ];
  for (const event of conflicts) assert.equal(keyboard.handle(event), 'ignored');
  assert.deepEqual(commands, []);
});

test('IME composition and keyCode 229 are ignored even for bound keys', () => {
  const { keyboard, commands } = makeKeyboard();
  for (const event of [
    key({ key: 'j', isComposing: true }),
    key({ key: 'j', keyCode: 229 }),
    key({ key: 'g', keyCode: 229 }),
    key({ key: 'd', ctrlKey: true, isComposing: true }),
  ]) {
    assert.equal(keyboard.handle(event), 'ignored');
  }
  assert.equal(keyboard.handle(key({ key: 'j' })), 'handled');
  assert.deepEqual(commands, [{ type: 'scroll', dx: 0, dy: 1 }]);
});

test('editable targets ignore everything including Escape', () => {
  const targets = [
    { closest: selector => (selector.includes('input') ? { tagName: 'INPUT' } : null) },
    { closest: selector => (selector.includes('textarea') ? { tagName: 'TEXTAREA' } : null) },
    { closest: selector => (selector.includes('select') ? { tagName: 'SELECT' } : null) },
    { closest: selector => (selector.includes('contenteditable="true"') ? { tagName: 'DIV' } : null) },
    { closest: selector => (selector.includes('contenteditable=""') ? { tagName: 'DIV' } : null) },
  ];
  for (const target of targets) {
    const { keyboard, commands, pendingValues } = makeKeyboard();
    for (const event of [
      key({ key: 'j', target }),
      key({ key: '1', target }),
      key({ key: 'g', target }),
      key({ key: 'Escape', target }),
      key({ key: 'd', ctrlKey: true, target }),
    ]) {
      assert.equal(keyboard.handle(event), 'ignored');
    }
    assert.deepEqual(commands, []);
    assert.deepEqual(pendingValues, []);
    // Parser state is untouched by dialog-owned input.
    assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
    assert.deepEqual(commands, [{ type: 'go', page: 'last' }]);
  }
});

test('unbound keys and shortcut passthroughs are ignored', () => {
  const { keyboard, commands, pendingValues } = makeKeyboard();
  const ignored = [
    key({ key: 'x' }),
    key({ key: 'o', ctrlKey: true }),
    key({ key: 'o', metaKey: true }),
    key({ key: 'H' }),
    key({ key: 'J' }),
    key({ key: 'K' }),
    key({ key: 'L' }),
    key({ key: 'A' }),
    key({ key: 'S' }),
    key({ key: 'F5' }),
    key({ key: 'Tab' }),
    key({ key: '!' }),
    key({ key: '1', ctrlKey: true }),
    key({ key: 'G', ctrlKey: true }),
  ];
  for (const event of ignored) assert.equal(keyboard.handle(event), 'ignored');
  assert.deepEqual(commands, []);
  assert.deepEqual(pendingValues, []);
});

test('keyup events are ignored entirely', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: 'j', type: 'keyup' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'Escape', type: 'keyup' })), 'ignored');
  assert.deepEqual(commands, []);
});

test('digits accumulate into a pending count and display through onPendingChange', () => {
  const { keyboard, pendingValues, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: '1' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: '2' })), 'ignored');
  assert.deepEqual(pendingValues, ['1', '12']);
  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.deepEqual(pendingValues, ['1', '12', '12g']);
  assert.equal(keyboard.handle(key({ key: 'g' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 12 }]);
  assert.deepEqual(pendingValues, ['1', '12', '12g', '']);
});

test('the count caps at nine digits and keeps the first nine', () => {
  const { keyboard, pendingValues, commands } = makeKeyboard();
  for (const digit of '1234567890') keyboard.handle(key({ key: digit }));
  assert.deepEqual(pendingValues.at(-1), '123456789');
  assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 123456789 }]);
});

test('an unbound key while digits are pending cancels the sequence and is ignored', () => {
  const { keyboard, pendingValues, commands } = makeKeyboard();
  keyboard.handle(key({ key: '4' }));
  keyboard.handle(key({ key: '2' }));
  assert.equal(keyboard.handle(key({ key: 'x' })), 'ignored');
  assert.deepEqual(pendingValues, ['4', '42', '']);
  assert.deepEqual(commands, []);
  // Cancelled state does not leak into the next sequence.
  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'g' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 'first' }]);
});

test('anything but a second g after g cancels the pending sequence', () => {
  for (const cancel of ['G', 'j', '3']) {
    const { keyboard, pendingValues, commands } = makeKeyboard();
    keyboard.handle(key({ key: '1' }));
    keyboard.handle(key({ key: 'g' }));
    assert.equal(keyboard.handle(key({ key: cancel })), 'ignored');
    assert.deepEqual(pendingValues.at(-1), '');
    assert.deepEqual(commands, []);
  }
});

test('Escape clears a pending sequence as handled and is ignored with nothing pending', () => {
  const { keyboard, pendingValues, commands } = makeKeyboard();
  keyboard.handle(key({ key: '7' }));
  assert.equal(keyboard.handle(key({ key: 'Escape' })), 'handled');
  assert.deepEqual(pendingValues, ['7', '']);
  assert.deepEqual(commands, []);
  pendingValues.length = 0;
  assert.equal(keyboard.handle(key({ key: 'Escape' })), 'ignored');
  assert.deepEqual(pendingValues, []);
  // Parser still works after the ignored Escape.
  assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 'last' }]);
});

test('reset clears pending state like Escape without consuming a key', () => {
  const { keyboard, pendingValues, commands } = makeKeyboard();
  keyboard.handle(key({ key: '9' }));
  keyboard.reset();
  assert.deepEqual(pendingValues, ['9', '']);
  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'g' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 'first' }]);
  pendingValues.length = 0;
  keyboard.reset();
  assert.deepEqual(pendingValues, []);
});

test('an inactive reader ignores every key except Escape clearing pending', () => {
  const { keyboard, pendingValues, commands, setActive } = makeKeyboard({ active: false });
  for (const event of [
    key({ key: 'j' }),
    key({ key: 'G' }),
    key({ key: 'd', ctrlKey: true }),
    key({ key: '5' }),
    key({ key: 'g' }),
    key({ key: '+' }),
    key({ key: 'Escape' }),
  ]) {
    assert.equal(keyboard.handle(event), 'ignored');
  }
  assert.deepEqual(commands, []);
  assert.deepEqual(pendingValues, []);
  // Pending state can only come from an earlier active period.
  setActive(true);
  keyboard.handle(key({ key: '1' }));
  keyboard.handle(key({ key: '2' }));
  setActive(false);
  assert.equal(keyboard.handle(key({ key: 'G' })), 'ignored');
  assert.deepEqual(commands, []);
  assert.equal(keyboard.handle(key({ key: 'Escape' })), 'handled');
  assert.deepEqual(pendingValues.at(-1), '');
  setActive(true);
  assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 'last' }]);
});

test('repeat keydowns repeat scroll commands like fresh presses', () => {
  const { keyboard, commands } = makeKeyboard();
  for (let index = 0; index < 3; index += 1) {
    assert.equal(keyboard.handle(key({ key: 'j', repeat: index > 0 })), 'handled');
    assert.equal(keyboard.handle(key({ key: 'd', ctrlKey: true, repeat: index > 0 })), 'handled');
  }
  assert.deepEqual(commands, [
    { type: 'scroll', dx: 0, dy: 1 },
    { type: 'scroll-half', dy: 1 },
    { type: 'scroll', dx: 0, dy: 1 },
    { type: 'scroll-half', dy: 1 },
    { type: 'scroll', dx: 0, dy: 1 },
    { type: 'scroll-half', dy: 1 },
  ]);
});

test('repeated digits only accumulate subject to the cap', () => {
  const { keyboard, pendingValues, commands } = makeKeyboard();
  for (let index = 0; index < 12; index += 1) {
    keyboard.handle(key({ key: '9', repeat: index > 0 }));
  }
  assert.deepEqual(pendingValues.at(-1), '999999999');
  assert.equal(keyboard.handle(key({ key: 'G' })), 'handled');
  assert.deepEqual(commands, [{ type: 'go', page: 999999999 }]);
});

test('completed and cancelled sequences always report an empty pending state', () => {
  for (const sequence of [
    ['g', 'g'],
    ['2', 'G'],
    ['2', 'g', 'g'],
    ['5', 'q'],
    ['g', 'j'],
    ['1', '2', '3', 'Escape'],
  ]) {
    const { keyboard, pendingValues } = makeKeyboard();
    for (const name of sequence) keyboard.handle(key({ key: name }));
    assert.equal(pendingValues.at(-1), '');
    assert.ok(pendingValues.includes(''));
  }
});

test('gt and gT switch tabs, and gT tolerates shift while remaining chord-gated', () => {
  const { keyboard, commands } = makeKeyboard();
  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 't' })), 'handled');
  assert.deepEqual(commands, [{ type: 'tab', delta: 1 }]);

  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'T', shiftKey: true })), 'handled');
  assert.deepEqual(commands, [{ type: 'tab', delta: 1 }, { type: 'tab', delta: -1 }]);

  assert.equal(keyboard.handle(key({ key: 'g' })), 'ignored');
  assert.equal(keyboard.handle(key({ key: 'T', ctrlKey: true })), 'ignored');
  assert.deepEqual(commands.length, 2);
});

test('digits followed by gt complete the tab command like other g sequences', () => {
  const { keyboard, commands, pendingValues } = makeKeyboard();
  keyboard.handle(key({ key: '2' }));
  keyboard.handle(key({ key: 'g' }));
  assert.equal(pendingValues.at(-1), '2g');
  assert.equal(keyboard.handle(key({ key: 't' })), 'handled');
  assert.deepEqual(commands, [{ type: 'tab', delta: 1 }]);
  assert.equal(pendingValues.at(-1), '');
});
