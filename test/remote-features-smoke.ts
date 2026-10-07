import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {connectCompatibleSsh} from '../src/compat-client.js';
import {shellQuote} from '../src/client.js';
import {ReconnectingConnection} from '../src/reconnect.js';
import {RemoteView} from '../src/view.js';
import {PI_VERSION,PROTOCOL_VERSION,type RemoteConnection,type Snapshot} from '../src/protocol.js';

const exec=promisify(execFile);
const host=process.env.PI_REMOTE_TEST_HOST??'rowan-v2-dev';
const legacy=process.env.PI_REMOTE_TEST_LEGACY==='1';
const remote=(command:string)=>exec('ssh',['-o','BatchMode=yes',host,command],{timeout:30_000});
const root=(await remote('mktemp -d /tmp/pi-remote-features.XXXXXX')).stdout.trim();
assert.match(root,/^\/tmp\/pi-remote-features\.[a-zA-Z0-9]+$/);
const stateDir=`${root}/daemon`;
const connections:RemoteConnection[]=[];
const slots:string[]=[];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const connect=async()=>{const c=await connectCompatibleSsh({host,stateDir});connections.push(c);return c;};
const attach=(c:RemoteConnection,slotId:string)=>c.request<Snapshot>('attach',{slotId,piVersion:PI_VERSION,protocol:PROTOCOL_VERSION});
const rpc=(c:RemoteConnection,slotId:string,command:any)=>c.request('rpc',{slotId,command});
const until=async<T>(read:()=>Promise<T>,matches:(value:T)=>boolean)=>{
  for(let i=0;i<100;i++){const value=await read();if(matches(value))return value;await sleep(100);}throw new Error('Timed out waiting for feature test condition');
};
console.log(`Isolated ${legacy?'legacy':'current'} daemon feature test: ${host}:${root}`);
try {
  await remote(`node -e ${shellQuote(`const fs=require('fs');fs.mkdirSync(${JSON.stringify(root+'/directory with spaces')});fs.writeFileSync(${JSON.stringify(root+'/🦊 note.txt')},'Remote UTF-8 中文 🦊');`)}`);
  if(legacy) await remote(`node "$HOME/.local/share/pi-remote/dist/cli.js" ls --local --json --state-dir ${shellQuote(stateDir)}`);
  let underlying:RemoteConnection;
  const sent:string[]=[];
  const client=await ReconnectingConnection.connect(async()=>{
    underlying=await connect();
    const request=underlying.request.bind(underlying);
    underlying.request=(method,params)=>{sent.push(params?.command?.type??method);return request(method,params);};
    return underlying;
  },{minDelayMs:50,maxDelayMs:200});
  connections.push(client);
  const first=await client.request('create',{cwd:root,args:['--session-dir',`${root}/history`]});slots.push(first.id);
  const initial=await attach(client,first.id);
  assert.equal(first.number,legacy?undefined:1);
  const other=await connect();await attach(other,first.id);
  const dirs=await client.request('complete_path',{slotId:first.id,prefix:'dir',directoriesOnly:true});
  assert.ok(dirs.items.some((item:any)=>item.value==='directory with spaces/'));
  const file=await client.request('read_attachment',{slotId:first.id,path:'🦊 note.txt'});
  assert.equal(file.text,'Remote UTF-8 中文 🦊');
  const metadata=await client.request('filesystem_metadata',{slotId:first.id});assert.equal(metadata.homeDir,'/home/ubuntu');
  const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
  const options=['--state-dir',stateDir];
  const completion=await exec(process.execPath,[cli,'complete','--shell','fish','--words',JSON.stringify(['new','--host',host,...options,'--cwd',`${root}/dir`])]);
  assert.match(completion.stdout,/directory.*spaces/);
  const slotCompletion=await exec(process.execPath,[cli,'complete','--shell','fish','--words',JSON.stringify(['attach','--host',host,...options,''])]);
  assert.match(slotCompletion.stdout,/1\t/);
  console.log('PASS remote cwd/slot shell completion, numeric selection, UTF-8 file attachments, remote metadata');

  const view=new RemoteView(initial);
  let recovered:Snapshot|undefined;
  client.onReconnect(snapshot=>{recovered=snapshot;view.replace(snapshot);});
  client.onEvent(event=>view.apply(event));
  const outcome=rpc(client,first.id,{type:'bash',command:`printf 'streaming'; sleep 2; printf 'finished'; printf once >> ${shellQuote(root+'/executions')}`}).then(()=>false,()=>true);
  await until(async()=>view.snapshot,s=>Object.keys(s.live.bash??{}).length>0);
  underlying!.close();assert.equal(await outcome,true);
  await until(async()=>recovered,s=>!!s);
  assert.equal(recovered!.slot.pid,first.pid);
  const completed=await until(()=>other.request<Snapshot>('snapshot',{slotId:first.id}),s=>s.entries.some(e=>e.message?.role==='bashExecution'&&e.message.output.includes('finished')));
  assert.equal(completed.slot.pid,first.pid);
  assert.equal((await client.request('read_attachment',{slotId:first.id,path:'executions'})).text,'once');
  assert.equal(sent.filter(type=>type==='bash').length,1,'recovery must never replay a command');
  console.log('PASS live SSH recovery reattached the same Pi PID; in-flight bash completed exactly once');
  const second=await client.request('create',{cwd:root,args:['--session-dir',`${root}/second-history`]});slots.push(second.id);
  assert.equal(second.number,legacy?undefined:2);
  const selected=await exec(process.execPath,[cli,'rpc','--host',host,'2',...options,JSON.stringify({type:'get_state'})]);
  assert.ok(JSON.parse(selected.stdout).sessionId);
  console.log('PASS second independent slot and numeric CLI targeting');
} finally {
  for(const c of connections.reverse())c.close();
  const cleaner=await connect();
  try{for(const slotId of slots)await cleaner.request('kill',{slotId});}finally{cleaner.close();}
  await remote(`node -e ${shellQuote(`const fs=require('fs');try{process.kill(Number(fs.readFileSync(${JSON.stringify(stateDir+'/daemon.lock/pid')},'utf8')),'SIGTERM')}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}`)}`);
  console.log(`Stopped only isolated test slots/daemon; logs retained at ${root}`);
}
