import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectSsh, shellQuote, type Connection } from '../src/client.js';
import { PI_VERSION, PROTOCOL_VERSION, type SlotInfo, type Snapshot } from '../src/protocol.js';

const exec = promisify(execFile);
const host = process.env.PI_REMOTE_TEST_HOST ?? 'rowan-v2-dev';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const remote = (command: string) => exec('ssh', ['-o', 'BatchMode=yes', host, command], { timeout: 30_000 });
const { stdout } = await remote('mktemp -d /tmp/pi-remote-smoke.XXXXXX');
const root = stdout.trim();
assert.match(root, /^\/tmp\/pi-remote-smoke\.[a-zA-Z0-9]+$/);
const stateDir = `${root}/daemon`;
const connections: Connection[] = [];
const ownedSlots: string[] = [];
async function connect() { const c = await connectSsh({host, stateDir}); connections.push(c); return c; }
async function attach(c: Connection, slotId: string) { return c.request<Snapshot>('attach', {slotId, piVersion:PI_VERSION, protocol:PROTOCOL_VERSION}); }
async function rpc(c: Connection, slotId: string, command: Record<string, any>) { return c.request('rpc', {slotId,command}); }
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (matches(value)) return value; await sleep(200); }
  throw new Error('Timed out waiting for remote smoke test condition');
}
console.log(`Isolated real-host test: ${host}:${root}`);
try {
  await exec('scp', ['-q', fileURLToPath(new URL('./live-extension.ts', import.meta.url)), `${host}:${root}/extension.ts`]);
  let client = await connect();
  const slot = await client.request<SlotInfo>('create', {cwd:root,args:['--session-dir',`${root}/history`,'-e',`${root}/extension.ts`]});
  ownedSlots.push(slot.id);
  const first = await attach(client, slot.id);
  assert.equal(first.slot.pid, slot.pid);
  console.log(`PASS on-demand detached daemon; stock Pi ${PI_VERSION} pid ${slot.pid}`);

  // A stock RPC bash command, deliberately interrupted only on the presentation side.
  const bash = rpc(client, slot.id, {type:'bash',command:'sleep 3; printf PI_REMOTE_DISCONNECTED_OK'});
  const rejected = bash.then(() => false, () => true);
  await sleep(500);
  client.close();
  assert.equal(await rejected, true);
  await sleep(3500);
  client = await connect();
  const afterBash = await attach(client, slot.id);
  assert.equal(afterBash.slot.pid, slot.pid);
  assert.ok(afterBash.entries.some(e => e.message?.role === 'bashExecution' && e.message.output.includes('PI_REMOTE_DISCONNECTED_OK')));
  console.log('PASS remote work completed while SSH client was disconnected; same Pi PID and session history');

  const dialogCommand = rpc(client, slot.id, {type:'prompt',message:'/remote-smoke-dialog'}).catch(() => {});
  const waiting = await until(() => client.request<Snapshot>('snapshot',{slotId:slot.id}), s => s.ui.some(u=>u.method==='input'));
  const dialog = waiting.ui.find(u=>u.method==='input')!;
  client.close();
  await dialogCommand;
  await sleep(300);
  client = await connect();
  const recovered = await attach(client, slot.id);
  assert.ok(recovered.ui.some(u => u.id === dialog.id));
  assert.ok(recovered.ui.some(u => u.method === 'setStatus' && u.statusText === 'Waiting for a client'));
  assert.ok(recovered.ui.some(u => u.method === 'setWidget'));
  const second = await connect();
  const sameDialog = await attach(second, slot.id);
  assert.ok(sameDialog.ui.some(u => u.id === dialog.id));
  await client.request('answer', {slotId:slot.id,response:{id:dialog.id,value:'PI_REMOTE_DIALOG_OK'}});
  await assert.rejects(second.request('answer',{slotId:slot.id,response:{id:dialog.id,value:'duplicate'}}), /already answered/);
  const answered = await until(() => client.request<Snapshot>('snapshot',{slotId:slot.id}), s => s.entries.some(e=>e.customType==='remote-smoke-answer'));
  assert.equal(answered.entries.find(e=>e.customType==='remote-smoke-answer')?.data.value,'PI_REMOTE_DIALOG_OK');
  console.log('PASS extension input/status/widget survived disconnect; two attachments; first answer wins');
  second.close();

  const statistics = await rpc(client,slot.id,{type:'get_session_stats'});
  assert.ok(statistics.sessionId);
  const models = await rpc(client,slot.id,{type:'get_available_models'});
  assert.ok(models.models.length > 0);
  await assert.rejects(client.request('create',{cwd:root,sessionPath:answered.state.sessionFile}),/already open/);
  console.log('PASS public RPC session statistics/model discovery; duplicate session writer rejected');

  if (process.env.PI_REMOTE_TEST_MODEL === '1') {
    const acceptance = await rpc(client,slot.id,{type:'prompt',message:'Reply exactly PI_REMOTE_MODEL_OK. Do not call any tools.'});
    assert.equal(acceptance.disposition,'started');
    client.close();
    await sleep(1500);
    client = await connect();
    await attach(client,slot.id);
    const final = await until(() => client.request<Snapshot>('snapshot',{slotId:slot.id}), s => !s.live.busy && s.entries.some(e=>e.message?.role==='assistant' && e.message.content?.some((b:any)=>b.text?.includes('PI_REMOTE_MODEL_OK'))),120_000);
    assert.equal(final.slot.pid,slot.pid);
    const text = await rpc(client,slot.id,{type:'get_last_assistant_text'});
    assert.match(text.text,/PI_REMOTE_MODEL_OK/);
    console.log('PASS real configured model completed across SSH disconnect; assistant text available for local clipboard');

    const originalPath = final.state.sessionFile;
    const model = final.state.model;
    await rpc(client,slot.id,{type:'set_model',provider:model.provider,modelId:model.id});
    const choices = await rpc(client,slot.id,{type:'get_fork_messages'});
    const forked = await rpc(client,slot.id,{type:'fork',entryId:choices.messages.at(-1).entryId});
    assert.equal(forked.cancelled,false);
    assert.match(forked.text,/PI_REMOTE_MODEL_OK/);
    const afterFork = await client.request<Snapshot>('snapshot',{slotId:slot.id});
    assert.notEqual(afterFork.state.sessionId,final.state.sessionId);
    assert.ok(!afterFork.live.messages.some(m=>m.role==='assistant'));
    const created = await rpc(client,slot.id,{type:'new_session'});
    assert.equal(created.cancelled,false);
    const fresh = await client.request<Snapshot>('snapshot',{slotId:slot.id});
    assert.notEqual(fresh.state.sessionId,afterFork.state.sessionId);
    assert.equal(fresh.live.messages.length,0);
    const sessions = await client.request<any[]>('sessions',{slotId:slot.id});
    assert.ok(sessions.some(session=>session.path===originalPath));
    const resumed = await rpc(client,slot.id,{type:'switch_session',sessionPath:originalPath});
    assert.equal(resumed.cancelled,false);
    const restored = await client.request<Snapshot>('snapshot',{slotId:slot.id});
    assert.equal(restored.state.sessionId,final.state.sessionId);
    assert.match((await rpc(client,slot.id,{type:'get_last_assistant_text'})).text,/PI_REMOTE_MODEL_OK/);
    console.log('PASS model selection, fork prompt restoration, new session isolation, remote session listing and resume');
  }
  const later = await client.request<SlotInfo>('create',{cwd:root,args:['--session-dir',`${root}/second-history`]});
  ownedSlots.push(later.id);
  assert.notEqual(later.pid,slot.pid);
  await attach(client,later.id);
  const empty = await rpc(client,later.id,{type:'get_entries'});
  assert.ok(!empty.entries.some((e:any)=>e.customType==='remote-smoke-answer'));
  console.log('PASS separate stock Pi process and history per slot');
} finally {
  for (const connection of connections) connection.close();
  let cleaner: Connection | undefined;
  try { cleaner = await connectSsh({host,stateDir}); for (const slotId of ownedSlots) await cleaner.request('kill',{slotId}); }
  finally { cleaner?.close(); }
  await remote(`node -e ${shellQuote(`const fs=require('fs');try{const pid=Number(fs.readFileSync(${JSON.stringify(`${stateDir}/daemon.lock/pid`)},'utf8'));process.kill(pid,'SIGTERM')}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}`)}`);
  await sleep(500);
  console.log(`Test files and daemon log retained for inspection at ${host}:${root}; test slots stopped.`);
}
