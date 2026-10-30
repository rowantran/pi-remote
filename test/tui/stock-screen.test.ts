/**
 * Screen comparison: stock Pi in fullscreen mode versus the native client showing the same
 * stock Pi (regular mode, with the companion) in the same size of terminal. Both run the
 * pinned Pi CLI from node_modules with an offline fixture provider, in headless terminals.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import xterm from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';
import { ensureSpawnHelper } from '../../src/daemon/pi-terminal.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const piCli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const fixture = join(repo, 'test/golden/fixture-provider.ts');
const COLUMNS = 100, ROWS = 32;

interface Screen { pty: IPty; term: InstanceType<typeof xterm.Terminal>; exited: boolean }

function open(command: string, args: string[], env: Record<string, string>, cwd: string): Screen {
  ensureSpawnHelper();
  const term = new xterm.Terminal({ cols: COLUMNS, rows: ROWS, allowProposedApi: true });
  const pty = spawn(command, args, { name: 'xterm-256color', cols: COLUMNS, rows: ROWS, cwd, env });
  const screen: Screen = { pty, term, exited: false };
  pty.onData(data => term.write(data));
  // The headless terminal answers device queries the way a real terminal would.
  term.onData(data => { if (!screen.exited) pty.write(data); });
  pty.onExit(() => { screen.exited = true; });
  return screen;
}

/** Each row as text plus its colors and attributes, so style differences also count. */
function capture(screen: Screen): string {
  const buffer = screen.term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < screen.term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) { rows.push(''); continue; }
    let styled = '', last = '';
    for (let x = 0; x < screen.term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const style = [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
        cell.isBold(), cell.isItalic(), cell.isDim(), cell.isInverse(), cell.isUnderline()].join(',');
      if (style !== last) { styled += `{${style}}`; last = style; }
      styled += cell.getChars() || ' ';
    }
    rows.push(styled.replace(/(\{[^}]*\})? +$/, ''));
  }
  return rows.join('\n');
}
const text = (screen: Screen) => capture(screen).replace(/\{[^}]*\}/g, '');

async function settle(screens: Screen[], ready: (text: string) => boolean, label: string): Promise<void> {
  let previous = '', stableSince = Date.now();
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const now = screens.map(capture).join('\n=====\n');
    if (now !== previous) { previous = now; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= 700 && screens.every(screen => ready(text(screen)))) return;
  }
  throw new Error(`${label}: screens did not settle\n${screens.map(text).join('\n=====\n')}`);
}

function assertSame(stock: Screen, native: Screen, label: string): void {
  assert.equal(text(native), text(stock), `${label}: text differs`);
  assert.equal(capture(native), capture(stock), `${label}: colors or attributes differ`);
}

test('the native client shows the same screen as stock Pi', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-remote-native-screen-'));
  const screens: Screen[] = [];
  t.after(async () => {
    for (const screen of screens) if (!screen.exited) screen.pty.kill();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const environment = async (name: string) => {
    const home = join(root, `${name}-home`), agent = join(home, '.pi/agent'), gate = join(root, `${name}-gates`);
    await mkdir(agent, { recursive: true }); await mkdir(gate, { recursive: true });
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark', quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } }));
    return {
      HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: '/bin/bash', LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color', COLORTERM: 'truecolor', PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_TRUE_COLOR: '1', PI_HYPERLINKS: '0',
      PI_IMAGE_PROTOCOL: 'none', GOLDEN_GATE_DIR: gate,
    };
  };
  const piArgs = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--no-approve', '--extension', fixture, '--model', 'golden-local/transcript', '--thinking', 'medium', '--tools', 'bash'];
  // The native host starts `pi` itself; point it at the pinned CLI.
  const piBin = join(root, 'pi');
  await writeFile(piBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(piCli)} "$@"\n`);
  await chmod(piBin, 0o755);

  const stock = open(process.execPath, [piCli, ...piArgs, '--tui-mode', 'fullscreen', '--session-dir', join(root, 'stock-sessions')],
    await environment('stock'), workspace);
  const native = open(process.execPath, ['--import', import.meta.resolve('tsx'), join(repo, 'test/tui/harness.ts'),
    '--pi', piBin, '--cwd', workspace, '--', ...piArgs, '--session-dir', join(root, 'native-sessions')],
    await environment('native'), workspace);
  screens.push(stock, native);
  const both = (data: string) => { stock.pty.write(data); native.pty.write(data); };

  await settle(screens, screen => screen.includes('transcript'), 'startup');
  assertSame(stock, native, 'startup');

  both('!echo REMOTE_SCREEN_OK'); both('\r');
  await settle(screens, screen => screen.split('REMOTE_SCREEN_OK').length > 2, 'shell command');
  assertSame(stock, native, 'shell command');

  both('draft text');
  await settle(screens, screen => screen.includes('draft text'), 'draft');
  assertSame(stock, native, 'draft');

  both('\x15'); both('/model'); both('\r');
  await settle(screens, screen => screen.includes('golden-local'), 'model picker');
  assertSame(stock, native, 'model picker');
});
