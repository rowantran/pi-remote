import type { RecordValue, Snapshot } from './types.js';

/** A display copy only: never mutate Pi messages, cached history, or user-defined tool data. */
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapUnchanged<T>(values: T[], project: (value: T) => T): T[] {
  const next = values.map(project);
  return next.some((value, index) => value !== values[index]) ? next : values;
}

function fields<T extends RecordValue>(value: T, keys: readonly string[], project: (value: unknown) => unknown): T {
  const patch: RecordValue = {};
  for (const key of keys) {
    const next = project(value[key]);
    if (next !== value[key]) patch[key] = next;
  }
  return Object.keys(patch).length ? { ...value, ...patch } : value;
}

function message(value: unknown): unknown {
  if (!record(value) || value.role !== 'assistant' || !Array.isArray(value.content)) return value;
  const content = mapUnchanged(value.content, block => {
    if (!record(block)) return block;
    const key = block.type === 'thinking' ? 'thinkingSignature' : block.type === 'text' ? 'textSignature' : undefined;
    if (!key || !Object.hasOwn(block, key)) return block;
    const copy = { ...block };
    delete copy[key];
    return copy;
  });
  return content === value.content ? value : { ...value, content };
}

function messages(value: unknown): unknown {
  return Array.isArray(value) ? mapUnchanged(value, message) : value;
}

function entry(value: RecordValue): RecordValue {
  return value.type === 'message' ? fields(value, ['message'], message) : value;
}

/** Preserve every entry, content index, identity, checkpoint and unknown field. */
export function stripSnapshotSignatures(snapshot: Snapshot): Snapshot {
  const entries = mapUnchanged(snapshot.entries, entry);
  const live = fields(snapshot.live, ['messages'], messages);
  return entries === snapshot.entries && live === snapshot.live ? snapshot : { ...snapshot, entries, live };
}

/** Project only documented message carriers, not arbitrary nested tool/custom payloads. */
export function stripEventSignatures(event: RecordValue): RecordValue {
  switch (event.type) {
    case 'message_start': case 'message_end': case 'turn_end':
      return fields(event, ['message'], message);
    case 'message_update': {
      const projected = fields(event, ['message'], message);
      return fields(projected, ['assistantMessageEvent'], value => record(value)
        ? fields(value, ['partial', 'message', 'error'], message) : value);
    }
    case 'agent_end': return fields(event, ['messages'], messages);
    case 'entry_appended': return fields(event, ['entry'], value => record(value) ? entry(value) : value);
    default: return event;
  }
}
