/**
 * Test harness for stock-screen.test.ts: runs stock Pi in a PTY with the companion and shows
 * it through PiScreen, in one process and without a daemon.
 *
 *   node --import tsx test/tui/harness.ts --pi PI --cwd DIR [-- PI_ARGS...]
 */
import { fileURLToPath } from 'node:url';
import { getSelectListTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { PiTerminal } from '../../src/daemon/pi-terminal.js';
import { PiScreen } from '../../src/tui/pi-screen.js';
import { loadLocalTheme, readPiThemeSetting, resolveThemeSelection, terminalAppearance } from '../../src/tui/local-theme.js';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split === -1 ? argv : argv.slice(0, split);
const option = (name: string) => { const index = own.indexOf(name); return index === -1 ? undefined : own[index + 1]; };
const executable = option('--pi') ?? 'pi';
const cwd = option('--cwd') ?? process.cwd();

const terminal = new ProcessTerminal();
const local: { theme?: Theme } = {};
let pi: PiTerminal | undefined;
const ui = new PiScreen(terminal, { send: data => pi?.write(data), resize: (columns, rows) => pi?.resize(columns, rows) }, {
  onQuit: () => { ui.stop(); pi?.stop(); process.exit(0); },
  theme: () => local.theme,
  editorTheme: () => ({ borderColor: text => local.theme?.fg('borderMuted', text) ?? text, selectList: getSelectListTheme() }),
});
ui.start();
const colors = await ui.tui.queryTerminalColors({ timeoutMs: 300 }).catch(() => ({}));
const setting = await readPiThemeSetting();
local.theme = await loadLocalTheme(setting ? resolveThemeSelection(setting, terminalAppearance(colors)) : undefined);
pi = new PiTerminal({
  executable, args: split === -1 ? [] : argv.slice(split + 1), cwd, columns: terminal.columns, rows: terminal.rows,
  companionPath: fileURLToPath(new URL('../../src/companion/index.ts', import.meta.url)),
  answers: { kittyFlags: terminal.kittyProtocolActive ? 7 : undefined, ...colors },
});
pi.onMessage = message => ui.receive(message);
pi.onExit = code => { ui.stop(); process.exit(code); };
await pi.start();
