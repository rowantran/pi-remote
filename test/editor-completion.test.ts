import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import {
  RemoteAutocompleteProvider, tokenizeFileReferences, transformPromptWithAttachments,
} from '../src/editor-completion.js';
import type { Attachment, PathCompletionResult } from '../src/files.js';

const signal = () => new AbortController().signal;
const empty = async (): Promise<PathCompletionResult> => ({ items: [], truncated: false });
function provider(completePath = empty) {
  return new RemoteAutocompleteProvider({ getCommands: async () => ({ commands: [] }), completePath, localCommands: [] });
}
const missing = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

// All readers and RPC methods are stubs. No test starts Pi or calls a model.
test('file tokenizer preserves exact spans and decodes quotes and backslash escapes', () => {
  const text = 'Read @src/main.ts and @"folder/my file.txt" then @folder/other\\ file.txt @\'single quoted\'.';
  assert.deepEqual(tokenizeFileReferences(text), [
    { path: 'src/main.ts', start: 5, end: 17 },
    { path: 'folder/my file.txt', start: 22, end: 43 },
    { path: 'folder/other file.txt', start: 49, end: 72 },
    { path: 'single quoted', start: 73, end: 89 },
  ]);
  const literals = String.raw`@"a\\b\"c.txt" @'single quoted' @file\ with\ spaces`;
  assert.deepEqual(tokenizeFileReferences(literals).map(reference => reference.path), ['a\\b"c.txt', 'single quoted', 'file with spaces']);
  for (const reference of tokenizeFileReferences(literals)) assert.equal(literals[reference.start], '@');
});

test('file references require token boundaries and ignore emails, escapes, and code', () => {
  const text = [
    'mail person@example.com or prefix@path \\@escaped @@double @user@example.com',
    '`@inline.txt` and ``@inline-two.txt``',
    '```typescript', '@inside-fence.ts', '```',
    '~~~', '@inside-other-fence.ts', '~~~',
    '(@real.txt) [@other.txt] @last.txt',
  ].join('\n');
  assert.deepEqual(tokenizeFileReferences(text).map(reference => reference.path), ['real.txt', 'other.txt', 'last.txt']);
  assert.deepEqual(tokenizeFileReferences('@"unfinished'), []);
  assert.deepEqual(tokenizeFileReferences('@"bad\nname"'), []);
  assert.deepEqual(tokenizeFileReferences('@"bad\x1bname"'), []);
  assert.deepEqual(tokenizeFileReferences('@'), []);
});

test('slash suggestions merge remote and local commands, cache requests, and sanitize labels', async () => {
  let calls = 0;
  const autocomplete = new RemoteAutocompleteProvider({
    getCommands: async () => { calls++; return { commands: [
      { name: 'fix', description: 'remote' }, { name: 'help', description: 'remote help' },
      { name: 'skill:test', description: 'skill' }, { name: 'bad\ncommand' },
      { name: 'warning', description: '\x1b[31m unsafe\nline' },
    ] }; },
    completePath: empty, localCommands: [{ name: 'help', description: 'local help' }],
  });
  const api: AutocompleteProvider = autocomplete;
  const [first, concurrent] = await Promise.all([
    api.getSuggestions(['/'], 0, 1, { signal: signal() }), api.getSuggestions(['/f'], 0, 2, { signal: signal() }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first?.items.map(item => item.value), ['/fix', '/help', '/skill:test', '/warning']);
  assert.equal(first?.items.find(item => item.value === '/help')?.description, 'local help');
  assert(!first?.items.at(-1)?.description?.includes('\x1b'));
  assert.equal(concurrent?.prefix, '/f');
  assert.deepEqual(concurrent?.items.map(item => item.value), ['/fix']);
  autocomplete.setCommands([{ name: 'replacement' }]);
  assert.deepEqual((await api.getSuggestions(['/'], 0, 1, { signal: signal() }))?.items.map(item => item.value), ['/help', '/replacement']);
  assert.equal(calls, 1);
  autocomplete.invalidateCommands();
  await api.getSuggestions(['/'], 0, 1, { signal: signal() });
  assert.equal(calls, 2);
});

test('failed remote command lookup still exposes local commands and updates do not request RPC', async () => {
  const autocomplete = new RemoteAutocompleteProvider({ getCommands: async () => { throw new Error('old daemon'); }, completePath: empty });
  assert.equal((await autocomplete.getSuggestions(['/att'], 0, 4, { signal: signal() }))?.items[0].value, '/attach');
  autocomplete.setCommands([{ name: 'custom' }]);
  assert.equal((await autocomplete.getSuggestions(['/cus'], 0, 4, { signal: signal() }))?.items[0].value, '/custom');
});

test('slash completion is only offered for the first prompt token', async () => {
  let commands = 0;
  const autocomplete = new RemoteAutocompleteProvider({ getCommands: async () => { commands++; return []; }, completePath: empty });
  for (const text of ['Please /he', '/help argument', '/folder/path', 'a\n/he', '`/he']) {
    const lines = text.split('\n');
    assert.equal(await autocomplete.getSuggestions(lines, lines.length - 1, lines.at(-1)!.length, { signal: signal() }), null);
  }
  assert.equal(commands, 0);
});

test('file completion sends only decoded remote prefixes, with no local file fallback', async () => {
  const prefixes: string[] = [];
  const autocomplete = provider(async prefix => {
    prefixes.push(prefix);
    return { items: [
      { value: 'folder/my file.txt', label: 'my file.txt', directory: false },
      { value: 'folder/my directory', label: 'my directory/', directory: true },
      { value: 'bad\nfile', label: 'bad', directory: false },
    ], truncated: false };
  });
  for (const [text, expected] of [
    ['Read @folder/my', 'folder/my'], ['Read @"folder/my fi', 'folder/my fi'],
    [String.raw`Read @folder/my\ fi`, 'folder/my fi'], ['@', ''], ['@~/file', '~/file'],
  ]) {
    const result = await autocomplete.getSuggestions([text], 0, text.length, { signal: signal() });
    assert.equal(prefixes.at(-1), expected);
    assert.equal(result?.items.length, 2);
    assert.equal(result?.items[1].value, 'folder/my directory/');
    assert(result?.prefix.startsWith('@'));
  }
  const count = prefixes.length;
  for (const text of ['folder/my', 'user@example.com', 'x@file', '`@code', '```\n@code', '@"done"', '@file ']) {
    const lines = text.split('\n');
    assert.equal(await autocomplete.getSuggestions(lines, lines.length - 1, lines.at(-1)!.length, { signal: signal(), force: true }), null);
  }
  assert.equal(prefixes.length, count);
});

test('completion ignores cancelled requests and lookup failures', async () => {
  let calls = 0;
  let complete!: (value: PathCompletionResult) => void;
  const autocomplete = provider(async () => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const controller = new AbortController(); controller.abort();
  assert.equal(await autocomplete.getSuggestions(['@f'], 0, 2, { signal: controller.signal }), null);
  assert.equal(calls, 0);
  const later = new AbortController();
  const pending = autocomplete.getSuggestions(['@f'], 0, 2, { signal: later.signal });
  later.abort(); complete({ items: [{ value: 'file', label: 'file', directory: false }], truncated: false });
  assert.equal(await pending, null);
  const failed = provider(async () => { throw new Error('disconnected'); });
  assert.equal(await failed.getSuggestions(['@f'], 0, 2, { signal: signal() }), null);
});

test('applying file completion quotes raw spaces, quotes, and escapes without changing other lines', () => {
  const autocomplete = provider();
  const original = ['first line', 'Read @fi'];
  const changed = autocomplete.applyCompletion(original, 1, 8, { value: 'file with spaces.txt', label: 'file' }, '@fi');
  assert.deepEqual(changed, { lines: ['first line', 'Read @"file with spaces.txt" '], cursorLine: 1, cursorCol: 29 });
  assert.deepEqual(original, ['first line', 'Read @fi']);
  assert.equal(tokenizeFileReferences(changed.lines[1])[0].path, 'file with spaces.txt');
  const unusual = 'a\\b"c.txt';
  const escaped = autocomplete.applyCompletion(['@a'], 0, 2, { value: unusual, label: unusual }, '@a');
  assert.equal(tokenizeFileReferences(escaped.lines[0])[0].path, unusual);
});

test('directory completion keeps trailing slash, adds no whitespace, and continues within quotes', async () => {
  const prefixes: string[] = [];
  const autocomplete = provider(async prefix => { prefixes.push(prefix); return { items: [], truncated: false }; });
  const simple = autocomplete.applyCompletion(['@fo'], 0, 3, { value: 'folder/', label: 'folder/' }, '@fo');
  assert.deepEqual(simple, { lines: ['@folder/'], cursorLine: 0, cursorCol: 8 });
  const quoted = autocomplete.applyCompletion(['@fo'], 0, 3, { value: 'folder with spaces/', label: 'folder with spaces/' }, '@fo');
  assert.equal(quoted.lines[0], '@"folder with spaces/"');
  assert.equal(quoted.cursorCol, quoted.lines[0].length - 1);
  assert.equal(quoted.lines[0][quoted.cursorCol - 1], '/');
  await autocomplete.getSuggestions(quoted.lines, quoted.cursorLine, quoted.cursorCol, { signal: signal() });
  assert.equal(prefixes.at(-1), 'folder with spaces/');
  const file = autocomplete.applyCompletion(quoted.lines, 0, quoted.cursorCol,
    { value: 'folder with spaces/child.txt', label: 'child.txt' }, quoted.lines[0].slice(0, quoted.cursorCol));
  assert.equal(file.lines[0], '@"folder with spaces/child.txt" ');
  assert.equal(tokenizeFileReferences(file.lines[0])[0].path, 'folder with spaces/child.txt');
});

test('completion replaces a token remainder and avoids duplicate quotes or whitespace', () => {
  const autocomplete = provider();
  const text = 'Read @"old filename.txt" next';
  const cursor = 'Read @"old fi'.length;
  const changed = autocomplete.applyCompletion([text], 0, cursor, { value: 'new file.txt', label: 'new' }, '@"old fi');
  assert.equal(changed.lines[0], 'Read @"new file.txt" next');
  const unquoted = autocomplete.applyCompletion(['@old.txt next'], 0, 3, { value: 'new.txt', label: 'new' }, '@ol');
  assert.equal(unquoted.lines[0], '@new.txt next');
  const slash = autocomplete.applyCompletion(['/hel argument'], 0, 3, { value: '/help', label: '/help' }, '/he');
  assert.equal(slash.lines[0], '/help argument');
});

test('prompt transformation reads only explicit references, deduplicates, and preserves prompt text', async () => {
  const calls: string[] = [];
  const text = 'Review ordinary.txt @one.txt @"folder/two file.txt" @one.txt and person@example.com `@code.txt`';
  const result = await transformPromptWithAttachments(text, async path => {
    calls.push(path); return { path: `/remote/${path}`, text: `contents ${path}` };
  });
  assert.deepEqual(calls, ['one.txt', 'folder/two file.txt']);
  assert(result.message.startsWith(text + '\n\n'));
  assert(result.message.includes('contents one.txt'));
  assert(result.message.includes('contents folder/two file.txt'));
  assert.deepEqual(result.images, []);
});

test('prompt transformation produces the RPC image shape, text, and empty-file attachments', async () => {
  const image = { type: 'image' as const, data: 'YWJj', mimeType: 'image/png' };
  const result = await transformPromptWithAttachments('/custom @image.png @empty.txt', async path =>
    path === 'image.png' ? { path: '/remote/image.png', image } : { path: '/remote/empty.txt', text: '' });
  assert(result.message.startsWith('/custom @image.png @empty.txt'));
  assert.deepEqual(result.images, [image]);
  assert.match(result.message, /Attached image.*image 1/);
  assert.match(result.message, /Attached file.*empty.txt/);
  const unchanged = await transformPromptWithAttachments('No attachment', async () => { assert.fail(); });
  assert.deepEqual(unchanged, { message: 'No attachment', images: [] });
});

test('unknown simple mentions stay literal but explicit missing paths fail with their path', async () => {
  const reader = async (): Promise<Attachment> => { throw missing(); };
  assert.deepEqual(await transformPromptWithAttachments('Ask @rowan and @teammate', reader), {
    message: 'Ask @rowan and @teammate', images: [],
  });
  for (const text of ['@missing.txt', '@folder/missing', '@"missing"', '@missing\\ file', '@~/missing']) {
    await assert.rejects(transformPromptWithAttachments(text, reader), /Could not attach @.*ENOENT/);
  }
  await assert.rejects(transformPromptWithAttachments('@README', async () => { throw new Error('Permission denied'); }), /README.*Permission denied/);
  await assert.rejects(transformPromptWithAttachments('@file.txt', async path => ({ path })), /neither text nor an image/);
});

test('file contents and shell-like path text are never re-tokenized or evaluated', async () => {
  const calls: string[] = [];
  const text = '@"$(touch not-executed); file.txt"';
  const result = await transformPromptWithAttachments(text, async path => {
    calls.push(path); return { path, text: '@another.txt `command` $(echo literal)' };
  });
  assert.deepEqual(calls, ['$(touch not-executed); file.txt']);
  assert(result.message.includes('@another.txt `command` $(echo literal)'));
});
