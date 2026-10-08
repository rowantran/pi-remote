import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { completeWords, completionContext, completionScript, formatCompletions, matchCommand, numberSlots, resolveCommand, selectHost, tokenizeCompletionLine, unquoteWord, type CompletionItem, type NumberedSlot } from '../src/completion.js';
import { main, parseOptions, pickSlot, resolveSlot, selectSlot, shouldReconnect } from '../src/cli.js';
import { shellQuote } from '../src/client.js';
import { PI_VERSION, PROTOCOL_VERSION } from '../src/protocol.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slot = (number: number | undefined, id: string, status: NumberedSlot['status'] = 'running'): NumberedSlot => ({ number, id, status, cwd: '/remote/project with spaces', sessionName: 'Fix quoted paths', clients: 0, createdAt: '2026-01-01' });
const slots = [slot(19, '1234abcd-a'), slot(3, 'abcdefff-b', 'starting'), slot(40, 'abcdefff-c', 'exited')];

async function temporaryDir(t: TestContext) {
  const dir = await mkdtemp('/tmp/pi-completion-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function fakeRemote(items: CompletionItem[] = []) {
  const calls: { method: string; params?: any }[] = [];
  const connections: any[] = [];
  let closed = 0;
  return {
    calls, connections, closed: () => closed,
    connect: async (options: any) => {
      connections.push(options);
      return { request: async <T>(method: string, params?: any): Promise<T> => {
        calls.push({ method, params });
        return (method === 'list' ? slots : { items, truncated: false }) as T;
      }, close: () => { closed++; } };
    },
  };
}

test('CLI parser accepts equals, repeated presentation adapters, and untouched remote Pi arguments', () => {
  const parsed = parseOptions(['1', '--cwd=/remote/two words', '--session', '~/a b.jsonl', '--ui-extension', './a.ts', '--ui-extension=./b.ts', '--ui-config', './ui.json', '--theme=light', '--no-reconnect', '--', '--model', 'provider/model']);
  assert.deepEqual(parsed.positionals, ['1']);
  assert.deepEqual(parsed.piArgs, ['--model', 'provider/model']);
  assert.equal(parsed.values.get('--cwd'), '/remote/two words');
  assert.equal(parsed.values.get('--session'), '~/a b.jsonl');
  assert.deepEqual(parsed.ui, { presentationPaths: ['./a.ts', './b.ts'], presentationConfig: './ui.json', theme: 'light' });
  assert.equal(parsed.flags.has('--no-reconnect'), true);
  for (const args of [['--cwd'], ['--cwd', '--json'], ['--host='], ['--unknown']]) assert.throws(() => parseOptions(args));
});

test('CLI parses and completes --no-bell as a local UI override', async () => {
  assert.equal(parseOptions([]).ui.bell, undefined);
  const parsed = parseOptions(['--no-bell']);
  assert.equal(parsed.ui.bell, false);
  assert.equal(parsed.flags.has('--no-bell'), true);
  const forwarded = parseOptions(['--', '--no-bell']);
  assert.deepEqual(forwarded.piArgs, ['--no-bell']);
  assert.equal(forwarded.ui.bell, undefined);
  for (const command of ['attach', 'new']) {
    const items = await completeWords([command, '--no-b']);
    assert.ok(items.some(item => item.value === '--no-bell'));
  }
});

test('CLI enables recovery only for attached terminal UIs, never headless commands', () => {
  for (const command of ['attach', 'new']) {
    assert.equal(shouldReconnect(command, new Set(), true, true), true);
    assert.equal(shouldReconnect(command, new Set(['--no-reconnect']), true, true), false);
    assert.equal(shouldReconnect(command, new Set(), false, true), false);
    assert.equal(shouldReconnect(command, new Set(), true, false), false);
    assert.equal(shouldReconnect(command, new Set(), false, false), false);
  }
  assert.equal(shouldReconnect('new', new Set(['--no-attach']), true, true), false);
  for (const command of ['ls', 'rpc', 'watch', 'kill', 'complete', 'completion', 'fs', 'daemon', 'bridge']) {
    assert.equal(shouldReconnect(command, new Set(), true, true), false, command);
  }
});

test('CLI version reports 0.2.0 without opening a connection', async t => {
  const output: string[] = [];
  t.mock.method(console, 'log', (value: string) => { output.push(value); });
  await main(['--version']);
  assert.deepEqual(output, [`pi-remote 0.2.0 (Pi ${PI_VERSION}, protocol ${PROTOCOL_VERSION})`]);
});

test('help separates power-user/debug commands from everyday use', async t => {
  const output: string[] = [];
  t.mock.method(console, 'log', (value: string) => { output.push(value); });
  await main(['--help']);
  const [everyday, advanced] = output.join('\n').split('Power-user / debugging commands:');
  assert.match(everyday, /Everyday commands:/);
  assert.match(everyday, /pi-remote attach \[--host HOST\] \[SLOT\]/);
  assert.doesNotMatch(everyday, /pi-remote (?:rpc|watch) /);
  assert.match(advanced, /pi-remote rpc \[--host HOST\] SLOT/);
  assert.match(advanced, /pi-remote watch \[--host HOST\] SLOT/);
  assert.match(advanced, /pi-remote\/config\.json/);
  assert.match(advanced, /Use attach for normal interactive work/);
  assert.match(advanced, /--no-bell/);
});

test('shell completion labels rpc and watch as power-user/debug commands', async () => {
  const items = await completeWords(['']);
  for (const command of ['rpc', 'watch']) assert.match(items.find(item => item.value === command)!.label, /^Power-user\/debug:/);
  assert.equal(items.find(item => item.value === 'attach')!.label, 'Command');
});

test('host comes only from --host, then the default; --local ignores both', () => {
  assert.equal(selectHost({ defaultHost: 'default' }), 'default');
  assert.equal(selectHost({ host: 'explicit', defaultHost: 'default' }), 'explicit');
  assert.equal(selectHost({ host: 'explicit', local: true, defaultHost: 'default' }), undefined);
  assert.equal(selectHost({ defaultHost: '' }), undefined);
  assert.equal(selectHost({}), undefined);
});

test('commands accept unambiguous prefixes; internal commands need exact names', () => {
  const cases: [string, string][] = [['n', 'new'], ['ne', 'new'], ['a', 'attach'], ['k', 'kill'], ['l', 'ls'], ['rp', 'rpc'], ['re', 'restart-daemon'], ['w', 'watch'], ['c', 'completion'], ['compl', 'completion'], ['h', 'help'], ['v', 'version'], ['complete', 'complete'], ['fs', 'fs'], ['daemon', 'daemon'], ['bridge', 'bridge']];
  for (const [input, command] of cases) assert.equal(resolveCommand(input), command, input);
  for (const input of ['d', 'b', 'f', 'x', 'newer', '']) assert.throws(() => resolveCommand(input), /Unknown command/, input);
  assert.throws(() => resolveCommand('r'), /Ambiguous command 'r': rpc, restart-daemon/);
  assert.deepEqual(matchCommand('zz').candidates, []);
});

test('numeric slots are stable metadata, never display indexes or numeric UUID prefixes', () => {
  assert.equal(selectSlot(slots, '3').id, 'abcdefff-b');
  assert.equal(selectSlot([...slots].reverse(), '19').id, '1234abcd-a');
  assert.throws(() => selectSlot(slots, '1'), /missing or ambiguous/);
  assert.throws(() => selectSlot(slots, '1234'), /missing or ambiguous/);
  assert.equal(selectSlot(slots, '1234abcd').id, '1234abcd-a');
  assert.equal(selectSlot(slots, 'abcdefff-b').number, 3);
  assert.throws(() => selectSlot(slots, 'abcdefff'), /ambiguous/);
  assert.throws(() => selectSlot([slots[0], { ...slots[1], number: 19 }], '19'), /ambiguous/);
  assert.throws(() => selectSlot(slots, ''), /missing or ambiguous/);
});

test('legacy slot numbers retain insertion order including stopped entries', () => {
  const legacy = slots.map(({ number: _number, ...value }) => value);
  assert.deepEqual(numberSlots(legacy).map(value => value.number), [1, 2, 3]);
  assert.equal(selectSlot(legacy, '3').status, 'exited');
  assert.deepEqual(numberSlots([...legacy, slot(undefined, 'new')]).map(value => value.number), [1, 2, 3, 4]);
  assert.deepEqual(numberSlots(slots).map(value => value.number), [19, 3, 40]);
});

test('slot resolver only lists and returns UUID; no picker or mutations for explicit selections', async () => {
  const calls: string[] = [];
  const connection = { request: async <T>(method: string) => { calls.push(method); return slots as T; } };
  assert.equal(await resolveSlot(connection, '19'), '1234abcd-a');
  await assert.rejects(resolveSlot(connection, undefined), /Specify a slot/);
  assert.deepEqual(calls, ['list', 'list']);
});

test('readline picker shows metadata and accepts a stable number without an RPC', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const selected = pickSlot(slots.slice(0, 2), { input, output });
  input.write('3\n');
  assert.equal(await selected, 'abcdefff-b');
  assert.match(text, /19  running · Fix quoted paths · \/remote\/project with spaces/);
  assert.match(text, /3  starting/);
  input.destroy(); output.destroy();
});

test('picker keeps non-TTY failures and cancels on empty input or EOF', async () => {
  await assert.rejects(pickSlot(slots, { input: new PassThrough(), output: new PassThrough() }), /local terminal/);
  for (const answer of ['\n', '\u0004', '\u0003']) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    output.resume();
    const selection = pickSlot(slots, { input, output });
    input.write(answer);
    await assert.rejects(selection, /cancelled/);
    input.destroy(); output.destroy();
  }
});

test('completion context preserves spaces, equals-form prefixes, and stops at remote Pi arguments', () => {
  const context = completionContext(['new', '--host', 'host', '--cwd=/remote/two words', '--session=~/a']);
  assert.equal(context.values.get('--cwd'), '/remote/two words');
  assert.equal(context.valueOption, '--session');
  assert.equal(context.prefix, '~/a');
  assert.equal(context.insertionPrefix, '--session=');
  assert.equal(completionContext(['new', '--host', 'host', '--cwd', '']).valueOption, '--cwd');
  assert.equal(completionContext(['new', '--host', 'host', '--', '--cwd', '']).forwarded, true);
});

test('internal completion accepts full shell word arrays as well as command arguments', async () => {
  assert.deepEqual((await completeWords(['pi-remote', 'att'])).map(item => item.value), ['attach']);
  const remote = fakeRemote();
  const result = await completeWords(['/some/bin/pi-remote', 'attach', '--host', 'host', '1'], { connect: remote.connect });
  assert.deepEqual(result.map(item => item.value), ['19']);
});

test('completion resolves command prefixes before completing arguments', async () => {
  const remote = fakeRemote([{ value: '/r/dir', label: 'dir', directory: true }]);
  assert.deepEqual((await completeWords(['a', '1'], { connect: remote.connect, defaultHost: 'default' })).map(item => item.value), ['19']);
  assert.deepEqual((await completeWords(['n', '--cwd', '/r/'], { connect: remote.connect, defaultHost: 'default' })).map(item => item.value), ['/r/dir/']);
  assert.deepEqual((await completeWords(['k', ''], { connect: remote.connect, defaultHost: 'default' })).map(item => item.value), ['19', '3']);
});

test('remote directory completion sends only complete_path with the exact prefix', async () => {
  const remote = fakeRemote([{ value: '~/two words', label: 'two words', directory: true }, { value: '~/session.jsonl', label: 'file', directory: false }]);
  const result = await completeWords(['new', '--host', 'alias', '--cwd', '~/tw'], { connect: remote.connect, defaultHost: 'ignored' });
  assert.deepEqual(result, [{ value: '~/two words/', label: 'two words', directory: true }]);
  assert.deepEqual(remote.calls, [{ method: 'complete_path', params: { prefix: '~/tw', directoriesOnly: true } }]);
  assert.equal(remote.connections[0].host, 'alias');
  assert.equal(remote.closed(), 1);
});

test('session completion resolves relative files under --cwd and preserves shell metacharacters', async () => {
  const dangerous = "sessions/it's $(touch NEVER); [draft].jsonl";
  const remote = fakeRemote([{ value: dangerous, label: dangerous, directory: false }]);
  const result = await completeWords(['new', '--host=explicit', '--cwd', '/remote/two words', '--session=sess'], { connect: remote.connect, defaultHost: 'ignored' });
  assert.equal(result[0].value, `--session=${dangerous}`);
  assert.deepEqual(remote.calls[0], { method: 'complete_path', params: { prefix: 'sess', cwd: '/remote/two words', directoriesOnly: false } });
  assert.equal(remote.connections[0].host, 'explicit');
});

test('session completion falls back to the default cwd, which --cwd and --local override', async () => {
  const remote = fakeRemote([{ value: 'a.jsonl', label: 'a.jsonl', directory: false }]);
  const deps = { connect: remote.connect, defaultHost: 'default', defaultCwd: '/default/dir' };
  await completeWords(['new', '--session', 's'], deps);
  await completeWords(['new', '--cwd', '/explicit', '--session', 's'], deps);
  await completeWords(['new', '--local', '--session', 's'], deps);
  await completeWords(['new', '--cwd', ''], deps);
  assert.deepEqual(remote.calls.map(call => call.params), [
    { prefix: 's', cwd: '/default/dir', directoriesOnly: false },
    { prefix: 's', cwd: '/explicit', directoriesOnly: false },
    { prefix: 's', directoriesOnly: false },
    { prefix: '', directoriesOnly: true },
  ]);
});

test('completion reads host defaults and connection flags without confusing option values for hosts', async () => {
  const cases = [
    { words: ['new', '--remote-bin', '/a b/pi-remote', '--state-dir=~/state', '--cwd', ''], host: 'default' },
    { words: ['new', '--host', 'explicit', '--cwd', ''], host: 'explicit' },
    { words: ['new', '--host=equals', '--cwd=',], host: 'equals' },
    { words: ['new', '--local', '--cwd', ''], host: undefined },
  ];
  for (const { words, host } of cases) {
    const remote = fakeRemote();
    await completeWords(words, { connect: remote.connect, defaultHost: 'default' });
    assert.equal(remote.connections[0].host, host);
    if (words.includes('--remote-bin')) {
      assert.equal(remote.connections[0].remoteBin, '/a b/pi-remote');
      assert.equal(remote.connections[0].stateDir, '~/state');
    }
  }
});

test('attach, kill, watch, and rpc offer running slots with cwd/name/state labels', async () => {
  for (const command of ['attach', 'kill', 'watch', 'rpc']) {
    const remote = fakeRemote();
    const result = await completeWords([command, '--host', 'alias', ''], { connect: remote.connect });
    assert.deepEqual(result.map(item => item.value), ['19', '3']);
    assert.equal(result[0].label, 'running · Fix quoted paths · /remote/project with spaces');
    assert.deepEqual(remote.calls, [{ method: 'list', params: undefined }]);
    assert.equal(remote.closed(), 1);
  }
});

test('slot completion respects default/explicit hosts and numeric versus UUID prefixes', async () => {
  for (const words of [['attach', '1'], ['attach', '--host', 'default', '1']]) {
    const remote = fakeRemote();
    assert.deepEqual((await completeWords(words, { connect: remote.connect, defaultHost: 'default' })).map(item => item.value), ['19']);
    assert.equal(remote.connections[0].host, 'default');
  }
  const remote = fakeRemote();
  assert.deepEqual((await completeWords(['attach', '--host', 'host', 'abc'], { connect: remote.connect })).map(item => item.value), ['abcdefff-b']);
});

test('completion does not contact remote hosts for unrelated tokens, missing hosts, or forwarded Pi flags', async () => {
  for (const words of [['new', '--cwd', ''], ['attach', ''], ['new', '--host', 'host', '--', '--cwd', ''], ['attach', '--host', ''], ['new', '--host', 'host', '--ui-config', ''], ['rpc', '--host', 'host', '19', ''], ['new', '--host', 'host', ''], ['unknown', '--host', 'host', '']]) {
    const remote = fakeRemote();
    assert.deepEqual(await completeWords(words, { connect: remote.connect, defaultHost: '' }), []);
    assert.deepEqual(remote.connections, []);
  }
});

test('a completed slot does not complete rpc JSON as another slot', async () => {
  const remote = fakeRemote();
  assert.deepEqual(await completeWords(['rpc', '19', ''], { connect: remote.connect, defaultHost: 'default' }), []);
  assert.deepEqual(remote.connections, []);
});

test('completion catches connection and RPC errors without retrying', async () => {
  let attempts = 0, closes = 0;
  assert.deepEqual(await completeWords(['attach', '--host', 'host', ''], { connect: async () => { attempts++; throw new Error('offline'); } }), []);
  assert.equal(attempts, 1);
  assert.deepEqual(await completeWords(['attach', '--host', 'host', ''], { connect: async () => ({ request: async () => { attempts++; throw new Error('old daemon'); }, close: () => { closes++; } }) }), []);
  assert.equal(attempts, 2);
  assert.equal(closes, 1);
});

test('shell formatting keeps spaces/metacharacters literal and rejects control-character candidates', () => {
  const items = [
    { value: "/remote/it's $(touch NEVER); [a]\\b/", label: 'name\nstate\tpath\u001b', directory: true },
    { value: '/remote/bad\nname', label: 'bad', directory: true },
    { value: '/remote/bad\tname', label: 'bad', directory: true },
  ];
  assert.equal(formatCompletions(items, 'fish'), "/remote/it's $(touch NEVER); [a]\\b/\tname state path ");
  assert.equal(formatCompletions(items, 'bash'), items[0].value);
});

test('safe unquoting handles unfinished quotes and leaves remote ~ and substitutions as data', () => {
  assert.equal(unquoteWord('~/two\\ words', 'fish'), '~/two words');
  assert.equal(unquoteWord("'~/two words", 'fish'), '~/two words');
  assert.equal(unquoteWord('--cwd="~/two words', 'fish'), '--cwd=~/two words');
  assert.equal(unquoteWord("'it\\'s'", 'fish'), "it's");
  assert.equal(unquoteWord("'it'\\''s'", 'bash'), "it's");
  assert.equal(unquoteWord('$(touch NEVER)', 'fish'), '$(touch NEVER)');
  assert.deepEqual(tokenizeCompletionLine('pi-remote new host --cwd="~/two words'), ['pi-remote', 'new', 'host', '--cwd=~/two words']);
  assert.deepEqual(tokenizeCompletionLine('pi-remote new host --cwd /a\\ b/ '), ['pi-remote', 'new', 'host', '--cwd', '/a b/', '']);
  assert.deepEqual(tokenizeCompletionLine('pi-remote new host --cwd $(touch NEVER)'), []);
  assert.deepEqual(tokenizeCompletionLine('echo hi; pi-remote attach host '), []);
});

test('completion installation returns scripts without changing configuration', async () => {
  for (const shell of ['fish', 'zsh', 'bash']) assert.match(await completionScript(shell), /pi-remote/);
  await assert.rejects(completionScript('../../etc/passwd'), /Usage/);
  await assert.rejects(completionScript('constructor'), /Usage/);
});

/** The executable is intentionally stubbed, but uses the actual completion
 * parser/formatter and real filesystem entries. This checks fish's word array,
 * quoting, equals handling, and menus without any network or running daemon. */
async function shellFixture(t: TestContext) {
  const dir = await temporaryDir(t);
  const remote = join(dir, 'remote');
  await mkdir(remote);
  const names = ['two words', "it's quoted", 'brackets [x]', 'dollar $HOME', 'semicolon; literal', 'substitution $(touch NEVER)'];
  for (const name of names) await mkdir(join(remote, name));
  await writeFile(join(remote, 'session with spaces.jsonl'), '{}');
  const stub = join(dir, 'stub.mjs');
  await writeFile(stub, `
import { appendFile, readdir } from 'node:fs/promises';
import { completeWords, formatCompletions, unquoteWord, tokenizeCompletionLine } from ${JSON.stringify(new URL('../src/completion.ts', import.meta.url).href)};
const args = process.argv.slice(2);
if (args[0] === 'completion') {
  const { main } = await import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)});
  await main(args);
  process.exit(0);
}
await appendFile(process.env.PI_REMOTE_TEST_LOG, JSON.stringify(args) + '\\n');
const shell = args[args.indexOf('--shell') + 1];
let words = args.includes('--line') ? tokenizeCompletionLine(args[args.indexOf('--line')+1]).slice(1) : args.slice(args.indexOf('--') + 1);
if (args.includes('--raw-current') && words.length) words[words.length-1] = unquoteWord(words.at(-1), shell);
let items = await completeWords(words, { defaultHost: process.env.PI_REMOTE_HOST ?? '', defaultCwd: process.env.PI_REMOTE_CWD ?? '', connect: async options => ({
  close() {},
  request: async (method, params) => {
    await appendFile(process.env.PI_REMOTE_TEST_RPC_LOG, JSON.stringify({method, params, options})+'\\n');
    if (method === 'list') return ${JSON.stringify(slots)};
    const entries = await readdir(process.env.PI_REMOTE_TEST_DIRECTORY, {withFileTypes:true});
    const slash = params.prefix.lastIndexOf('/');
    const base = slash < 0 ? '' : params.prefix.slice(0,slash+1);
    const prefix = params.prefix.slice(slash+1);
    return {items: entries.filter(entry => entry.name.startsWith(prefix) && (!params.directoriesOnly || entry.isDirectory())).map(entry => ({value: base+entry.name, label: entry.name, directory:entry.isDirectory()})), truncated:false};
  }
}) });
if (shell === 'bash' && args.includes('--current-word')) {
 const full = words.at(-1) ?? '', current = unquoteWord(args[args.indexOf('--current-word')+1], 'bash');
 const offset = current === '=' && full.endsWith('=') ? full.length : full.endsWith(current) ? full.length-current.length : 0;
 items = items.map(item => ({...item,value:item.value.slice(offset)}));
}
const output = formatCompletions(items, shell);
if (output) process.stdout.write(output+'\\n');
`);
  const executable = join(dir, 'pi-remote');
  await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import tsx ${shellQuote(stub)} "$@"\n`);
  await chmod(executable, 0o700);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PI_REMOTE_HOST: '', PI_REMOTE_CWD: '', PI_REMOTE_TEST_LOG: join(dir, 'args.jsonl'), PI_REMOTE_TEST_RPC_LOG: join(dir, 'rpc.jsonl'), PI_REMOTE_TEST_DIRECTORY: remote };
  return { dir, remote, names, env };
}
const fishPath = process.platform === 'darwin' ? '/opt/homebrew/bin/fish' : '/usr/bin/fish';
async function hasExecutable(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

test('fish config can pipe completion output into source repeatedly without files or duplicate requests', { timeout: 15000 }, async t => {
  if (!await hasExecutable(fishPath)) { t.skip('fish is not installed'); return; }
  const fixture = await shellFixture(t);
  const config = join(fixture.dir, 'fish-config');
  const script = `set -g fish_complete_path
complete -c pi-remote -a user-kept
pi-remote completion fish | source
pi-remote completion fish | source
# Emitting and sourcing scripts must not ask for remote candidates.
test ! -e "$PI_REMOTE_TEST_LOG"; or exit 91
complete -c pi-remote | string match --quiet '*user-kept*'; or exit 92
complete -c pi-remote | count
complete -C 'pi-remote new --host alias --cwd /remote/'`;
  const { stdout, stderr } = await exec(fishPath, ['--no-config', '-c', script], {
    env: { ...fixture.env, XDG_CONFIG_HOME: config }, cwd: root,
  });
  assert.equal(stderr, '');
  const [rules, ...candidates] = stdout.trim().split('\n');
  assert.equal(rules, '2', 'one project rule plus the preserved user rule');
  assert.deepEqual(candidates.map(line => line.split('\t')[0]).sort(), fixture.names.map(name => `/remote/${name}/`).sort());
  const requests = (await readFile(fixture.env.PI_REMOTE_TEST_RPC_LOG, 'utf8')).trim().split('\n');
  assert.equal(requests.length, 1, 're-sourcing must not duplicate a remote lookup');
  await assert.rejects(access(join(config, 'fish/completions/pi-remote.fish')), { code: 'ENOENT' });
});

test('fish complete -C: remote directory names with spaces, quotes, and syntax remain one candidate each', { timeout: 15000 }, async t => {
  if (!await hasExecutable(fishPath)) { t.skip('fish is not installed'); return; }
  const fixture = await shellFixture(t);
  const { stdout, stderr } = await exec(fishPath, ['--no-config', '-c', `source ${shellQuote(join(root, 'completions/pi-remote.fish'))}; complete -C 'pi-remote new --host alias --cwd /remote/'`], { env: fixture.env, cwd: root });
  assert.equal(stderr, '');
  assert.deepEqual(stdout.trim().split('\n').map(line => line.split('\t')[0]).sort(), fixture.names.map(name => `/remote/${name}/`).sort());
  await assert.rejects(access(join(root, 'NEVER')));
  const request = JSON.parse((await readFile(fixture.env.PI_REMOTE_TEST_RPC_LOG, 'utf8')).trim());
  assert.deepEqual(request.params, { prefix: '/remote/', directoriesOnly: true });
  assert.equal(request.options.host, 'alias');
});

test('fish complete -C handles --cwd=, unfinished quotes, escaped spaces, remote ~, host defaults, and session files', { timeout: 20000 }, async t => {
  if (!await hasExecutable(fishPath)) { t.skip('fish is not installed'); return; }
  const fixture = await shellFixture(t);
  const cases = [
    { line: 'pi-remote new --host alias --cwd=~/tw', value: '--cwd=~/two words/', host: 'alias', prefix: '~/tw' },
    { line: 'pi-remote new --host explicit --cwd "~/two w', value: '~/two words/', host: 'explicit', prefix: '~/two w' },
    { line: 'pi-remote new --cwd ~/two\\ w', value: '~/two words/', host: 'default', prefix: '~/two w' },
    { line: 'pi-remote new --host alias --cwd "/remote/two words" --session sess', value: 'session with spaces.jsonl', host: 'alias', prefix: 'sess', cwd: '/remote/two words' },
    { line: 'pi-remote new --host alias --cwd=/remote/two\\ words --session=sess', value: '--session=session with spaces.jsonl', host: 'alias', prefix: 'sess', cwd: '/remote/two words' },
  ];
  for (const entry of cases) {
    await writeFile(fixture.env.PI_REMOTE_TEST_RPC_LOG, '');
    const { stdout, stderr } = await exec(fishPath, ['--no-config', '-c', `source ${shellQuote(join(root, 'completions/pi-remote.fish'))}; complete -C "$PI_REMOTE_LINE"`], { env: { ...fixture.env, PI_REMOTE_HOST: 'default', PI_REMOTE_LINE: entry.line }, cwd: root });
    assert.equal(stderr, '');
    assert.equal(stdout.trim().split('\t')[0], entry.value, entry.line);
    const request = JSON.parse((await readFile(fixture.env.PI_REMOTE_TEST_RPC_LOG, 'utf8')).trim());
    assert.equal(request.options.host, entry.host);
    assert.equal(request.params.prefix, entry.prefix);
    assert.equal(request.params.cwd, entry.cwd);
  }
});

test('fish complete -C: attach/kill/watch/rpc list running slots by stable short number with descriptive labels', { timeout: 20000 }, async t => {
  if (!await hasExecutable(fishPath)) { t.skip('fish is not installed'); return; }
  const fixture = await shellFixture(t);
  for (const command of ['attach', 'kill', 'watch', 'rpc']) {
    const { stdout } = await exec(fishPath, ['--no-config', '-c', `source ${shellQuote(join(root, 'completions/pi-remote.fish'))}; complete -C "$PI_REMOTE_LINE"`], { env: { ...fixture.env, PI_REMOTE_LINE: `pi-remote ${command} --host alias ` }, cwd: root });
    assert.deepEqual(stdout.trim().split('\n').map(line => line.split('\t')[0]).sort(), ['19', '3']);
    assert.match(stdout, /19\trunning · Fix quoted paths · \/remote\/project with spaces/);
  }
});

test('bash completion preserves candidates as array elements and reconstructs --cwd= word breaks', { timeout: 10000 }, async t => {
  if (!await hasExecutable('/bin/bash')) { t.skip('bash is not installed'); return; }
  const fixture = await shellFixture(t);
  const script = `source ${shellQuote(join(root, 'completions/pi-remote.bash'))}
COMP_WORDS=(pi-remote new --host alias --cwd = /remote/tw)
COMP_CWORD=6
COMP_LINE='pi-remote new --host alias --cwd=/remote/tw'
COMP_POINT=\${#COMP_LINE}
_pi_remote_complete
printf '%s\\n' "\${COMPREPLY[@]}"`;
  const { stdout, stderr } = await exec('/bin/bash', ['--noprofile', '--norc', '-c', script], { env: fixture.env, cwd: root });
  assert.equal(stderr, '');
  assert.equal(stdout, '/remote/two words/\n');
});

test('zsh completion passes quoted words as data and leaves quoting enabled in compadd', { timeout: 10000 }, async t => {
  if (!await hasExecutable('/bin/zsh')) { t.skip('zsh is not installed'); return; }
  const fixture = await shellFixture(t);
  const script = `words=(pi-remote new --host alias --cwd '"/remote/two w')
CURRENT=6
PREFIX='"/remote/two w'
compadd() { print -rl -- "\${directories[@]}"; }
source ${shellQuote(join(root, 'completions/_pi-remote'))}`;
  const { stdout, stderr } = await exec('/bin/zsh', ['-f', '-c', script], { env: fixture.env, cwd: root });
  assert.equal(stderr, '');
  assert.equal(stdout, '/remote/two words/\n');
});

async function fakeSsh(t: TestContext, silent = false) {
  const dir = await temporaryDir(t);
  const script = join(dir, 'ssh.mjs');
  const log = join(dir, 'requests.jsonl');
  await writeFile(script, `import { createInterface } from 'node:readline'; import { appendFileSync } from 'node:fs';
console.error('SSH diagnostic that completion must suppress');
appendFileSync(${JSON.stringify(join(dir, 'argv.jsonl'))}, JSON.stringify(process.argv.slice(2))+'\\n');
createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); appendFileSync(${JSON.stringify(log)}, line+'\\n');
${silent ? 'return;' : `const data=request.method==='hello'?${JSON.stringify({ protocol: PROTOCOL_VERSION, piVersion: PI_VERSION })}:request.method==='list'?${JSON.stringify(slots)}:{items:[{value:'~/two words/',label:'two words',directory:true}],truncated:false}; process.stdout.write(JSON.stringify({type:'result',id:request.id,success:true,data})+'\\n');`}
});`);
  const executable = join(dir, 'ssh');
  await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  await chmod(executable, 0o700);
  return { dir, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PI_REMOTE_HOST: '', PI_REMOTE_CWD: '', XDG_CONFIG_HOME: join(dir, 'config') } };
}

test('internal complete command uses the standard SSH hello and read-only RPC, with quiet stderr', { timeout: 10000 }, async t => {
  const fixture = await fakeSsh(t);
  const args = ['--import', 'tsx', join(root, 'src/cli.ts'), 'complete', '--shell', 'fish', '--words', JSON.stringify(['new', '--host', 'alias', '--cwd', '~/tw'])];
  const { stdout, stderr } = await exec(process.execPath, args, { env: fixture.env, cwd: root });
  assert.equal(stderr, '');
  assert.equal(stdout, '~/two words/\ttwo words\n');
  const requests = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.map(request => request.method), ['hello', 'complete_path']);
  assert.deepEqual(requests[0].params, { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
});

test('CLI ls displays short numbers and resolves numeric rpc slots to UUIDs before attach', { timeout: 10000 }, async t => {
  const fixture = await fakeSsh(t);
  const cli = ['--import', 'tsx', join(root, 'src/cli.ts')];
  const listing = await exec(process.execPath, [...cli, 'l', '--host', 'alias'], { env: fixture.env, cwd: root });
  assert.match(listing.stdout, /^\s*19  1234abcd-a  running/);
  const json = await exec(process.execPath, [...cli, 'ls', '--host', 'alias', '--json'], { env: fixture.env, cwd: root });
  assert.equal(JSON.parse(json.stdout)[0].number, 19);
  await writeFile(fixture.log, '');
  await exec(process.execPath, [...cli, 'rpc', '--host', 'alias', '19', '{"type":"get_state"}'], { env: fixture.env, cwd: root });
  const requests = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.map(request => request.method), ['hello', 'list', 'attach', 'rpc']);
  assert.equal(requests[2].params.slotId, '1234abcd-a');
  assert.equal(requests[3].params.slotId, '1234abcd-a');
});

test('CLI takes the default host from the XDG config file, with PI_REMOTE_HOST and --host taking precedence', { timeout: 15000 }, async t => {
  const fixture = await fakeSsh(t);
  const cli = ['--import', 'tsx', join(root, 'src/cli.ts')];
  const argv = join(fixture.dir, 'argv.jsonl');
  const hosts = async () => (await readFile(argv, 'utf8')).trim().split('\n').map(line => JSON.parse(line)[9]);
  await assert.rejects(exec(process.execPath, [...cli, 'ls'], { env: fixture.env, cwd: root }), /No host\. Use --host HOST.*pi-remote\/config\.json/s);
  await mkdir(join(fixture.env.XDG_CONFIG_HOME, 'pi-remote'), { recursive: true });
  await writeFile(join(fixture.env.XDG_CONFIG_HOME, 'pi-remote/config.json'), JSON.stringify({ host: 'from-config' }));
  await exec(process.execPath, [...cli, 'ls'], { env: fixture.env, cwd: root });
  await exec(process.execPath, [...cli, 'ls'], { env: { ...fixture.env, PI_REMOTE_HOST: 'from-env' }, cwd: root });
  await exec(process.execPath, [...cli, 'ls', '--host', 'from-flag'], { env: { ...fixture.env, PI_REMOTE_HOST: 'from-env' }, cwd: root });
  assert.deepEqual(await hosts(), ['from-config', 'from-env', 'from-flag']);
  await assert.rejects(exec(process.execPath, [...cli, 'ls', 'positional-host'], { env: fixture.env, cwd: root }), /Too many arguments/);
  await assert.rejects(exec(process.execPath, [...cli, 'x'], { env: fixture.env, cwd: root }), /Unknown command 'x'/);
});

test('CLI new takes the default cwd from the XDG config file, with PI_REMOTE_CWD and --cwd taking precedence', { timeout: 15000 }, async t => {
  const fixture = await fakeSsh(t);
  const cli = ['--import', 'tsx', join(root, 'src/cli.ts')];
  const creates = async () => (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(request => request.method === 'create').map(request => request.params.cwd);
  await assert.rejects(exec(process.execPath, [...cli, 'new', '--host', 'alias', '--no-attach'], { env: fixture.env, cwd: root }), /new requires a remote directory\. Use --cwd DIRECTORY.*pi-remote\/config\.json/s);
  await mkdir(join(fixture.env.XDG_CONFIG_HOME, 'pi-remote'), { recursive: true });
  await writeFile(join(fixture.env.XDG_CONFIG_HOME, 'pi-remote/config.json'), JSON.stringify({ host: 'alias', cwd: '~/from-config' }));
  await exec(process.execPath, [...cli, 'new', '--no-attach'], { env: fixture.env, cwd: root });
  await exec(process.execPath, [...cli, 'new', '--no-attach'], { env: { ...fixture.env, PI_REMOTE_CWD: '/from-env' }, cwd: root });
  await exec(process.execPath, [...cli, 'new', '--no-attach', '--cwd', '/from-flag'], { env: { ...fixture.env, PI_REMOTE_CWD: '/from-env' }, cwd: root });
  assert.deepEqual(await creates(), ['~/from-config', '/from-env', '/from-flag']);
  await assert.rejects(exec(process.execPath, [...cli, 'new', '--local', '--no-attach'], { env: fixture.env, cwd: root }), /new --local requires --cwd/);
});

test('internal complete command accepts JSON stdin and rejects malformed inputs quietly', { timeout: 10000 }, async t => {
  const fixture = await fakeSsh(t);
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'complete', '--shell', 'bash'], { env: fixture.env, cwd: root });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(['attach', '--host', 'alias', '1']));
  await new Promise<void>((resolveResult, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolveResult() : reject(new Error(`exit ${code}`))); });
  assert.equal(stdout, '19\n'); assert.equal(stderr, '');
  const invalid = await exec(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'complete', '--words', '{bad}'], { env: fixture.env, cwd: root });
  assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr, '');
});

test('standalone fs command reads JSON without connecting to SSH or requiring Pi', { timeout: 6000 }, async t => {
  const fixture = await fakeSsh(t);
  await mkdir(join(fixture.dir, 'directory with spaces'));
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'fs', 'complete_path'], { cwd: root, env: { ...fixture.env, PI_REMOTE_PI_BIN: '/does/not/exist' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ prefix: `${fixture.dir}/directory`, directoriesOnly: true }));
  await new Promise<void>((resolveResult, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolveResult() : reject(new Error(`exit ${code}: ${stderr}`))); });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).items[0].value, `${fixture.dir}/directory with spaces/`);
  await assert.rejects(access(fixture.log));
});

test('completion also bounds an unfinished JSON stdin stream', { timeout: 6000 }, async t => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'complete'], { cwd: root });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.write('[');
  const started = Date.now();
  await new Promise<void>((resolveResult, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolveResult() : reject(new Error(`exit ${code}`))); });
  assert.equal(output, '');
  assert.ok(Date.now() - started < 4000);
});

test('a silent SSH handshake is bounded and completion prints no diagnostics', { timeout: 10000 }, async t => {
  const fixture = await fakeSsh(t, true);
  const started = Date.now();
  const result = await exec(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'complete', '--', 'attach', '--host', 'alias', ''], { env: fixture.env, cwd: root, timeout: 5000 });
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.ok(Date.now() - started < 4000, 'completion must not wait for the transport handshake deadline');
  assert.equal((await readFile(fixture.log, 'utf8')).trim().split('\n').length, 1, 'no retries');
});
