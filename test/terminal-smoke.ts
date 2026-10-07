import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {connectCompatibleSsh} from '../src/compat-client.js';
import {shellQuote} from '../src/client.js';
import type {Snapshot} from '../src/protocol.js';
const exec=promisify(execFile);
const host=process.env.PI_REMOTE_TEST_HOST??'rowan-v2-dev';
const remote=(command:string)=>exec('ssh',['-o','BatchMode=yes',host,command],{timeout:30_000});
const root=(await remote('mktemp -d /tmp/pi-remote-terminal.XXXXXX')).stdout.trim();
assert.match(root,/^\/tmp\/pi-remote-terminal\.[a-zA-Z0-9]+$/);
const stateDir=`${root}/daemon`;
const tmuxName=`features-${process.pid}`;
const tmux=(...args:string[])=>exec('tmux',['-L','pi-remote-test',...args]);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const client=await connectCompatibleSsh({host,stateDir});
let slotId:string|undefined;
let created=false;
const screen=async()=>(await tmux('capture-pane','-p','-S','-100','-t',tmuxName)).stdout;
async function until(matches:(screen:string)=>boolean){for(let i=0;i<120;i++){const output=await screen();if(matches(output))return output;await sleep(100);}throw new Error(`Terminal condition timed out:\n${await screen()}`);}
try {
  const slot=await client.request('create',{cwd:root,args:['--session-dir',`${root}/history`]});slotId=slot.id;
  const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
  const adapter=fileURLToPath(new URL('../examples/rowan-ui.ts',import.meta.url));
  const command=['node',cli,'attach',host,'1','--state-dir',stateDir,'--ui-extension',adapter,'--ui-config','/tmp/pi-remote-no-ui-config.json','--theme','gruvbox-dark'].map(shellQuote).join(' ');
  await tmux('new-session','-d','-s',tmuxName,'-x','140','-y','45',`exec ${command}`);created=true;
  const initial=await until(s=>s.includes('›')&&s.includes('Enter steer'));
  assert.doesNotMatch(initial,/Local presentation:.*(?:failed|Error|Cannot)/);
  console.log('PASS real local terminal loaded the selected footer, caret editor and theme over SSH');
  await tmux('send-keys','-t',tmuxName,'-l','!printf PTY_REMOTE_OK');await tmux('send-keys','-t',tmuxName,'Enter');
  await until(s=>s.includes('PTY_REMOTE_OK')&&s.includes('$ printf'));
  for(let i=0;i<100;i++){const snapshot=await client.request<Snapshot>('snapshot',{slotId});if(snapshot.entries.some(e=>e.message?.output?.includes('PTY_REMOTE_OK')))break;await sleep(100);}
  const before=await client.request<Snapshot>('snapshot',{slotId});
  assert.ok(before.entries.some(e=>e.message?.output?.includes('PTY_REMOTE_OK')));
  await tmux('send-keys','-t',tmuxName,'-l','LOCAL_DRAFT_PRESERVED');
  await until(s=>s.includes('› LOCAL_DRAFT_PRESERVED'));
  const panePid=Number((await tmux('display-message','-p','-t',tmuxName,'#{pane_pid}')).stdout.trim());
  const sshPids=(await exec('pgrep',['-P',String(panePid),'ssh'])).stdout.trim().split(/\s+/).map(Number);
  assert.equal(sshPids.length,1,'only stop this test terminal’s SSH child');
  process.kill(sshPids[0],'SIGTERM');
  const recovered=await until(s=>s.includes('Reattached.')&&s.includes('› LOCAL_DRAFT_PRESERVED'));
  assert.doesNotMatch(recovered,/Local presentation:.*(?:failed|Error|Cannot)/);
  const after=await client.request<Snapshot>('snapshot',{slotId});
  assert.equal(after.slot.pid,slot.pid);assert.equal(after.state.messageCount,before.state.messageCount);
  console.log('PASS actual terminal auto-reconnected after its SSH child died; draft and remote process were preserved');
  await tmux('send-keys','-t',tmuxName,'C-u');
  await tmux('send-keys','-t',tmuxName,'-l','/model');await tmux('send-keys','-t',tmuxName,'Enter');
  await until(s=>s.includes('Choose model'));await tmux('send-keys','-t',tmuxName,'Escape');
  await tmux('send-keys','-t',tmuxName,'C-d');await sleep(300);
  assert.equal((await client.request('list')).find((s:any)=>s.id===slotId).status,'running');
  console.log('PASS local model picker and detach without stopping Pi');
} finally {
  if(created)await tmux('kill-session','-t',tmuxName).catch(()=>{});
  try{if(slotId)await client.request('kill',{slotId});}finally{client.close();}
  await remote(`node -e ${shellQuote(`const fs=require('fs');try{process.kill(Number(fs.readFileSync(${JSON.stringify(stateDir+'/daemon.lock/pid')},'utf8')),'SIGTERM')}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}`)}`);
  console.log(`Stopped only isolated terminal test slots/daemon; logs retained at ${root}`);
}
