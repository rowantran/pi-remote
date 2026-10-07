/**
 * Make an explicitly diagnostic RemoteTui snapshot showing exactly the entries
 * stock SessionManager.buildContextEntries selects after compaction. Preserve
 * all source entries for footer totals; rewire only the displayed parent path.
 * Never mutate the source file or a live session. Output is private, new-only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Snapshot } from '../src/protocol.js';
import { activeBranch, transcriptMessages } from '../src/view.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  if (!values.input || !values.output) throw new Error('Use --input FILE --output NEW_FILE');
  const text = await readFile(values.input, 'utf8');
  const source: Snapshot = JSON.parse(text);
  const temp = await mkdtemp(join(tmpdir(), 'pi-context-scroll-'));
  await chmod(temp, 0o700);
  try {
    const { SessionManager, CURRENT_SESSION_VERSION } = await import('@earendil-works/pi-coding-agent');
    const history = join(temp, 'history.jsonl');
    const header = { type: 'session', version: CURRENT_SESSION_VERSION,
      id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-01-01T00:00:00.000Z', cwd: temp };
    await writeFile(history, [header, ...source.entries].map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    const manager = SessionManager.open(history, temp, temp);
    if (source.leafId) manager.branch(source.leafId); else manager.resetLeaf();
    const selected = manager.buildContextEntries();
    const projected = structuredClone(source);
    const byId = new Map(projected.entries.map(entry => [entry.id, entry]));
    let previous: string | null = null;
    for (const entry of selected) {
      assert.ok(byId.has(entry.id), 'Context entry must exist in the saved snapshot');
      byId.get(entry.id)!.parentId = previous;
      previous = entry.id;
    }
    projected.leafId = previous;
    assert.deepEqual(activeBranch(projected.entries, projected.leafId).map(entry => entry.id), selected.map(entry => entry.id));
    assert.equal(projected.entries.length, source.entries.length);
    for (let i = 0; i < projected.entries.length; i++) {
      const { parentId: _a, ...a } = projected.entries[i];
      const { parentId: _b, ...b } = source.entries[i];
      assert.deepEqual(a, b, 'Only display parent links may change');
    }
    const output = JSON.stringify(projected) + '\n';
    const file = await open(values.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(output); } finally { await file.close(); }
    assert.equal(hash(await readFile(values.input, 'utf8')), hash(text));
    console.log(JSON.stringify({ diagnostic: true, sourceSha256: hash(text), outputSha256: hash(output),
      sourceEntriesRetained: projected.entries.length, sourceTranscriptRecords: transcriptMessages(source).length,
      selectedContextEntries: selected.length, projectedTranscriptRecords: transcriptMessages(projected).length,
      contextMessages: manager.buildSessionContext().messages.length,
      note: 'Only the diagnostic display path changed. Full source entries and footer cost data retained.' }, null, 2));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Context projection failed; check input/output paths (details withheld).'); process.exitCode = 1; });
