#!/usr/bin/env node
// Deterministic public-RPC stand-in. No SDK runtime, credentials, or network access.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1) ?? fallback;
};
if (args.includes('--version')) {
  if (process.env.PI_FIXTURE_VERSION_LOG) appendFileSync(process.env.PI_FIXTURE_VERSION_LOG, 'version\n');
  const version = process.env.PI_FIXTURE_VERSION_FILE ? readFileSync(process.env.PI_FIXTURE_VERSION_FILE, 'utf8').trim() : '1.0.4';
  process.stdout.write(version + '\n');
  process.exit(0);
}
if (option('--mode') !== 'rpc') throw new Error('Fixture requires --mode rpc');
let sessionId = option('--session-id', randomUUID());
const sessionDir = resolve(option('--session-dir', join(process.cwd(), '.fixture-sessions')));
let sessionFile = resolve(option('--session', join(sessionDir, `${sessionId}.jsonl`)));
let entries = [];
let sessionName = option('--name');
let streaming = false;
let compacting = false;
let boundaryArmed = false;
let failStateCount = 0;
let failEntriesCount = Number(option('--fixture-fail-entries', '0'));
let switchAfterStates = 0;
let dialogNumber = 0;
const pendingDialogs = new Map();
const blockedQueries = [];
const seenIds = new Set();
const timers = new Set();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const send = (...records) => process.stdout.write(records.map(record => JSON.stringify(record) + '\n').join(''));
const response = (command, data, error) => ({ type: 'response', id: command.id, command: command.type,
  success: !error, ...(error ? { error } : { data }) });
const later = (delay, callback) => {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
  return timer;
};
function openSession() {
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
    id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\n');
  const records = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  sessionId = records[0].id;
  entries = records.slice(1);
}
openSession();
function newSession(sameFile = false) {
  sessionId = randomUUID();
  if (!sameFile) sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  sessionName = undefined;
  streaming = false;
  compacting = false;
  entries = [];
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
    id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\n');
}
function append(message) {
  const entry = { type: 'message', id: randomUUID().slice(0, 8), parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(), message };
  entries.push(entry);
  appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
}
const state = () => ({ sessionId, sessionFile, sessionName, isStreaming: streaming, isCompacting: compacting,
  thinkingLevel: 'off', steeringMode: 'all', followUpMode: 'one-at-a-time', autoCompactionEnabled: false,
  messageCount: entries.filter(entry => entry.type === 'message').length, pendingMessageCount: 0 });
const assistant = (text, timestamp, stopReason = 'pending') => ({ role: 'assistant',
  content: text ? [{ type: 'text', text }] : [], api: 'fixture', provider: 'fixture', model: 'fixture',
  usage, timestamp, stopReason });
const delta = text => ({ type: 'message_update', usage,
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
function finish(message) {
  streaming = false;
  append(message);
  send({ type: 'message_end', message }, { type: 'turn_end', message, toolResults: [] },
    { type: 'agent_end', messages: [message], willRetry: false }, { type: 'agent_settled' });
}
function prompt(command) {
  if (command.message === '/exit') {
    process.stderr.write('fixture requested exit\n');
    later(20, () => process.exit(23));
    return;
  }
  if (command.message === '/boundary') {
    boundaryArmed = true;
    send(response(command, { disposition: 'handled' }));
    return;
  }
  // Fixture-only extension commands still use stock prompt and event wire records.
  if (command.message === '/malformed-output') {
    // Keep the triggering command outstanding while corrupting one small stdout frame.
    process.stdout.write('{malformed fixture output}\n');
    later(30, () => send({ type: 'queue_update', steering: [], followUp: [] }, response(command, { disposition: 'handled' })));
    return;
  }
  if (command.message === '/consumer-event') {
    send({ type: 'queue_update', steering: ['consumer event'], followUp: [] }, response(command, { disposition: 'handled' }));
    return;
  }
  if (command.message === '/fail-next-state') {
    sessionName = 'mutation applied before refresh failed';
    failStateCount = 1;
    send(response(command, { disposition: 'handled' }));
    return;
  }
  if (command.message === '/seed-live') {
    streaming = true;
    compacting = true;
    send({ type: 'agent_start' }, { type: 'message_start', message: assistant('', Date.now()) },
      delta('old session partial'), { type: 'tool_execution_start', toolCallId: 'old-tool', toolName: 'read', args: { path: 'old' } },
      { type: 'queue_update', steering: ['old steering'], followUp: ['old follow-up'] },
      { type: 'compaction_start', reason: 'manual' }, response(command, { disposition: 'handled' }));
    return;
  }
  if (command.message === '/switch-on-snapshot') {
    // The RPC's own refresh gets the old identity; the next snapshot gets a new ID at the same path.
    switchAfterStates = 2;
    send(response(command, { disposition: 'handled' }));
    return;
  }
  if (command.message === '/switch-session') {
    newSession();
    send(response(command, { disposition: 'handled' }));
    return;
  }
  if (['/dialog', '/confirm', '/select', '/editor', '/timeout'].includes(command.message)) {
    const id = `fixture-dialog-${++dialogNumber}`;
    // Delay opening so a test can disconnect before the dialog exists.
    later(60, () => {
      const method = ({ '/confirm': 'confirm', '/select': 'select', '/editor': 'editor' })[command.message] ?? 'input';
      const timeout = command.message === '/timeout' ? 120 : undefined;
      const dialog = { type: 'extension_ui_request', id, method, title: 'Fixture dialog',
        ...(method === 'confirm' ? { message: 'Continue?' } : method === 'select' ? { options: ['Allow', 'Block'] }
          : method === 'editor' ? { prefill: 'initial text' } : { placeholder: 'answer' }),
        ...(timeout ? { timeout } : {}) };
      const pending = { command, timer: undefined };
      pendingDialogs.set(id, pending);
      send(dialog);
      if (timeout) pending.timer = later(timeout, () => {
        if (!pendingDialogs.delete(id)) return;
        send(response(command, { disposition: 'handled' }), { type: 'extension_ui_request',
          id: randomUUID(), method: 'notify', notifyType: 'info', message: 'dialog timed out' });
      });
    });
    return;
  }
  if (streaming) { send(response(command, undefined, 'Already streaming')); return; }
  streaming = true;
  const timestamp = Date.now();
  const user = { role: 'user', content: command.message, timestamp };
  append(user);
  send(response(command, { disposition: 'started' }), { type: 'agent_start' }, { type: 'turn_start' },
    { type: 'message_start', message: user }, { type: 'message_end', message: user },
    { type: 'message_start', message: assistant('', timestamp + 1) }, delta('partial: '));
  later(400, () => { if (streaming) send(delta(command.message)); });
  later(700, () => { if (streaming) finish(assistant(`partial: ${command.message} complete`, timestamp + 1, 'stop')); });
}
function handle(command) {
  if (command.type === 'extension_ui_response') {
    const pending = pendingDialogs.get(command.id);
    if (!pending) return;
    pendingDialogs.delete(command.id);
    clearTimeout(pending.timer);
    timers.delete(pending.timer);
    if (pending.newSession && command.cancelled !== true && command.confirmed === true) newSession();
    const data = pending.newSession ? { cancelled: command.cancelled === true || command.confirmed !== true } : { disposition: 'handled' };
    send(response(pending.command, data), { type: 'extension_ui_request',
      id: randomUUID(), method: 'notify', notifyType: 'info',
      message: `answer:${JSON.stringify({ value: command.value, confirmed: command.confirmed, cancelled: command.cancelled })}` });
    if (pending.newSession) for (const query of blockedQueries.splice(0)) handle(query);
    return;
  }
  // A runtime replacement can hold inspection until its extension hook finishes.
  if (['get_state', 'get_entries'].includes(command.type) && [...pendingDialogs.values()].some(pending => pending.newSession)) {
    blockedQueries.push(command);
    return;
  }
  if (seenIds.has(command.id)) { send(response(command, undefined, 'Duplicate child command ID')); return; }
  seenIds.add(command.id);
  switch (command.type) {
    case 'get_state':
      if (failStateCount > 0) { failStateCount--; send(response(command, undefined, 'Fixture get_state failure')); break; }
      if (switchAfterStates > 0 && --switchAfterStates === 0) newSession(true);
      send(response(command, state()));
      break;
    case 'get_entries': {
      if (failEntriesCount > 0) { failEntriesCount--; send(response(command, undefined, 'Fixture get_entries failure')); break; }
      const index = command.since === undefined ? -1 : entries.findIndex(entry => entry.id === command.since);
      if (command.since !== undefined && index < 0) { send(response(command, undefined, 'Unknown entry cursor')); break; }
      const result = response(command, { entries: entries.slice(index + 1), leafId: entries.at(-1)?.id ?? null });
      if (boundaryArmed) {
        boundaryArmed = false;
        const message = assistant('boundary complete', Date.now(), 'stop');
        append(message);
        // One write is essential: following events are parsed before Promise continuations run.
        send(result, { type: 'agent_start' }, { type: 'message_start', message: { ...message, content: [], stopReason: 'pending' } },
          delta('boundary complete'), { type: 'message_end', message },
          { type: 'agent_end', messages: [message], willRetry: false }, { type: 'agent_settled' });
      } else send(result);
      break;
    }
    case 'get_messages': send(response(command, { messages: entries.filter(entry => entry.type === 'message').map(entry => entry.message) })); break;
    case 'get_last_assistant_text': send(response(command, { text: entries.filter(entry => entry.message?.role === 'assistant').at(-1)?.message.content[0]?.text ?? null })); break;
    case 'get_commands': send(response(command, { commands: ['dialog', 'confirm', 'select', 'editor', 'timeout',
      'fail-next-state', 'seed-live', 'switch-on-snapshot', 'switch-session'].map(name => ({ name, source: 'extension' })) })); break;
    case 'prompt': prompt(command); break;
    case 'set_session_name': sessionName = command.name; send(response(command, {})); break;
    case 'switch_session': sessionFile = command.sessionPath; openSession(); streaming = false; send(response(command, { cancelled: false })); break;
    case 'new_session':
      if (args.includes('--fixture-new-session-dialog')) {
        const id = `fixture-dialog-${++dialogNumber}`;
        pendingDialogs.set(id, { command, newSession: true });
        send({ type: 'extension_ui_request', id, method: 'confirm', title: 'New session hook', message: 'Switch sessions?' });
      } else { newSession(); send(response(command, { cancelled: false })); }
      break;
    case 'abort': streaming = false; send({ type: 'agent_settled' }, response(command, {})); break;
    case 'bash': later(180, () => send(response(command, { output: command.command, exitCode: 0, cancelled: false, truncated: false }))); break;
    default: send(response(command, undefined, `Unsupported fixture command: ${command.type}`));
  }
}
const decoder = new StringDecoder('utf8');
let buffer = '';
const consume = chunk => {
  buffer += decoder.write(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { send({ type: 'response', command: 'parse', success: false, error: String(error) }); }
  }
};
const startDelay = Number(option('--fixture-start-delay', '0'));
if (startDelay > 0) {
  send({ type: 'extension_ui_request', id: 'fixture-startup-status', method: 'setStatus', statusKey: 'startup', statusText: 'Starting fixture' });
  later(startDelay, () => process.stdin.on('data', consume));
} else process.stdin.on('data', consume);
process.stdin.on('end', () => { for (const timer of timers) clearTimeout(timer); process.exit(0); });
