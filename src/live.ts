import type { LiveState, RecordValue } from './protocol.js';

export function emptyLive(): LiveState {
  return { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] };
}
export function messageKey(message: RecordValue): string {
  return `${message.role}:${message.timestamp}:${message.toolCallId ?? ''}`;
}
function putMessage(live: LiveState, message: RecordValue) {
  const index = live.messages.findIndex(m => messageKey(m) === messageKey(message));
  if (index === -1) live.messages.push(structuredClone(message));
  else live.messages[index] = structuredClone(message);
}

/** Display-only state. Never feeds reconstructed messages back into Pi. */
export function applyLiveEvent(live: LiveState, event: RecordValue): void {
  switch (event.type) {
    case 'bash_execution_update': {
      const id = typeof event.id === 'string' ? event.id : 'bash';
      if (typeof event.delta !== 'string') break;
      live.bash ??= {};
      const current = Object.hasOwn(live.bash, id) ? live.bash[id] : {output: ''};
      const output = (current.output + event.delta).slice(-131072);
      Object.defineProperty(live.bash, id, {value: {output}, writable: true, configurable: true, enumerable: true});
      break;
    }
    case 'remote_bash_end': live.bash = {}; break;
    case 'agent_start':
      if (!live.busy) live.messages = [];
      live.busy = true;
      break;
    case 'agent_settled': live.busy = false; break;
    case 'compaction_start': live.compacting = true; break;
    case 'compaction_end': live.compacting = false; break;
    case 'queue_update': live.steering = event.steering ?? []; live.followUp = event.followUp ?? []; break;
    case 'message_start': case 'message_end':
      putMessage(live, event.message);
      break;
    case 'message_update': {
      const message = [...live.messages].reverse().find(m => m.role === 'assistant' && m.stopReason === 'pending');
      if (!message) break;
      message.usage = event.usage ?? message.usage;
      const update = event.assistantMessageEvent;
      if (!update || typeof update !== 'object' || typeof update.type !== 'string') break;
      const index = update.contentIndex;
      if (!Number.isInteger(index) || index < 0 || index > 10_000) break;
      if (update.type.endsWith('_delta') && typeof update.delta !== 'string') break;
      const content = message.content as RecordValue[];
      switch (update.type) {
        case 'text_start': content[index] = { type: 'text', text: '' }; break;
        case 'thinking_start': content[index] = { type: 'thinking', thinking: '' }; break;
        case 'toolcall_start': content[index] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {}, argumentText: '' }; break;
        case 'text_delta':
          content[index] ??= { type: 'text', text: '' };
          content[index].text += update.delta;
          break;
        case 'thinking_delta':
          content[index] ??= { type: 'thinking', thinking: '' };
          content[index].thinking += update.delta;
          break;
        case 'toolcall_delta':
          if (content[index]) content[index].argumentText = (content[index].argumentText ?? '') + update.delta;
          break;
        case 'text_end': content[index] = { type: 'text', text: update.content }; break;
        case 'thinking_end': content[index] = { type: 'thinking', thinking: update.content }; break;
        case 'toolcall_end': content[index] = structuredClone(update.toolCall); break;
      }
      break;
    }
    case 'tool_execution_start': case 'tool_execution_update': {
      const id = event.toolCallId;
      if (typeof id !== 'string') break;
      Object.defineProperty(live.tools, id, {value: structuredClone(event), writable: true, configurable: true, enumerable: true});
      break;
    }
    case 'tool_execution_end':
      if (typeof event.toolCallId === 'string' && Object.hasOwn(live.tools, event.toolCallId)) delete live.tools[event.toolCallId];
      break;
  }
}
