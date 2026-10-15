import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
  pi.on('agent_start', (_event, ctx) => {
    if (timer !== undefined) return;
    let ticks = 0;
    ctx.ui.setWorkingMessage('Fixture tick 0');
    timer = setInterval(() => ctx.ui.setWorkingMessage(`Fixture tick ${++ticks}`), 1000);
  });
  pi.on('agent_settled', (_event, ctx) => { stop(); ctx.ui.setWorkingMessage(); });
  pi.on('session_shutdown', stop);
}
