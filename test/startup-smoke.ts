import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Runs the built CLI, never creates a Pi slot or makes a model request.
const exec = promisify(execFile);
const root = await realpath(await mkdtemp('/tmp/pi-remote-start-'));
const bin = fileURLToPath(new URL('../bin/pi-remote', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function list() {
  const {stdout} = await exec(process.execPath,[bin,'ls','--local','--json','--state-dir',root],{timeout:30_000});
  assert.deepEqual(JSON.parse(stdout),[]);
}
async function pid() { return Number(await readFile(`${root}/daemon.lock/pid`,'utf8')); }
let ownedPid: number | undefined;
try {
  await Promise.all(Array.from({length:6},list));
  ownedPid = await pid();
  assert.ok(ownedPid > 0);
  await Promise.all(Array.from({length:6},list));
  assert.equal(await pid(),ownedPid);
  console.log('PASS concurrent on-demand clients share one daemon');
  process.kill(ownedPid,'SIGKILL'); // Isolated test daemon has no agent slots.
  await sleep(300);
  const oldPid = ownedPid;
  ownedPid = undefined;
  await Promise.all(Array.from({length:6},list));
  ownedPid = await pid();
  assert.notEqual(ownedPid,oldPid);
  await Promise.all(Array.from({length:6},list));
  assert.equal(await pid(),ownedPid);
  console.log('PASS concurrent stale-owner reclamation preserves the new daemon socket');
} finally {
  if (ownedPid) {
    try { process.kill(ownedPid,'SIGTERM'); } catch (error:any) { if(error.code!=='ESRCH') throw error; }
    for(let i=0;i<50;i++) {
      try { await readFile(`${root}/daemon.lock/pid`); await sleep(100); }
      catch(error:any) { if(error.code==='ENOENT') break; throw error; }
    }
  }
  await rm(root,{recursive:true,force:true});
}
