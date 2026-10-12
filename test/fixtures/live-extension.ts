import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Explicitly loaded only by the isolated SSH smoke test. Never installed globally. */
export default function(pi: ExtensionAPI) {
  pi.registerCommand('remote-smoke-dialog', {
    description: 'Smoke test: wait for a local client to answer a remote dialog',
    handler: async (_args, ctx) => {
      ctx.ui.setStatus('remote-smoke', 'Waiting for a client');
      ctx.ui.setWidget('remote-smoke', ['This dialog survives disconnection.']);
      const value = await ctx.ui.input('Pi Remote smoke test', 'Enter the test value');
      pi.appendEntry('remote-smoke-answer', { value });
      ctx.ui.setStatus('remote-smoke', undefined);
      ctx.ui.setWidget('remote-smoke', undefined);
      ctx.ui.notify(`Remote dialog answered: ${value ?? '(cancelled)'}`);
    },
  });
}
