import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api, type SimpleStreamOptions, type TranscriptContext, type ToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Offline test provider. The actual stock CLI owns streaming, tools and persistence. */
export default function goldenProvider(pi: ExtensionAPI) {
  pi.registerProvider('golden-local', {
    api: 'golden-local-stream', baseUrl: 'http://127.0.0.1:1', apiKey: 'not-a-secret-offline-fixture',
    models: [{ id: 'transcript', name: 'Golden transcript', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
      const stream = createAssistantMessageEventStream();
      const gate = process.env.GOLDEN_GATE_DIR!;
      appendFileSync(join(gate, 'provider-requests.jsonl'), JSON.stringify({ model: model.id, timestamp: Date.now() }) + '\n');
      const output: AssistantMessage = {
        role: 'assistant', api: model.api, model: model.id, provider: model.provider, content: [],
        stopReason: 'pending', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const push = async (event: any) => {
        if (options?.signal?.aborted) throw new Error('Golden stream aborted');
        await options?.onProviderStreamEvent?.(event, model);
        stream.push(event);
      };
      const wait = async (name: string) => {
        writeFileSync(join(gate, `${name}-ready`), 'ready\n');
        for (let n = 0; !existsSync(join(gate, `${name}-release`)); n++) {
          if (n > 2400) throw new Error(`Golden gate ${name} timed out`);
          if (options?.signal?.aborted) throw new Error('Golden stream aborted');
          await delay(25);
        }
      };
      const text = async (value: string, thinking = false, pause = false) => {
        const index = output.content.length;
        const block: any = thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        output.content.push(block);
        await push({ type: thinking ? 'thinking_start' : 'text_start', contentIndex: index, partial: output });
        for (const delta of value.match(/.{1,37}|\n/gs) ?? []) {
          block[thinking ? 'thinking' : 'text'] += delta;
          await push({ type: thinking ? 'thinking_delta' : 'text_delta', contentIndex: index, delta, partial: output });
          await delay(5);
        }
        if (pause) await wait('stream');
        await push({ type: thinking ? 'thinking_end' : 'text_end', contentIndex: index, content: value, partial: output });
      };
      void (async () => {
        try {
          await options?.onPayload?.({ fixture: 'golden-local', messages: context.messages.length }, model);
          // There is no HTTP response: onResponse intentionally does not apply to this local provider.
          await push({ type: 'start', partial: output });
          const last = context.messages.at(-1);
          const secondPrompt = last?.role === 'user' && (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)).includes('GOLDEN_SECOND_USER');
          if (secondPrompt) {
            await text('Second response after user bash.\n\nGOLDEN_SECOND_DONE');
            output.stopReason = 'stop';
          } else if (last?.role === 'toolResult') {
            await text('Tools finished: **success** and **expected error**.\n\nGOLDEN_DONE');
            output.stopReason = 'stop';
          } else {
            await text('I will check **literal user text**, Markdown, and tool output.\n\nThinking stays visible until toggled.', true);
            await text('# Markdown transcript\n\n**Bold**, *italic*, ~~strike~~, `inline code`, and [a link](https://example.invalid).\n\n> A quoted line with Unicode: café, λ, 世界.\n\n- First item\n- Second item that wraps when the terminal is narrow: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.\n\n| Name | Value |\n| --- | --- |\n| one | `two` |\n\n```ts\nconst answer: number = 42;\nconsole.log(answer);\n```\n\nGOLDEN_STREAM', false, true);
            const commands = [
              `printf 'TOOL_STREAM_HEAD\\n'; touch "$GOLDEN_GATE_DIR/tool-ready"; while [ ! -f "$GOLDEN_GATE_DIR/tool-release" ]; do sleep 0.05; done; printf 'line %02d: deterministic tool output\\n' {1..18}; printf 'TOOL_SUCCESS_END\\n'`,
              `printf 'EXPECTED_TOOL_ERROR\\n' >&2; exit 7`,
            ];
            for (const [n, command] of commands.entries()) {
              const index = output.content.length;
              const call: ToolCall = { type: 'toolCall', id: `golden-bash-${n}`, name: 'bash', arguments: {} };
              output.content.push(call);
              await push({ type: 'toolcall_start', contentIndex: index, partial: output });
              call.arguments = { command };
              await push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(call.arguments), partial: output });
              await push({ type: 'toolcall_end', contentIndex: index, toolCall: call, partial: output });
            }
            output.stopReason = 'toolUse';
          }
          output.usage.input = 100; output.usage.output = 50; output.usage.totalTokens = 150;
          await push({ type: 'done', reason: output.stopReason, message: output });
          stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: 'error', reason: output.stopReason, error: output }); stream.end();
        }
      })();
      return stream;
    },
  });
  pi.on('session_start', () => { writeFileSync(join(process.env.GOLDEN_GATE_DIR!, 'session-ready'), 'ready\n'); });
  pi.on('agent_settled', () => { writeFileSync(join(process.env.GOLDEN_GATE_DIR!, 'settled-ready'), 'ready\n'); });
}
