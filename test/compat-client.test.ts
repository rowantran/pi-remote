import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibleConnection } from '../src/compat-client.js';
import type { RemoteConnection, RecordValue } from '../src/protocol.js';

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
