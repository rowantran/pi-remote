import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { crop, sideBySide, strip } from './golden/terminal.js';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(`Real stock Pi 1.0.4 versus pi-remote terminal golden comparison.
Usage: node --import tsx test/golden-transcript.ts [options]
  --remote-bin PATH  CLI under test (default: this worktree's bin/pi-remote)
  --pi-bin PATH      Stock Pi 1.0.4 CLI (default: pi from PATH)
  --widths 80,120    Terminal column matrix
  --themes dark,light  Theme matrix
  --rows 160         Tall terminal exposes the entire expanded transcript
  --output PATH      New or empty artifact directory (default: isolated temp dir)
  --rowan            Explicitly load compact-tools, assistant-background, prompt-caret
  --rowan-root PATH  Unmodified local presentation factory directory
Exit: 0 = all transcript styles match; 1 = differences; 2 = harness/setup failure.`);
  process.exit(0);
}
const option = (key: string, fallback?: string) => { const i = argv.indexOf(key); return i < 0 ? fallback : argv[i + 1]; };
const remoteBin = resolve(option('--remote-bin', join(repo, 'bin/pi-remote'))!);
const stockBin = option('--pi-bin', 'pi')!;
const widths = option('--widths', '80,120')!.split(',').map(Number);
const themes = option('--themes', 'dark,light')!.split(',');
const rows = Number(option('--rows', '160'));
const root = option('--output') ? resolve(option('--output')!) : await mkdtemp(join(tmpdir(), 'pi-remote-golden.'));
await mkdir(root, { recursive: true });
assert.equal((await readdir(root)).length, 0, `Artifact directory must be empty to prevent stale gate files: ${root}`);
assert.ok(widths.every(width => Number.isInteger(width) && width >= 40), 'Widths must be integers >=40');
assert.ok(Number.isInteger(rows) && rows >= 100, 'Rows must be >=100 to capture the full expanded transcript');
const tmuxName = `pi-remote-golden-${process.pid}`;
const fixture = join(repo, 'test/golden/fixture-provider.ts');
const tmux = (...args: string[]) => exec('tmux', ['-L', tmuxName, '-f', '/dev/null', ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const shell = (args: string[]) => args.map(quote).join(' ');
const cleanEnv = (home: string, agent: string, gate: string) => ({
  HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: '/bin/bash',
  LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  PI_TRUE_COLOR: '1', PI_HYPERLINKS: '0', PI_IMAGE_PROTOCOL: 'none', GOLDEN_GATE_DIR: gate,
  PI_REMOTE_PI_BIN: stockBin,
});
const envArgs = (env: Record<string, string>) => ['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };
const summary: any[] = [];
const sessions = new Set<string>();
const states = new Set<string>();
const commands: any[] = [];

async function screen(name: string) { return (await tmux('capture-pane', '-p', '-e', '-N', '-t', name)).stdout; }
async function startPane(name: string, command: string[], cwd: string, width: number) {
  await tmux('new-session', '-d', '-s', name, '-x', String(width), '-y', String(rows), '-c', cwd, `exec ${shell(command)}`,
    ';', 'set-window-option', '-t', name, 'remain-on-exit', 'on');
  sessions.add(name);
  await tmux('set-option', '-t', name, 'status', 'off');
  await tmux('set-window-option', '-t', name, 'window-size', 'manual');
  await tmux('resize-window', '-t', name, '-x', String(width), '-y', String(rows));
  assert.equal((await tmux('display-message', '-p', '-t', name, '#{pane_width}x#{pane_height}')).stdout.trim(), `${width}x${rows}`, 'Both terminal panes must have the requested dimensions');
}
async function persistedHistory(directory: string) {
  const files = (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.jsonl'));
  assert.equal(files.length, 1, `Expected exactly one isolated session in ${directory}`);
  const path = join(directory, files[0]);
  const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries[0].type, 'session', 'Session JSONL must start with its public header');
  const messages = entries.filter(entry => entry.type === 'message');
  assert.ok(messages.some(entry => JSON.stringify(entry.message).includes('GOLDEN_SECOND_DONE')), 'Persisted history must contain the completed second response');
  return { path, sessionId: entries[0].id, messages };
}
async function until(check: () => Promise<boolean>, description: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await delay(100); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function send(name: string, text: string) {
  await tmux('send-keys', '-t', name, '-l', text); await tmux('send-keys', '-t', name, 'Enter');
}
async function diff(a: string, b: string, out: string) {
  try { const result = await exec('diff', ['-u', a, b], { maxBuffer: 8 * 1024 * 1024 }); await writeFile(out, result.stdout); }
  catch (error: any) { if (error.code !== 1) throw error; await writeFile(out, error.stdout); }
}
async function compare(names: string[], dir: string, checkpoint: string, width: number) {
  // Providers/tools pause on filesystem gates, so this is a deterministic state, not a timed token race.
  await delay(250);
  const captures = await Promise.all(names.map(screen));
  const stageDir = join(dir, checkpoint); await mkdir(stageDir, { recursive: true });
  for (const [i, capture] of captures.entries()) await writeFile(join(stageDir, `${i ? 'remote' : 'stock'}.screen.ansi`), capture);
  const transcripts = captures.map(capture => crop(capture, rows));
  for (const [i, transcript] of transcripts.entries()) {
    const name = i ? 'remote' : 'stock';
    for (const key of ['ansi', 'text', 'canonical'] as const) await writeFile(join(stageDir, `${name}.${key === 'text' ? 'txt' : key}`), transcript[key]);
  }
  await diff(join(stageDir, 'stock.txt'), join(stageDir, 'remote.txt'), join(stageDir, 'text.diff'));
  await diff(join(stageDir, 'stock.canonical'), join(stageDir, 'remote.canonical'), join(stageDir, 'style.diff'));
  const stockLines = transcripts[0].text.trimEnd().split('\n'), remoteLines = transcripts[1].text.trimEnd().split('\n');
  await writeFile(join(stageDir, 'side-by-side.txt'), sideBySide(transcripts[0].text, transcripts[1].text, width));
  await writeFile(join(stageDir, 'side-by-side.ansi'), sideBySide(transcripts[0].ansi, transcripts[1].ansi, width, true));
  const equal = transcripts[0].canonical === transcripts[1].canonical;
  const textEqual = transcripts[0].text === transcripts[1].text;
  const result = { scenario: dir.split('/').at(-1), checkpoint, equal, textEqual, stockLines: stockLines.length, remoteLines: remoteLines.length, artifacts: stageDir };
  summary.push(result); console.log(`${equal ? 'PASS' : 'DIFF'} ${result.scenario}/${checkpoint} (text ${textEqual ? 'equal' : 'differs'}, ANSI styles ${equal ? 'equal' : 'differ'})`);
}

async function runScenario(width: number, theme: string) {
  const label = `${width}x${rows}-${theme}${argv.includes('--rowan') ? '-rowan' : ''}`;
  const dir = join(root, label), cwd = join(dir, 'workspace'), state = join(dir, 'daemon');
  await mkdir(cwd, { recursive: true }); states.add(state);
  const sides = await Promise.all(['stock', 'remote'].map(async name => {
    const home = join(dir, `${name}-home`), agent = join(home, '.pi/agent'), gate = join(dir, `${name}-gates`);
    await Promise.all([mkdir(agent, { recursive: true }), mkdir(gate, { recursive: true })]);
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme, quietStartup: true, hideThinkingBlock: false, enableSkillCommands: false, compaction: { enabled: false }, retry: { enabled: false }, terminal: { showImages: false } }));
    const env = cleanEnv(home, agent, gate);
    return { name, gate, env };
  }));
  const piArgs = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--extension', fixture, '--model', 'golden-local/transcript', '--thinking', 'medium', '--tools', 'bash', '--tui-mode', 'fullscreen', '--use-theme', theme];
  const stockExtensions: string[] = [], uiExtensions: string[] = [];
  if (argv.includes('--rowan')) {
    const extensionRoot = option('--rowan-root', join(homedir(), '.pi/agent/git/github.com/rowantran/pi-extensions'))!;
    for (const file of ['compact-tools.ts', 'assistant-background.ts', 'prompt-caret.ts']) {
      const path = join(extensionRoot, file); assert.ok(await exists(path), `Missing Rowan presentation extension: ${path}`);
      stockExtensions.push('--extension', path); uiExtensions.push('--ui-extension', path);
    }
  }
  const stockCommand = [...envArgs(sides[0].env), stockBin, ...piArgs, '--session-dir', join(dir, 'stock-sessions'), ...stockExtensions];
  const createCommand = [remoteBin, 'new', '--local', '--state-dir', state, '--cwd', cwd, '--no-attach', '--json', '--', ...piArgs, '--session-dir', join(dir, 'remote-sessions')];
  const created = await exec('env', ['-i', ...Object.entries(sides[1].env).map(([k, v]) => `${k}=${v}`), ...createCommand], { cwd, timeout: 45000, maxBuffer: 1024 * 1024 });
  const slot = JSON.parse(created.stdout);
  const remoteCommand = [...envArgs(sides[1].env), remoteBin, 'attach', '--local', '--state-dir', state, slot.id, '--ui-config', join(dir, 'no-ui-config.json'), '--theme', theme, ...uiExtensions];
  const names = [`stock-${label}`, `remote-${label}`];
  const restoredStockCommand = [...stockCommand, '--continue'];
  commands.push({ scenario: label, stock: stockCommand, create: createCommand, remote: remoteCommand, slot,
    restore: { stock: restoredStockCommand, remote: remoteCommand } });
  await writeFile(join(root, 'commands.json'), JSON.stringify(commands, null, 2));
  for (const [i, command] of [stockCommand, remoteCommand].entries()) await startPane(names[i], command, cwd, width);
  try {
    await until(async () => (await Promise.all(sides.map(side => exists(join(side.gate, 'session-ready'))))).every(Boolean), `${label}: provider startup`);
    await until(async () => (await Promise.all(names.map(screen))).every(s => /[─━]{20}/u.test(strip(s))), `${label}: both editors`);
    await delay(300);
    await Promise.all(names.map(name => send(name, 'GOLDEN_USER literal **not bold**, `not code`, [not a link](x), <tag> & café 世界.')));
    await until(async () => (await Promise.all(sides.map(side => exists(join(side.gate, 'stream-ready'))))).every(Boolean), `${label}: streaming checkpoint`);
    await compare(names, dir, '01-streaming', width);
    await Promise.all(sides.map(side => writeFile(join(side.gate, 'stream-release'), 'release\n')));
    await until(async () => (await Promise.all(sides.map(side => exists(join(side.gate, 'tool-ready'))))).every(Boolean), `${label}: tool checkpoint`);
    await compare(names, dir, '02-tool-streaming', width);
    await Promise.all(sides.map(side => writeFile(join(side.gate, 'tool-release'), 'release\n')));
    await until(async () => (await Promise.all(sides.map(side => exists(join(side.gate, 'settled-ready'))))).every(Boolean), `${label}: settled`);
    await compare(names, dir, '03-tools-collapsed', width);
    await Promise.all(names.map(name => tmux('send-keys', '-t', name, 'C-o')));
    await compare(names, dir, '04-tools-expanded', width);
    await Promise.all(names.map(name => tmux('send-keys', '-t', name, 'C-t')));
    await compare(names, dir, '05-thinking-hidden', width);
    await Promise.all(names.map(name => tmux('send-keys', '-t', name, 'C-t', 'C-o')));
    await compare(names, dir, '06-restored-defaults', width);
    await Promise.all(names.map(name => send(name, "!printf 'GOLDEN_SHELL_DONE\\n'")));
    await until(async () => (await Promise.all(names.map(screen))).every(s => (strip(s).match(/GOLDEN_SHELL_DONE/g) ?? []).length >= 2), `${label}: user bash output`);
    await delay(500);
    await compare(names, dir, '07-user-bash', width);
    await Promise.all(sides.map(side => rm(join(side.gate, 'settled-ready'))));
    await Promise.all(names.map(name => send(name, 'GOLDEN_SECOND_USER **Markdown** plus \\*literal stars\\* and C:\\tmp\\file.')));
    await until(async () => (await Promise.all(sides.map(side => exists(join(side.gate, 'settled-ready'))))).every(Boolean), `${label}: second user prompt settled`);
    await compare(names, dir, '08-second-user', width);

    // Restore only these two persisted histories. Stock restarts; remote detaches
    // and reattaches to the same daemon slot/Pi process without submitting a task.
    const histories = await Promise.all(sides.map(side => persistedHistory(join(dir, `${side.name}-sessions`))));
    const requests = await Promise.all(sides.map(side => readFile(join(side.gate, 'provider-requests.jsonl'), 'utf8')));
    const listSlot = async () => {
      const result = await exec('env', ['-i', ...Object.entries(sides[1].env).map(([k, v]) => `${k}=${v}`), remoteBin, 'ls', '--local', '--state-dir', state, '--json'], { timeout: 15000 });
      return JSON.parse(result.stdout).find((entry: any) => entry.id === slot.id);
    };
    const beforeSlot = await listSlot();
    assert.equal(beforeSlot?.status, 'running');
    assert.ok(Number.isInteger(beforeSlot.pid) && beforeSlot.pid > 1, 'Restoration must track a concrete stock RPC PID');
    await Promise.all(names.map(name => tmux('send-keys', '-t', name, 'C-d')));
    await until(async () => (await Promise.all(names.map(name => tmux('display-message', '-p', '-t', name, '#{pane_dead}')))).every(result => result.stdout.trim() === '1'), `${label}: stock exit and remote detach`, 15000);
    for (const name of names) { await tmux('kill-session', '-t', name); sessions.delete(name); }
    await rm(join(sides[0].gate, 'session-ready'));
    for (const [i, command] of [restoredStockCommand, remoteCommand].entries()) await startPane(names[i], command, cwd, width);
    await until(async () => await exists(join(sides[0].gate, 'session-ready')) && (await Promise.all(names.map(screen))).every(capture => strip(capture).includes('GOLDEN_SECOND_DONE')), `${label}: restored transcript visible`);
    await compare(names, dir, '09-restored-history', width);
    const restored = await Promise.all(sides.map(side => persistedHistory(join(dir, `${side.name}-sessions`))));
    const afterSlot = await listSlot();
    assert.equal(afterSlot?.status, 'running');
    assert.equal(afterSlot.pid, beforeSlot.pid, 'Detaching must preserve the same stock RPC process');
    for (let i = 0; i < sides.length; i++) {
      assert.deepEqual(restored[i], histories[i], `${sides[i].name}: restoring must preserve the exact session file, ID and messages`);
      assert.equal(await readFile(join(sides[i].gate, 'provider-requests.jsonl'), 'utf8'), requests[i], `${sides[i].name}: restoring must not call the provider`);
    }
    await writeFile(join(dir, 'restoration.json'), JSON.stringify({ slotId: slot.id, rpcPid: afterSlot.pid,
      histories: restored.map(history => ({ path: history.path, sessionId: history.sessionId, messageCount: history.messages.length })),
      messagesUnchanged: true, providerRequestsUnchanged: true }, null, 2));
  } finally {
    // Unblock this fixture's Bash children even if capture fails while a tool is paused.
    await Promise.all(sides.flatMap(side => ['stream', 'tool'].map(gate => writeFile(join(side.gate, `${gate}-release`), 'cleanup\n'))));
    for (const name of names) {
      try { await writeFile(join(dir, `${name.startsWith('stock') ? 'stock' : 'remote'}-final.screen.ansi`), await screen(name)); } catch {}
      await tmux('kill-session', '-t', name).catch(() => {}); sessions.delete(name);
    }
    await exec('env', ['-i', ...Object.entries(sides[1].env).map(([k, v]) => `${k}=${v}`), remoteBin, 'kill', '--local', '--state-dir', state, slot.id], { timeout: 20000 }).catch(() => {});
    try { const pid = Number(await readFile(join(state, 'daemon.lock/pid'), 'utf8')); if (pid > 1) process.kill(pid, 'SIGTERM'); } catch {}
    states.delete(state);
  }
}

try {
  const version = (await exec(stockBin, ['--version'], { env: cleanEnv(join(root, 'version-home'), join(root, 'version-agent'), root), timeout: 15000 })).stdout.trim();
  assert.equal(version, '1.0.4', 'Golden comparison must run stock Pi 1.0.4');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version, remoteBin, repo, widths, rows, themes, argv, tmuxName, started: new Date().toISOString() }, null, 2));
  console.log(`Stock Pi ${version}; artifacts: ${root}`);
  for (const theme of themes) for (const width of widths) await runScenario(width, theme);
} catch (error) {
  console.error(error); await writeFile(join(root, 'error.txt'), String(error)); process.exitCode = 2;
} finally {
  for (const name of sessions) await tmux('kill-session', '-t', name).catch(() => {});
  for (const state of states) { try { const pid = Number(await readFile(join(state, 'daemon.lock/pid'), 'utf8')); if (pid > 1) process.kill(pid, 'SIGTERM'); } catch {} }
  await tmux('kill-server').catch(() => {});
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  const differences = summary.filter(row => !row.equal).length;
  if (!process.exitCode && differences) process.exitCode = 1;
  console.log(`${summary.length - differences}/${summary.length} golden transcript checkpoints match; ${differences} differ. Artifacts: ${root}`);
}
