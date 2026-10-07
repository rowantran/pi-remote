import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initTheme, type ExtensionAPI, type MessageRenderer } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import rowanUI from '../examples/rowan-ui.js';
import { PresentationHost } from '../src/presentation.js';
import type { RecordValue, Snapshot } from '../src/protocol.js';
import { Transcript } from '../src/transcript.js';
import { RemoteView } from '../src/view.js';

const adapter = fileURLToPath(new URL('../examples/rowan-ui.ts', import.meta.url));
const integrationRepo = process.env.PI_REMOTE_RENDERER_REPO;

async function withRendererRepo(root: string, run: () => Promise<void>) {
  const previous = process.env.PI_REMOTE_RENDERER_REPO;
  process.env.PI_REMOTE_RENDERER_REPO = root;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.PI_REMOTE_RENDERER_REPO;
    else process.env.PI_REMOTE_RENDERER_REPO = previous;
  }
}

async function withFakeRendererRepo(run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rowan-ui-renderers-'));
  const files: Record<string, string> = {
    'codex-footer.ts': 'export default function() {}',
    'prompt-caret.ts': 'export default function() {}',
    'assistant-background.ts': 'export default function() {}',
    'compact-tools.ts': `
      export default function() {}
      export function withCompactToolRendering(pi) { return pi; }
    `,
    'codemode/render.ts': 'export function compactCodemodeTool() { return {}; }',
    // The adapter requires the original factory; timing lifecycle coverage lives in rowan-ui.test.ts.
    'worked-for.ts': `
      import { Text } from '@earendil-works/pi-tui';
      export default function workedFor(pi) {
        pi.registerEntryRenderer('worked-for', (entry, _options, theme) =>
          new Text(theme.fg('dim', 'Worked for ' + entry.data.elapsedSeconds + 's'), 1, 0));
      }
    `,
    // Bell behavior is covered in rowan-ui.test.ts.
    'emit-terminal-bel.ts': 'export default function() {}',
    // Any accidental worker or executor import must fail the adapter load.
    'background.ts': 'throw new Error("BACKGROUND WORKER FACTORY MUST NOT LOAD");',
    'background/executors.ts': 'throw new Error("BACKGROUND EXECUTORS MUST NOT LOAD");',
    'background/render.ts': `
      export function renderBackgroundMessage(message, { expanded, outputPad }, theme) {
        const { id, state } = message.details;
        return {
          invalidate() {},
          // Deliberately ignore width to exercise the host's ANSI/wide-character guard.
          render() {
            const lines = [theme.fg('success',
              'shared:' + id + ':' + state + ':' + (expanded ? 'expanded' : 'collapsed')
              + ':pad=' + outputPad + ' 世界 '.repeat(40))];
            if (expanded) lines.push('shared details:' + id);
            return lines;
          },
        };
      }
    `,
  };
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    await withRendererRepo(root, run);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function backgroundMessage(): RecordValue {
  return {
    role: 'custom', customType: 'background', display: true, timestamp: 1700000000000,
    content: 'RAW FALLBACK BODY MUST NOT APPEAR\n' + 'large worker output\n'.repeat(100),
    details: { id: 'task-1', kind: 'shell', event: 'completion', state: 'completed', exitCode: 0 },
  };
}

function snapshot(message: RecordValue, persisted: boolean): Snapshot {
  const { role: _role, timestamp, ...stored } = message;
  return {
    slot: { id: 'slot', cwd: '/remote/work', status: 'running', createdAt: '', clients: 1 },
    state: {},
    entries: persisted ? [{ ...stored, type: 'custom_message', id: 'notice', parentId: null,
      timestamp: new Date(timestamp).toISOString() }] : [],
    leafId: persisted ? 'notice' : null,
    live: { busy: false, compacting: false, messages: persisted ? [] : [message], tools: {}, steering: [], followUp: [] },
    ui: [], seq: 1,
  };
}

function setup(message = backgroundMessage()) {
  initTheme('dark', false);
  const view = new RemoteView(snapshot(message, false));
  const notices: string[] = [];
  const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } } as TUI;
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui,
    notify: message => notices.push(message), invalidate() {} });
  const transcript = new Transcript(view, tui, () => host);
  return { view, host, transcript, notices };
}

const plain = (lines: string[]) => stripTerminalSequences(lines.join('\n'));

test('Rowan adapter registers the named background renderer without loading workers or executors', async () => {
  await withFakeRendererRepo(async () => {
    const messages = new Map<string, MessageRenderer>();
    const pi = {
      registerMessageRenderer: (name: string, renderer: MessageRenderer) => messages.set(name, renderer),
      registerToolRenderer() {}, registerEntryRenderer() {}, registerMarkdownTransformer() {},
      registerTool() { assert.fail('The presentation adapter must not register an executable tool'); },
    } as unknown as ExtensionAPI;
    await rowanUI(pi);
    assert.deepEqual([...messages.keys()], ['background']);
    assert.equal(typeof messages.get('background'), 'function');
    assert.equal(messages.get('background')!.name, 'renderBackgroundMessage');
  });
});

test('Rowan adapter renders live and persisted background notices compactly with width clamping and no fallback', async () => {
  await withFakeRendererRepo(async () => {
    const { view, host, transcript, notices } = setup();
    try {
      await host.load([adapter]); await host.start();
      assert.equal(typeof host.messageRenderer('background'), 'function');
      const live = new Map<string, string[]>();
      for (const persisted of [false, true]) {
        if (persisted) {
          view.replace(snapshot(backgroundMessage(), true));
          host.update(view.snapshot); transcript.changed();
        }
        for (const expanded of [false, true]) {
          transcript.expanded = expanded;
          for (const width of [0, 1, 2, 8, 40, 80]) {
            const lines = transcript.render(width);
            assert.ok(lines.every(line => visibleWidth(line) <= width), `width=${width}, persisted=${persisted}`);
            assert.doesNotMatch(plain(lines), /RAW FALLBACK|large worker output|\[background\]|renderer not loaded/);
            if (width === 80) {
              assert.match(plain(lines), new RegExp(`shared:task-1:completed:${expanded ? 'expanded' : 'collapsed'}:pad=1`));
              assert.equal(plain(lines).includes('shared details:task-1'), expanded);
              assert.ok(lines.length <= (expanded ? 3 : 2), 'Keep notice output compact');
            }
            const key = `${expanded}:${width}`;
            if (persisted) assert.deepEqual(lines, live.get(key), 'Replay must use the same renderer as live notices');
            else live.set(key, lines);
          }
        }
      }
      assert.deepEqual(notices, []);
    } finally { transcript.reset(); await host.shutdown(); }
  });
});

test('explicit renderer repository renders real background completion notices compactly', {
  skip: !integrationRepo,
}, async t => {
  await withRendererRepo(integrationRepo!, async () => {
    const message = backgroundMessage();
    message.content = 'Background shell task-1 (Adapter test) completed with exit code 0 after 1s.\n'
      + 'Last output:\n' + 'retained result line\n'.repeat(60) + 'Full log: /remote/task-1.log';
    const { view, host, transcript, notices } = setup(message);
    try {
      await host.load([adapter]); await host.start();
      assert.equal(typeof host.messageRenderer('background'), 'function');
      const live = transcript.render(120);
      const rows = plain(live).split('\n').map(line => line.trim()).filter(Boolean);
      assert.equal(rows.length, 7, 'One heading, five preview rows, and one hidden-line count');
      assert.match(rows[0], /^● Background shell task-1 \(Adapter test\) completed/);
      assert.deepEqual(rows.slice(1, 6), ['Last output:', ...Array(4).fill('retained result line')]);
      assert.equal(rows[6], '(+ 57 lines)');
      assert.doesNotMatch(plain(live), /\[background\]|renderer not loaded/);
      t.diagnostic(`Compact completion notice:\n${plain(live).trim()}`);
      view.replace(snapshot(message, true)); host.update(view.snapshot); transcript.changed();
      assert.deepEqual(transcript.render(120), live);
      for (const expanded of [false, true]) {
        transcript.expanded = expanded;
        for (const width of [1, 8, 40, 80, 120]) assert.ok(transcript.render(width).every(line => visibleWidth(line) <= width));
      }
      assert.deepEqual(notices, []);
    } finally { transcript.reset(); await host.shutdown(); }
  });
});
