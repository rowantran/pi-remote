import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RecordValue } from '../protocol/types.js';

/** customType of the context message that starts every side conversation. */
export const SIDE_BOUNDARY_TYPE = 'side-boundary';

/** Modeled on Codex's /side boundary prompt. Codex also limits side chats to non-mutating
 * work; this text does not, because a Pi side conversation is for a separate task. */
export const SIDE_BOUNDARY_TEXT = `Side conversation boundary.

This is a side conversation forked from a main conversation. Everything before this message is inherited history from the main conversation. Use it only as reference context. It is not your current task.

Do not continue, retry, or complete any task, plan, tool call, or request from before this message. The main conversation's agent owns that work and can still be doing it. Only user messages after this message are instructions for this side conversation. If there is no user message after this one yet, wait for one.

Use the inherited context to help with the separate task that the user gives you here. The main conversation's agent can be working in the same files at the same time. Do not undo, overwrite, or commit its work unless the user asks for that in this side conversation.`;

/** Write a new side session file, as stock \`pi --fork\` does, and append the boundary message.
 *
 * Pi has no RPC command that adds a context message without a model turn, so the daemon
 * writes the file and starts Pi with --session. The source file is only read: Pi's own fork
 * appends a newline to a source file that ends in a partial line, and a busy parent can be
 * writing that line. Malformed lines are skipped, as Pi does. Pi uses the last entry in the
 * file as the leaf, so the boundary follows the history that a stock fork would continue. */
export async function forkSideSession(source: string, cwd: string, sessionDir: string): Promise<string> {
  const entries: RecordValue[] = [];
  for (const line of (await readFile(source, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* A busy parent can be mid-append. */ }
  }
  const [header, ...body] = entries;
  if (header?.type !== 'session' || typeof header.id !== 'string') throw new Error('parent session file has no session header');
  const ids = new Set(body.map(entry => entry?.id));
  let id: string;
  do { id = randomUUID().slice(0, 8); } while (ids.has(id));
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const file = join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
  const boundary = { type: 'custom_message', customType: SIDE_BOUNDARY_TYPE, content: SIDE_BOUNDARY_TEXT, display: true,
    id, parentId: body.at(-1)?.id ?? null, timestamp };
  const records = [{ type: 'session', version: header.version, id: sessionId, timestamp, cwd: resolve(cwd), parentSession: source }, ...body, boundary];
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx' });
  return file;
}
