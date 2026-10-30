import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {nodeModuleArgs} from '../../src/protocol/node-entry.js';
import test from 'node:test';
import {readLocalClipboard} from '../../src/tui/local-input.js';
import {imageMimeType} from '../../src/protocol/attachments.js';

test('clipboard is read only through explicit helper with injected clipboard, preserving text and file count limit',async()=>{
  assert.deepEqual(await readLocalClipboard({getImage:async()=>null,getText:async()=> 'local text'}),{attachments:[],text:'local text'});
  await assert.rejects(readLocalClipboard({getImage:async()=>null,getText:async()=>null,getFilePaths:async()=>Array.from({length:9},()=>'/file')}),/eight/);
});
test('full-buffer image validation excludes APNG even after a large ancillary chunk',()=>{
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const chunk=(name:string,length:number)=>{const b=Buffer.alloc(length+12);b.writeUInt32BE(length);b.write(name,4,'latin1');return b;};
  const png=Buffer.concat([sig,chunk('IHDR',13),chunk('tEXt',5000),chunk('acTL',8),chunk('IDAT',0)]);
  assert.equal(imageMimeType(png.subarray(0,4100)),'image/png');
  assert.equal(imageMimeType(png),undefined);
});
test('filesystem CLI preserves UTF-8 paths split into individual input bytes',async()=>{
  const root=await mkdtemp('/tmp/pi-utf8-');
  const path=`${root}/📁目录.txt`;
  await writeFile(path,'emoji 🦊 and 中文');
  try {
    const child=spawn(process.execPath,[...nodeModuleArgs(import.meta.url,'../../src/cli/main'),'fs','read_attachment'],{stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let error='';child.stdout.on('data',b=>chunks.push(b));child.stderr.setEncoding('utf8').on('data',s=>{error+=s;});
    for(const byte of Buffer.from(JSON.stringify({path}))) {child.stdin.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}
    child.stdin.end();
    const code=await new Promise(resolve=>child.once('close',resolve));
    assert.equal(code,0,error);
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(result.path,path);assert.equal(result.text,'emoji 🦊 and 中文');
  } finally {await rm(root,{recursive:true,force:true});}
});
