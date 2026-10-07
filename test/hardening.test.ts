import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {applyLiveEvent,emptyLive} from '../src/live.js';
import {transformPromptWithAttachments} from '../src/editor-completion.js';
import {readLocalClipboard} from '../src/local-input.js';
import {imageMimeType} from '../src/files.js';
import {applyAssistantDelta,RemoteView} from '../src/view.js';
import type {RecordValue} from '../src/protocol.js';

function viewFixture() {
  const view=new RemoteView({
    slot:{id:'slot',cwd:'/remote',createdAt:'',status:'running',clients:1},
    state:{},entries:[],leafId:null,live:emptyLive(),ui:[],seq:0,
  });
  return {view,apply:(event:RecordValue)=>view.apply({type:'event',slotId:'slot',seq:view.snapshot.seq+1,event})};
}

test('tool execution IDs remain own data properties throughout both reducer lifecycles',()=>{
  const live=emptyLive();
  const {view,apply}=viewFixture();
  const ids=['__proto__','constructor','toString'];
  for(const toolCallId of ids) {
    const start={type:'tool_execution_start',toolCallId,toolName:'read',args:{path:'original'}};
    applyLiveEvent(live,start);apply(start);
    start.args.path='changed';
    for(const tools of [live.tools,view.snapshot.live.tools]) {
      assert.equal(Object.hasOwn(tools,toolCallId),true);
      assert.equal(tools[toolCallId].args.path,'original');
      assert.equal(Object.getPrototypeOf(tools),Object.prototype);
    }
    const update={type:'tool_execution_update',toolCallId,partialResult:{content:['partial']}};
    applyLiveEvent(live,update);apply(update);
    assert.deepEqual(live.tools[toolCallId].partialResult.content,['partial']);
    assert.deepEqual(view.snapshot.live.tools[toolCallId].partialResult.content,['partial']);
    assert.equal(view.snapshot.live.tools[toolCallId].args.path,'original');
    const end={type:'tool_execution_end',toolCallId,result:{content:['done']}};
    applyLiveEvent(live,end);apply(end);
    assert.equal(Object.hasOwn(live.tools,toolCallId),false);
    assert.equal(Object.hasOwn(view.snapshot.live.tools,toolCallId),true);
    assert.equal(view.snapshot.live.tools[toolCallId].type,'tool_execution_end');
    assert.equal(view.snapshot.live.tools[toolCallId].args.path,'original');
  }
  assert.deepEqual(Object.keys(live.tools),[]);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(view.snapshot.live.tools))),ids);
  assert.equal(Object.getPrototypeOf(live.tools),Object.prototype);
  assert.equal(Object.getPrototypeOf(view.snapshot.live.tools),Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype,'toolCallId'),false);
});

test('tool reducers ignore non-string IDs and view updates never merge inherited records',()=>{
  const live=emptyLive();
  const {view,apply}=viewFixture();
  for(const toolCallId of [undefined,null,42,{},[]]) {
    for(const type of ['tool_execution_start','tool_execution_update','tool_execution_end']) {
      const event={type,toolCallId};
      applyLiveEvent(live,event);apply(event);
    }
  }
  assert.deepEqual(live.tools,{});
  assert.deepEqual(view.snapshot.live.tools,{});
  const inherited={toolCallId:'inherited',args:{path:'must not inherit'}};
  Object.setPrototypeOf(view.snapshot.live.tools,{inherited});
  apply({type:'tool_execution_update',toolCallId:'inherited',partialResult:{content:[]}});
  assert.equal(Object.hasOwn(view.snapshot.live.tools,'inherited'),true);
  assert.equal(view.snapshot.live.tools.inherited.args,undefined);
  assert.deepEqual(inherited,{toolCallId:'inherited',args:{path:'must not inherit'}});
});

test('both reducers ignore malformed delta types and non-string delta payloads',()=>{
  const live=emptyLive();
  const {view,apply}=viewFixture();
  const message={role:'assistant',timestamp:0,stopReason:'pending',usage:{output:1},content:[{type:'text',text:'retained'}]};
  applyLiveEvent(live,{type:'message_start',message});apply({type:'message_start',message});
  const malformed:unknown[]=[undefined,null,42,'text_delta',[],{},
    ...[undefined,null,42,{},[]].map(type=>({type,contentIndex:0,delta:'bad'})),
    ...['text_delta','thinking_delta','toolcall_delta'].flatMap(type=>
      [undefined,null,42,{},[]].map(delta=>({type,contentIndex:0,delta}))),
  ];
  for(const assistantMessageEvent of malformed) {
    applyLiveEvent(live,{type:'message_update',assistantMessageEvent});
    apply({type:'message_update',assistantMessageEvent});
    assert.deepEqual(applyAssistantDelta(message,assistantMessageEvent as RecordValue),message);
    assert.deepEqual(live.messages[0],message);
    assert.deepEqual(view.snapshot.live.messages[0],message);
  }
  const valid={type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' valid'}};
  applyLiveEvent(live,valid);apply(valid);
  assert.equal(live.messages[0].content[0].text,'retained valid');
  assert.equal(view.snapshot.live.messages[0].content[0].text,'retained valid');
});

test('live reducer bounds malformed indices instead of creating enormous sparse arrays',()=>{
  const live=emptyLive();
  applyLiveEvent(live,{type:'message_start',message:{role:'assistant',timestamp:0,stopReason:'pending',content:[]}});
  for(const contentIndex of [-1,1.5,Infinity,4294967294]) applyLiveEvent(live,{type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex,delta:'bad'}});
  assert.equal(live.messages[0].content.length,0);
});
test('bash execution IDs cannot modify object prototypes',()=>{
  const live=emptyLive();
  for(const id of ['__proto__','constructor','toString']) {
    applyLiveEvent(live,{type:'bash_execution_update',id,delta:'output'});
    assert.equal(live.bash![id].output,'output');
  }
  assert.equal(Object.getPrototypeOf(live.bash),Object.prototype);
  assert.equal((Object.prototype as any).output,undefined);
});
test('aggregate attachments are bounded before a prompt is sent',async()=>{
  await assert.rejects(transformPromptWithAttachments('@a.txt @b.txt',async path=>({path,image:{type:'image',mimeType:'image/png',data:'x'.repeat(13*1024*1024)}})),/24 MiB/);
});
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
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'fs','read_attachment'],{stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let error='';child.stdout.on('data',b=>chunks.push(b));child.stderr.setEncoding('utf8').on('data',s=>{error+=s;});
    for(const byte of Buffer.from(JSON.stringify({path}))) {child.stdin.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}
    child.stdin.end();
    const code=await new Promise(resolve=>child.once('close',resolve));
    assert.equal(code,0,error);
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(result.path,path);assert.equal(result.text,'emoji 🦊 and 中文');
  } finally {await rm(root,{recursive:true,force:true});}
});
