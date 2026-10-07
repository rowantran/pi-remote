import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Connection} from '../src/client.js';
import {Supervisor,socketPath} from '../src/daemon.js';
import {PI_VERSION,PROTOCOL_VERSION} from '../src/protocol.js';

test('slot numbers migrate, persist across daemon restart, and are never reused after kill',async()=>{
  const root=await realpath(await mkdtemp('/tmp/pi-numbers-'));
  let supervisor:Supervisor|undefined;
  let connection:Connection|undefined;
  const start=async()=>{
    supervisor=new Supervisor({stateDir:root,executable:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixture-pi.mjs',import.meta.url))],skipVersionCheck:true});
    await supervisor.start();
    const socket=createConnection(socketPath(root));
    await new Promise<void>((r,j)=>{socket.once('connect',r);socket.once('error',j);});
    connection=new Connection(socket,socket,()=>socket.destroy());
    await connection.request('hello',{protocol:PROTOCOL_VERSION,piVersion:PI_VERSION});
  };
  try {
    await start();
    const first=await connection!.request('create',{cwd:root});
    const second=await connection!.request('create',{cwd:root});
    assert.equal(first.number,1);assert.equal(second.number,2);
    await connection!.request('kill',{slotId:first.id});
    const third=await connection!.request('create',{cwd:root});
    assert.equal(third.number,3);
    connection!.close();await supervisor!.stop();
    // Simulate the v0.1 metadata format: no number field.
    const legacy=JSON.parse(await readFile(`${root}/slots.json`,'utf8'));
    for(const slot of legacy) delete slot.number;
    await writeFile(`${root}/slots.json`,JSON.stringify(legacy));
    await start();
    const restored=await connection!.request('list');
    assert.deepEqual(restored.map((s:any)=>s.number),[1,2,3]);
    const fourth=await connection!.request('create',{cwd:root});
    assert.equal(fourth.number,4);
  } finally {connection?.close();await supervisor?.stop();await rm(root,{recursive:true,force:true});}
});

test('migration reserves explicit numbers in mixed metadata and preserves them after reordering',async()=>{
  const root=await realpath(await mkdtemp('/tmp/pi-numbers-mixed-'));
  let supervisor:Supervisor|undefined;
  let connection:Connection|undefined;
  const start=async()=>{
    supervisor=new Supervisor({stateDir:root,executable:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixture-pi.mjs',import.meta.url))],skipVersionCheck:true});
    await supervisor.start();
    const socket=createConnection(socketPath(root));
    await new Promise<void>((r,j)=>{socket.once('connect',r);socket.once('error',j);});
    connection=new Connection(socket,socket,()=>socket.destroy());
    await connection.request('hello',{protocol:PROTOCOL_VERSION,piVersion:PI_VERSION});
  };
  try {
    const metadata=[
      {id:'legacy-first'},
      {id:'explicit-high',number:9},
      {id:'explicit-two',number:2},
      {id:'invalid',number:0},
      {id:'explicit-one-later',number:1},
      {id:'duplicate',number:9},
    ].map(slot=>({...slot,cwd:root,createdAt:'2026-01-01T00:00:00.000Z',args:[]}));
    await writeFile(`${root}/slots.json`,JSON.stringify(metadata));
    await start();
    const restored=await connection!.request('list');
    const numbers=(slots:any[])=>Object.fromEntries(slots.map(slot=>[slot.id,slot.number]));
    const expected={
      'legacy-first':3,'explicit-high':9,'explicit-two':2,
      invalid:4,'explicit-one-later':1,duplicate:5,
    };
    assert.deepEqual(numbers(restored),expected);
    assert.ok(restored.every((slot:any)=>slot.status==='exited'));
    const next=await connection!.request('create',{cwd:root});
    assert.equal(next.number,10,'New slots use max(number) + 1, not the row count');
    connection!.close();await supervisor!.stop();
    const stored=JSON.parse(await readFile(`${root}/slots.json`,'utf8'));
    assert.deepEqual(numbers(stored),{...expected,[next.id]:10});
    await writeFile(`${root}/slots.json`,JSON.stringify(stored.reverse()));
    await start();
    assert.deepEqual(numbers(await connection!.request('list')),{...expected,[next.id]:10});
    const afterRestart=await connection!.request('create',{cwd:root});
    assert.equal(afterRestart.number,11);
  } finally {connection?.close();await supervisor?.stop();await rm(root,{recursive:true,force:true});}
});
