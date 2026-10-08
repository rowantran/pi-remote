import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, handshake } from '../src/client.js';
import { Supervisor, socketPath } from '../src/daemon.js';
import type { RecordValue, SlotInfo, Snapshot } from '../src/protocol.js';

// Real pinned Pi, isolated configuration, no model calls, credentials, SSH or network.
// Run: node --import tsx test/reload-smoke.ts
const root = await realpath(await mkdtemp('/tmp/pi-reload-smoke-'));
const stateDir = join(root, 'daemon');
const agentDir = join(root, 'agent');
const sessionFile = join(root, 'session.jsonl');
const extensionFile = join(root, 'extension.ts');
const lifecycleLog = join(root, 'lifecycle.log');
const piCli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const supervisor = new Supervisor({ stateDir, executable: process.execPath, prefixArgs: [piCli],
  env: { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir } });
const clients: Connection[] = [];
async function connect() {
  const socket = createConnection(socketPath(stateDir));
  await once(socket, 'connect');
  const client = new Connection(socket, socket, () => socket.destroy());
  clients.push(client); await handshake(client);
  return client;
}
async function extension(version: string) {
  await writeFile(extensionFile, `import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', (_event, ctx) => {
    appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`start-${version}\n`)});
    ctx.ui.setStatus(${JSON.stringify(version)}, ${JSON.stringify(version)});
    ctx.ui.setWidget(${JSON.stringify(version)}, [${JSON.stringify(version)}]);
  });
  pi.on('session_shutdown', () => appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`stop-${version}\n`)}));
  pi.registerCommand(${JSON.stringify(`smoke-${version}`)}, {
    handler: async (_args, ctx) => ctx.ui.notify(${JSON.stringify(`command-${version}`)})
  });
}
`);
}
async function ready(client: Connection, slotId: string): Promise<Snapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await client.request<Snapshot>('snapshot', { slotId });
    if (snapshot.slot.status === 'running') return snapshot;
    assert.notEqual(snapshot.slot.status, 'exited', snapshot.slot.error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Pi startup did not finish');
}
try {
  await mkdir(agentDir);
  const header = { type: 'session', version: 3, id: 'reload-smoke', cwd: root, timestamp: new Date().toISOString() };
  const entry = { type: 'message', id: 'saved', parentId: null, timestamp: header.timestamp,
    message: { role: 'user', timestamp: Date.now(), content: 'Persisted history; do not send to a model.' } };
  await writeFile(sessionFile, [header, entry].map(record => JSON.stringify(record)).join('\n') + '\n');
  await extension('old');
  await supervisor.start();
  let client = await connect();
  const slot = await client.request<SlotInfo>('create', { cwd: root, sessionPath: sessionFile,
    args: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-e', extensionFile] });
  await client.request('attach', { slotId: slot.id });
  const before = await ready(client, slot.id);
  assert.ok(before.ui.some(record => record.statusKey === 'old'));
  await extension('new');
  const reloaded = await client.request<SlotInfo>('restart', { slotId: slot.id });
  assert.notEqual(reloaded.pid, slot.pid);
  const after = await ready(client, slot.id);
  assert.equal(after.slot.id, slot.id); assert.equal(after.slot.number, slot.number);
  assert.equal(after.state.sessionFile, sessionFile); assert.equal(after.state.sessionId, 'reload-smoke');
  assert.deepEqual(after.entries, before.entries);
  assert.ok(after.ui.some(record => record.statusKey === 'new'));
  assert.ok(after.ui.some(record => record.widgetKey === 'new'));
  assert.ok(!after.ui.some(record => record.statusKey === 'old' || record.widgetKey === 'old'));
  const commands = await client.request<RecordValue>('rpc', { slotId: slot.id, command: { type: 'get_commands' } });
  assert.ok(commands.commands.some((command: RecordValue) => command.name === 'smoke-new'));
  assert.ok(!commands.commands.some((command: RecordValue) => command.name === 'smoke-old'));
  await client.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: '/smoke-new' } });
  assert.deepEqual((await readFile(lifecycleLog, 'utf8')).trim().split('\n'), ['start-old', 'stop-old', 'start-new']);
  client.close(); client = await connect();
  const reattached = await client.request<Snapshot>('attach', { slotId: slot.id });
  assert.equal(reattached.slot.pid, reloaded.pid);
  assert.equal(reattached.state.sessionId, 'reload-smoke');
  console.log('PASS real Pi reload: new process and extension code, same slot/session/history, orderly shutdown, fresh commands/widgets, reattach');

  // Stock Pi assigns an empty session path before writing a file. Reload must work
  // there too, without creating an unintended second slot or requiring a prompt.
  const empty = await client.request<SlotInfo>('create', { cwd: root,
    args: ['--session-dir', join(root, 'empty-history'), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'] });
  await client.request('attach', { slotId: empty.id });
  const emptyBefore = await ready(client, empty.id);
  await assert.rejects(readFile(emptyBefore.state.sessionFile), { code: 'ENOENT' });
  await client.request('restart', { slotId: empty.id });
  const emptyAfter = await ready(client, empty.id);
  assert.equal(emptyAfter.slot.id, empty.id);
  assert.equal(emptyAfter.state.sessionFile, emptyBefore.state.sessionFile);
  assert.equal(emptyAfter.state.messageCount, 0);
  console.log('PASS real Pi reload before the first prompt: same slot and assigned session path');
} finally {
  for (const client of clients) client.close();
  await supervisor.stop();
  await rm(root, { recursive: true, force: true });
}
