import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibleConnection } from '../../src/client/compat-client.js';
import type { ConnectionRetry, RemoteConnection, RecordValue } from '../../src/protocol/types.js';

function mock(request: (method: string, params: RecordValue) => Promise<any>): RemoteConnection {
  return {request:(method,params={})=>request(method,params),onEvent:()=>()=>{},onDisconnect:()=>()=>{},close(){}};
}
test('old-daemon filesystem methods use read-only sideband without restarting or creating slots',async()=>{
  const calls:string[]=[];
  const transport=mock(async(method)=>{
    calls.push(method);
    if(method==='list') return [{id:'a',cwd:'/remote/project'}];
    throw new Error(`Unknown daemon method: ${method}`);
  });
  const sideband:RecordValue[]=[];
  const connection=new CompatibleConnection(transport,async(method,params)=>{sideband.push({method,params});return {items:[]};});
  await connection.request('complete_path',{slotId:'a',prefix:'src/'});
  await connection.request('read_attachment',{slotId:'a',path:'src/main.ts'});
  assert.deepEqual(calls,['complete_path','list','list']);
  assert.equal(sideband[0].params.cwd,'/remote/project');
  assert.equal(sideband[1].method,'read_attachment');
});
test('network/authorization errors never trigger sideband fallback',async()=>{
  let calls=0;
  const connection=new CompatibleConnection(mock(async()=>{throw new Error('Connection closed');}),async()=>{calls++;});
  await assert.rejects(connection.request('read_attachment',{path:'file'}),/Connection closed/);
  assert.equal(calls,0);
});
test('mutations are never retried or sent to the sideband',async()=>{
  let calls=0;
  const connection=new CompatibleConnection(mock(async()=>{throw new Error('Unknown daemon method: rpc');}),async()=>{calls++;});
  await assert.rejects(connection.request('rpc',{command:{type:'prompt',message:'do work'}}),/Unknown daemon/);
  assert.equal(calls,0);
});
test('new daemon uses native filesystem route without sideband',async()=>{
  const connection=new CompatibleConnection(mock(async()=>({items:[{value:'project/'}]})),async()=>{throw new Error('must not run');});
  assert.deepEqual(await connection.request('complete_path',{prefix:'p'}),{items:[{value:'project/'}]});
});

test('compatibility wrapper forwards retry subscriptions and the current recovery state', () => {
  let recovering = false;
  const listeners = new Set<(retry: ConnectionRetry) => void>();
  const transport: RemoteConnection = {
    ...mock(async () => []),
    get reconnecting() { return recovering; },
    onRetry(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const connection = new CompatibleConnection(transport, async () => ({ items: [], truncated: false }));
  assert.equal(connection.reconnecting, false);
  recovering = true;
  assert.equal(connection.reconnecting, true);
  const retries: ConnectionRetry[] = [];
  const off = connection.onRetry!(retry => retries.push(retry));
  const retry = { attempt: 1, error: new Error('SSH refused'), nextDelayMs: 2000 };
  for (const listener of listeners) listener(retry);
  assert.deepEqual(retries, [retry]);
  assert.equal(retries[0], retry);
  off();
  assert.equal(listeners.size, 0);
  recovering = false;
  assert.equal(connection.reconnecting, false);
});

test('compatibility wrapper preserves absent optional retry and recovery hooks', () => {
  const connection = new CompatibleConnection(mock(async () => []), async () => ({ items: [], truncated: false }));
  assert.equal(connection.onRetry, undefined);
  assert.equal(connection.onReconnect, undefined);
  assert.equal(connection.reconnecting, undefined);
});
