const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyEdits } = require('jsonc-parser');
const { parseCatalog, compareCatalogs, displayKey, keyId, canInsert, missingKeyEdits } = require('../dist/catalog.cjs');

const catalog = value => parseCatalog(JSON.stringify(value));
const differences = (reference, target) => compareCatalogs(catalog(reference), catalog(target));

test('reports lost and renamed interpolation parameters with reference locations', () => {
  const issues = differences({ greeting: 'Hello {{name}}, order {id}' }, { greeting: 'Olá {{nome}}, pedido {id}' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'placeholder');
  assert.match(issues[0].message, /missing name; unexpected nome/);
  assert.ok(issues[0].reference.length > 0);
});

test('allows placeholder reordering, repetition, nested names and i18next formatters', () => {
  assert.deepEqual(differences({ text: '{{user.name}} owes {{amount, currency}}' }, { text: '{{amount, currency}}: {{- user.name}} / {{user.name}}' }), []);
  assert.deepEqual(differences({ text: 'Hi {name}' }, { text: '{name}, {name}!' }), []);
});

test('can disable placeholder checks or restrict their syntax', () => {
  const a = catalog({ text: '{name} {{count}}' }), b = catalog({ text: '{other} {{count}}' });
  assert.deepEqual(compareCatalogs(a, b, 'none'), []);
  assert.deepEqual(compareCatalogs(a, b, 'i18next'), []);
  assert.equal(compareCatalogs(a, b, 'braces').length, 1);
  assert.deepEqual(differences({ text: 'Hi {name}' }, { text: '' }), []);
});

test('compares keys without comparing translated values', () => {
  assert.deepEqual(differences({ save: 'Save' }, { save: 'Salvar' }), []);
});

test('finds nested missing keys and extra keys', () => {
  const issues = differences({ menu: { save: 'Save', close: 'Close' } }, { menu: { save: 'Salvar' }, old: 'Old' });
  assert.deepEqual(issues.map(({ code, path }) => ({ code, path })), [
    { code: 'missing', path: ['menu', 'close'] }, { code: 'extra', path: ['old'] },
  ]);
});

test('anchors a missing key at its nearest existing object', () => {
  const source = '{\n  "menu": {\n    "save": "Save"\n  }\n}';
  const target = parseCatalog(source);
  const issue = compareCatalogs(catalog({ menu: { save: 'Save', nested: { close: 'Close' } } }), target)[0];
  assert.equal(source[issue.offset], '{');
  assert.equal(issue.offset, source.indexOf('{', 1));
  assert.ok(issue.reference.length > 0);
});

test('keeps literal dots separate from nested paths', () => {
  const parsed = catalog({ 'menu.save': 'Flat', menu: { save: 'Nested' } });
  assert.equal(parsed.entries.size, 2);
  assert.equal(displayKey(['menu.save']), '["menu.save"]');
  assert.equal(displayKey(['menu', 'save']), 'menu.save');
  assert.equal(differences({ 'menu.save': 'Flat' }, { menu: { save: 'Nested' } }).length, 2);
});

test('handles empty, Unicode, escaped, and prototype-like property names', () => {
  const parsed = parseCatalog('{"":"empty key","á":"unicode","quote\\\"":"quoted","__proto__":"safe","constructor":"safe"}');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.entries.size, 5);
  assert.equal(parsed.entries.get(keyId(['__proto__'])).value, 'safe');
  assert.equal(displayKey(['']), '[""]');
});

test('reports whitespace-only translations', () => {
  const parsed = catalog({ title: ' \n\t', good: 'Text' });
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.issues.map(issue => issue.code), ['empty']);
});

test('rejects duplicate keys at the same level including escaped names', () => {
  const parsed = parseCatalog('{"title":"One","ti\\u0074le":"Two"}');
  assert.equal(parsed.valid, false);
  assert.equal(parsed.issues[0].code, 'duplicate');
  assert.equal(parsed.issues[0].offset, 15);
  assert.deepEqual(compareCatalogs(parsed, catalog({})), []);
});

test('allows repeated key names in different objects', () => {
  const parsed = catalog({ a: { title: 'A' }, b: { title: 'B' } });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.issues.length, 0);
});

for (const input of ['', '{', '{"a":}', '{"a":"A",}', '{/* comment */ "a":"A"}', '{} {}']) {
  test(`reports invalid JSON: ${JSON.stringify(input)}`, () => {
    const parsed = parseCatalog(input);
    assert.equal(parsed.valid, false);
    assert.ok(parsed.issues.some(issue => issue.code === 'json'));
    assert.deepEqual(compareCatalogs(catalog({ key: 'Key' }), parsed), []);
  });
}

for (const value of [[], null, true, 1, 'text']) {
  test(`rejects a non-object root: ${JSON.stringify(value)}`, () => {
    const parsed = catalog(value);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.issues[0].code, 'root');
  });
}

test('reports unsupported values without emitting missing-key noise', () => {
  const parsed = catalog({ list: ['A'], count: 1, flag: false, nil: null });
  assert.equal(parsed.valid, false);
  assert.equal(parsed.issues.length, 4);
  assert.ok(parsed.issues.every(issue => issue.code === 'value'));
  assert.deepEqual(compareCatalogs(catalog({ missing: 'Missing' }), parsed), []);
});

test('allows empty objects as groups', () => {
  assert.deepEqual(differences({ group: {} }, {}), []);
  assert.equal(catalog({ group: {} }).entries.size, 0);
});

test('preserves locations with a BOM, CRLF, and non-ASCII text', () => {
  const input = '\uFEFF{\r\n  "title": "Olá 🌍",\r\n  "empty": ""\r\n}';
  const parsed = parseCatalog(input);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.entries.get(keyId(['empty'])).offset, input.indexOf('"empty"'));
  assert.equal(input.slice(parsed.issues[0].offset, parsed.issues[0].offset + parsed.issues[0].length), '""');
});

test('adds a missing nested key without changing existing values', () => {
  const input = '{\n  "menu": {\n    "save": "Salvar"\n  }\n}\n';
  const edited = applyEdits(input, missingKeyEdits(input, ['menu', 'close'], true, 2));
  assert.deepEqual(JSON.parse(edited), { menu: { save: 'Salvar', close: '' } });
  assert.match(edited, /    "close": ""/);
  assert.ok(edited.endsWith('\n'));
});

test('creates missing parent objects and preserves CRLF and tabs', () => {
  const input = '{\r\n\t"save": "Salvar"\r\n}\r\n';
  const edited = applyEdits(input, missingKeyEdits(input, ['menu', 'close'], false, 4));
  assert.deepEqual(JSON.parse(edited), { save: 'Salvar', menu: { close: '' } });
  assert.match(edited, /\t\t"close"/);
  assert.equal(edited.replaceAll('\r\n', '').includes('\n'), false);
});

test('does not overwrite an existing value or object', () => {
  for (const input of ['{"menu":"Menu"}', '{"menu":{}}']) {
    assert.equal(canInsert(parseCatalog(input), ['menu']), false);
    assert.deepEqual(missingKeyEdits(input, ['menu'], true, 2), []);
  }
  assert.deepEqual(missingKeyEdits('{"menu":"Menu"}', ['menu', 'close'], true, 2), []);
  assert.deepEqual(missingKeyEdits('{bad', ['key'], true, 2), []);
});

test('inserts a literal dotted key separately from a nested key', () => {
  const edited = applyEdits('{"menu":{"save":"Salvar"}}', missingKeyEdits('{"menu":{"save":"Salvar"}}', ['menu.save'], true, 2));
  assert.deepEqual(JSON.parse(edited), { menu: { save: 'Salvar' }, 'menu.save': '' });
});

test('inserts safely named __proto__ keys as ordinary JSON properties', () => {
  const edited = applyEdits('{}', missingKeyEdits('{}', ['__proto__', 'label'], true, 2));
  const parsed = parseCatalog(edited);
  assert.equal(parsed.entries.get(keyId(['__proto__', 'label'])).value, '');
  assert.equal({}.label, undefined);
});
