#!/usr/bin/env node
// Deterministic stand-in for interactive Pi in a slot. It plays both Pi and the
// companion: it reads keys from its terminal and reports to the companion socket. No SDK,
// credentials, or network access.
//
// Environment:
//   PI_FIXTURE_VERSION_FILE  version to print for --version (default 1.4.0)
//   PI_FIXTURE_LAUNCH_LOG    append {pid, cwd, args, env} per launch
//   PI_FIXTURE_EXIT_FILE     when it exists at startup, exit 23
//   PI_FIXTURE_PROMPT_GATE   while this file exists, prompts stay running (busy)
//   PI_FIXTURE_SLOW_START    milliseconds before reporting the session
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
if (args.includes('--version')) {
  const file = process.env.PI_FIXTURE_VERSION_FILE;
  process.stdout.write(`${file ? readFileSync(file, 'utf8').trim() : '1.4.0'}\n`);
  process.exit(0);
}
if (option('--tui-mode') !== 'regular') throw new Error('Fixture requires --tui-mode regular');
if (process.env.PI_FIXTURE_LAUNCH_LOG) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PI_REMOTE_SESSION')));
  appendFileSync(process.env.PI_FIXTURE_LAUNCH_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, env })}\n`);
}
if (process.env.PI_FIXTURE_EXIT_FILE && existsSync(process.env.PI_FIXTURE_EXIT_FILE)) {
  process.stderr.write('fixture startup failed\n');
  process.exit(23);
}

const sessionDir = resolve(option('--session-dir', join(process.cwd(), '.fixture-sessions')));
let sessionFile = option('--session') ? resolve(option('--session')) : join(sessionDir, `${randomUUID()}.jsonl`);
const entries = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let sessionId = entries[0]?.id ?? randomUUID();
const save = () => {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
};
if (!entries.length) entries.push({ type: 'session', id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() });

const socket = createConnection(process.env.PI_REMOTE_COMPANION_SOCKET);
const send = message => socket.write(`${JSON.stringify(message)}\n`);
const transcript = () => entries.filter(entry => entry.type === 'message').map(entry => `${entry.role}: ${entry.text}`);
let draft = '';
const frame = (reset = false) => send({
  type: 'frame', width: process.stdout.columns ?? 80, layout: 'known', reset, editorFocused: true, dropdownRows: 0, hardwareCursor: false,
  sections: { 0: { start: 0, remove: Number.MAX_SAFE_INTEGER, insert: transcript() }, 4: { start: 0, remove: Number.MAX_SAFE_INTEGER, insert: ['──', `> ${draft}`, '──'] } },
});
const session = () => send({
  type: 'session', hostname: hostname(), pid: process.pid, piVersion: '1.4.0', cwd: process.cwd(), sessionId, sessionFile,
  entryCount: entries.length - 1,
  remote: process.env.PI_REMOTE_SESSION === '1' ? { host: process.env.PI_REMOTE_SESSION_HOST, slotId: process.env.PI_REMOTE_SESSION_SLOT } : undefined,
});
const activity = event => send({ type: 'activity', event });

let running = Promise.resolve();
function prompt(text) {
  running = running.then(async () => {
    activity({ type: 'agent_start' });
    entries.push({ type: 'message', role: 'user', text });
    frame();
    while (process.env.PI_FIXTURE_PROMPT_GATE && existsSync(process.env.PI_FIXTURE_PROMPT_GATE)) await new Promise(r => setTimeout(r, 20));
    entries.push({ type: 'message', role: 'assistant', text: `echo: ${text}` });
    save();
    activity({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
    frame();
    session();
    activity({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] });
    activity({ type: 'agent_settled', aborted: false });
  });
}

let control = '';
socket.setEncoding('utf8');
socket.on('data', chunk => {
  control += chunk;
  let end;
  while ((end = control.indexOf('\n')) !== -1) {
    const message = JSON.parse(control.slice(0, end)); control = control.slice(end + 1);
    if (message.type === 'prompt') prompt(message.text);
  }
});
socket.on('connect', () => {
  send({ type: 'editorInstalled', editor: 'default', bindings: {} });
  frame(true);
  setTimeout(session, Number(process.env.PI_FIXTURE_SLOW_START ?? 0));
});

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  // Barriers and other APC messages are not text.
  const text = data.replace(/\x1b_[^\x1b]*\x1b\\/g, '');
  for (const character of text) {
    if (character === '\r') { const value = draft; draft = ''; if (value) prompt(value); }
    else if (character === '\x7f') draft = draft.slice(0, -1);
    else if (character >= ' ') draft += character;
  }
  frame();
});
process.stdout.on('resize', () => frame());
process.on('SIGTERM', () => { save(); process.exit(0); });
setInterval(() => {}, 1 << 30);
