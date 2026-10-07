import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { PiProcess } from '../src/pi-process.js';
import type { RecordValue } from '../src/protocol.js';

const fixture = fileURLToPath(new URL('./fixture-pi.mjs', import.meta.url));
async function start(t: TestContext, onEvent: (event: RecordValue) => void) {
  const cwd = await realpath(await mkdtemp('/tmp/pi-process-test-'));
  const exits: Error[] = [];
  const pi = new PiProcess({ executable: process.execPath, prefixArgs: [fixture], cwd, args: [], env: { PI_OFFLINE: '1' } },
    onEvent, error => exits.push(error));
  t.after(async () => { await pi.stop(); await rm(cwd, { recursive: true, force: true }); });
  await pi.command({ type: 'get_state' }, 2000);
  return { pi, exits };
}
function assertAlive(pi: PiProcess, exits: Error[]) {
  assert.equal(pi.child.exitCode, null);
  assert.equal(pi.child.signalCode, null);
  assert.equal(pi.child.killed, false);
  assert.deepEqual(exits, []);
  assert.doesNotThrow(() => process.kill(pi.child.pid!, 0));
}

/** Real stock Pi, no extensions, credentials, network, or model calls. */
test('stock RPC tree rows fork before the selected user and preserve the original session', { timeout: 30_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-remote-fork-rpc-'));
  const agent = join(cwd, 'agent'); await mkdir(agent);
  const source = join(cwd, 'source.jsonl');
  const timestamp = new Date().toISOString();
  const user = (content: string) => ({ role: 'user', content, timestamp: Date.now() });
  const assistant = {
    role: 'assistant', content: [{ type: 'text', text: 'First assistant context' }],
    api: 'openai-completions', provider: 'openai', model: 'gpt-4o', timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const entries = [
    { type: 'session', version: 3, id: randomUUID(), timestamp, cwd },
    { type: 'message', id: '11111111', parentId: null, timestamp, message: user('First user prompt') },
    { type: 'message', id: '22222222', parentId: '11111111', timestamp, message: assistant },
    { type: 'message', id: '33333333', parentId: '22222222', timestamp, message: user('Second user\nprompt') },
    { type: 'message', id: '44444444', parentId: '33333333', timestamp, message: { ...assistant, content: [{ type: 'text', text: 'Second assistant context' }] } },
  ];
  await writeFile(source, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
  const pi = new PiProcess({ executable: process.execPath, prefixArgs: [cli], cwd,
    args: ['--offline', '--session', source, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'],
    env: { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  }, () => {}, () => {});
  t.after(async () => { await pi.stop(); await rm(cwd, { recursive: true, force: true }); });
  const tree = await pi.command({ type: 'get_tree' }, 15_000);
  const rows: RecordValue[] = [];
  const pending = [...tree.tree];
  while (pending.length) { const node = pending.pop(); rows.push(node.entry); pending.push(...node.children); }
  assert.deepEqual(rows.filter(entry => entry.type === 'message').map(entry => entry.message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(rows.some(entry => entry.id === '44444444')); // Startup may append model/thinking metadata after it.
  const before = await pi.command({ type: 'get_state' }, 5000);
  const sourceBeforeFork = await readFile(source, 'utf8');
  const result = await pi.command({ type: 'fork', entryId: '33333333' }, 10_000);
  assert.deepEqual(result, { text: 'Second user\nprompt', cancelled: false });
  const after = await pi.command({ type: 'get_state' }, 5000);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.notEqual(after.sessionFile, source);
  const fork = await pi.command({ type: 'get_entries' }, 5000);
  assert.deepEqual(fork.entries.filter((entry: RecordValue) => entry.type === 'message').map((entry: RecordValue) => entry.id), ['11111111', '22222222']);
  assert.deepEqual(fork.entries.filter((entry: RecordValue) => entry.type === 'message').map((entry: RecordValue) => entry.message.role), ['user', 'assistant']);
  assert.equal(await readFile(source, 'utf8'), sourceBeforeFork);
});

test('a consumer throwing on a valid event does not kill Pi or reject its accepted command', { timeout: 5000 }, async t => {
  const records: RecordValue[] = [];
  let threw = false;
  const { pi, exits } = await start(t, event => {
    records.push(event);
    if (event.type === 'queue_update' && !threw) { threw = true; throw new Error('Fixture consumer failure'); }
  });
  assert.deepEqual(await pi.command({ type: 'prompt', message: '/consumer-event' }, 2000), { disposition: 'handled' });
  assert.equal(threw, true);
  assert.ok(records.some(record => record.type === 'remote_warning' && record.error.includes('Fixture consumer failure')));
  assert.equal((await pi.command({ type: 'get_state' }, 2000)).isStreaming, false);
  assertAlive(pi, exits);
});

test('malformed stdout rejects local waiters without cancelling Pi and recovers on subsequent valid records', { timeout: 5000 }, async t => {
  const events = new EventEmitter();
  const records: RecordValue[] = [];
  const { pi, exits } = await start(t, event => { records.push(event); events.emit(event.type, event); });
  const recoveredEvent = once(events, 'queue_update');
  const unrelated = pi.command({ type: 'bash', command: 'still running' }, 2000);
  const malformed = pi.command({ type: 'prompt', message: '/malformed-output' }, 2000);
  const outcomes = await Promise.allSettled([unrelated, malformed]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.match(outcome.reason.message, /Remote work was not cancelled.*outcomes may be unknown/s);
  }
  assertAlive(pi, exits);
  await recoveredEvent;
  assert.ok(records.some(record => record.type === 'remote_warning'));
  assert.equal((await pi.command({ type: 'get_state' }, 2000)).isStreaming, false);
  assertAlive(pi, exits);
});
