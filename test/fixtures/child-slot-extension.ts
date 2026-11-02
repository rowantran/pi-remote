import { dirname, join } from 'node:path';
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PI_REMOTE_API_EVENT, type PiRemoteApi } from '../../src/protocol/extension-api.js';

/** A small /side for tests: another extension that uses pi-remote's extension API. */
export default function childSlotExtension(pi: ExtensionAPI) {
  let settled: string | null = null;
  pi.on('session_start', (_event, ctx) => { settled = ctx.sessionManager.getLeafId(); });
  pi.on('agent_settled', (_event, ctx) => { settled = ctx.sessionManager.getLeafId(); });
  pi.registerCommand('fork-child', {
    description: 'Fork into a child slot (test)',
    handler: async (args, ctx) => {
      let remote: PiRemoteApi | undefined;
      pi.events.emit(PI_REMOTE_API_EVENT, { respond: (api: PiRemoteApi) => { remote = api; } });
      if (!remote) { ctx.ui.notify('CHILD_NO_API', 'error'); return; }
      const source = ctx.sessionManager.getSessionFile()!;
      const sessionDir = join(dirname(source), '..', 'children');
      const sessionFile = SessionManager.open(source, sessionDir).createBranchedSession((ctx.isIdle() ? ctx.sessionManager.getLeafId() : settled)!)!;
      try {
        const child = await remote.createChildSlot({ sessionFile, sessionDir, ...(args ? { prompt: args } : {}) });
        await remote.openSlot({ slotId: child.slotId });
        ctx.ui.notify(`CHILD_OPENED in #${child.slotNumber} from #${remote.slotNumber}`, 'info');
      } catch (error) { ctx.ui.notify(`CHILD_FAILED ${(error as Error).message}`, 'error'); }
    },
  });
}
