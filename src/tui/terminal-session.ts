import { basename } from 'node:path';
import { getSelectListTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { getCellDimensions, ProcessTerminal, type Terminal } from '@earendil-works/pi-tui';
import { PiScreen } from './pi-screen.js';
import { toKittyInput } from './kitty-keys.js';
import { loadLocalEditorFactory } from './local-editor.js';
import type { SlotAttachment } from '../protocol/methods.js';
import type { TerminalAnswers } from '../protocol/companion.js';
import { errorText, type RemoteConnection, type RemoteEvent, type SlotInfo } from '../protocol/types.js';
import { daemonStatus, formatDuration, Pinger, type DaemonState } from './host-status.js';
import { editLocally, readLocalClipboard } from './local-input.js';
import { loadLocalTheme, readPiThemeSetting, resolveThemeSelection, terminalAppearance } from './local-theme.js';
import { slotStatusLines } from './host-status.js';
import { readPresentationConfig } from '../config/presentation.js';
import { detachMessage, stoppedMessage } from './session-labels.js';
import { paint } from './table.js';

export interface TerminalSessionOptions {
  /** Display name of the machine Pi runs on, for the status panel. */
  host?: string;
  presentationConfig?: string;
  presentationPaths?: string[];
  /** Theme setting to use instead of Pi's local setting. */
  theme?: string;
  /** False: do not pass Pi's bell to the terminal. Defaults to the config's `bell`, then true. */
  bell?: boolean;
  /** Replace in tests. */
  terminal?: Terminal;
}

const SAMPLES = 20;

/**
 * Shows a slot: Pi's own interface, rendered on the remote, with local editing and
 * scrolling, in this process's terminal. The phone's counterpart is src/web/client/session-view.ts.
 * Returns when the user detaches or Pi stops, after printing the detach or stop message.
 */
export async function runTerminalSession(connection: RemoteConnection, slot: SlotInfo, options: TerminalSessionOptions = {}): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const slotId = slot.id;
  const host = options.host ?? 'local';
  let finish!: (outcome: 'detached' | 'stopped' | Error) => void;
  const finished = new Promise<'detached' | 'stopped' | Error>(resolve => { finish = resolve; });
  const local: { theme?: Theme; factory?: Awaited<ReturnType<typeof loadLocalEditorFactory>>; answers: TerminalAnswers; bell: boolean } = { answers: {}, bell: options.bell ?? true };
  let connected = true, connectedAt = Date.now(), reconnects = 0, notice: ReturnType<typeof setTimeout> | undefined;
  const samples: number[] = [];
  let daemon: DaemonState = 'loading';
  let slotInfo = slot;
  const pinger = new Pinger(connection);

  const client: PiScreen = new PiScreen(terminal, {
    send: data => { void connection.request('input', { slotId, data }).catch(() => {}); },
    resize: (columns, rows) => {
      void connection.request('resize', { slotId, columns, rows, answers: local.answers }).catch(() => {});
    },
  }, {
    onQuit: () => finish('detached'),
    onDetach: () => finish('detached'),
    get editorFactory() { return local.factory; },
    theme: () => local.theme,
    editorTheme: () => ({ borderColor: text => local.theme?.fg('borderMuted', text) ?? text, selectList: getSelectListTheme() }),
    encodeKey: data => toKittyInput(data),
    onTerminalOutput: data => { if (data !== '\x07' || local.bell) terminal.write(data); },
    notify: message => notify(message),
    editExternally: async text => {
      client.tui.stop();
      try { return await editLocally(text); }
      finally { client.tui.start(); client.tui.requestRender(true); }
    },
    pasteClipboard: async () => {
      const { attachments, text } = await readLocalClipboard();
      if (!attachments.length) return text;
      // Copied files and images go to the machine Pi runs on; Pi gets their paths there.
      const paths: string[] = [];
      for (const attachment of attachments) {
        const name = attachment.image ? `clipboard.${attachment.image.mimeType.split('/')[1] ?? 'png'}` : basename(attachment.path);
        const data = attachment.image?.data ?? Buffer.from(attachment.text ?? '', 'utf8').toString('base64');
        paths.push((await connection.request('upload', { slotId, name, data })).path);
      }
      return paths.join(' ');
    },
    status: {
      lines: () => slotStatusLines({
        host, connected, samples, daemon,
        connection: connected ? `connected ${formatDuration((Date.now() - connectedAt) / 1000)}${reconnects ? ` · ${reconnects} reconnect${reconnects === 1 ? '' : 's'}` : ''}` : undefined,
        slot: [slotInfo.number === undefined ? slotId.slice(0, 8) : `#${slotInfo.number}`, slotInfo.status].join(' · '),
        session: client.session, editor: client.editorLocal ? 'local' : 'remote', editorKind: client.editorKind,
        unconfirmedKeys: client.unconfirmedKeys, layoutKnown: client.layoutKnown,
        messages: client.traffic.messages, bytes: client.traffic.bytes,
      }, paint(true)),
      sample: async () => {
        if (!connected) return;
        try { samples.push(await pinger.ping()); if (samples.length > SAMPLES) samples.shift(); } catch { /* No new sample. */ }
        try { daemon = await daemonStatus(connection); } catch (error) { daemon = { error: errorText(error) }; }
        try { slotInfo = (await connection.request('list')).find(info => info.id === slotId) ?? slotInfo; } catch { /* Keep the last. */ }
      },
    },
  });
  const notify = (message: string) => {
    client.setBanner(message);
    clearTimeout(notice);
    notice = setTimeout(() => { if (connected) client.setBanner(undefined); }, 5000);
    notice.unref();
  };

  let seq = -1;
  const apply = (attachment: SlotAttachment) => {
    seq = attachment.seq;
    slotInfo = attachment.slot;
    for (const message of attachment.messages) client.receive(message, JSON.stringify(message).length);
  };
  const subscriptions = [
    connection.onDisconnect(error => {
      connected = false;
      if (!connection.reconnecting) { finish(error); return; }
      client.setBanner(`Disconnected: ${error.message} Reconnecting… Remote work continues; typing waits.`);
    }),
    connection.onRetry?.(retry => client.setBanner(`Reconnecting (attempt ${retry.attempt}): ${retry.error.message}`)) ?? (() => {}),
    connection.onReconnect?.(attachment => {
      connected = true; connectedAt = Date.now(); reconnects++;
      client.reset();
      apply(attachment);
      client.setBanner(undefined);
    }) ?? (() => {}),
  ];

  client.start();
  try {
    // Pi draws with the local terminal's colors, cell size and appearance.
    const colors = await client.tui.queryTerminalColors({ timeoutMs: 300 }).catch(() => ({}));
    const cell = getCellDimensions();
    local.answers = { ...colors, ...(cell ? { cell: { width: cell.widthPx, height: cell.heightPx } } : {}) };
    const setting = options.theme ?? await readPiThemeSetting();
    local.theme = await loadLocalTheme(setting ? resolveThemeSelection(setting, terminalAppearance(colors)) : undefined);
    const config = await readPresentationConfig(options.presentationConfig, options.presentationPaths);
    local.bell = options.bell ?? config.bell ?? true;
    local.factory = await loadLocalEditorFactory(config.extensions, local.theme, message => notify(`Local editor extension failed: ${message}`));

    const attachment = await connection.request('attach', { slotId, columns: terminal.columns, rows: terminal.rows, answers: local.answers });
    apply(attachment);
    subscriptions.push(connection.onEvent((event: RemoteEvent) => {
      if (event.slotId !== slotId || event.seq <= seq) return;
      seq = event.seq;
      const record = event.event;
      if (record.type === 'screen') client.receive(record.message, JSON.stringify(record.message).length);
      else if (record.type === 'remote_slot_exit') finish('stopped');
      else if (record.type === 'remote_warning') notify(String(record.error));
    }));
    const outcome = await finished;
    client.stop();
    if (outcome instanceof Error) throw outcome;
    const number = slotInfo.number ?? slot.number;
    process.stdout.write(`${outcome === 'stopped' ? stoppedMessage(slotId, number) : detachMessage(slotId, number)}\n`);
  } catch (error) {
    client.stop();
    throw error;
  } finally {
    clearTimeout(notice);
    for (const unsubscribe of subscriptions) unsubscribe();
  }
}
