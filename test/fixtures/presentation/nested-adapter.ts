import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { Text } from '@earendil-works/pi-tui';
import type { ExtensionAPI, MessageRenderer } from '@earendil-works/pi-coding-agent';

export default async function (pi: ExtensionAPI) {
  const loader = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { '@earendil-works/pi-tui': fileURLToPath(import.meta.resolve('@earendil-works/pi-tui')) },
  });
  const { renderNotice } = await loader.import<{ renderNotice: MessageRenderer }>(
    fileURLToPath(new URL('./nested-renderer.ts', import.meta.url)));
  pi.registerMessageRenderer('fixture-notice', renderNotice);
  pi.on('session_start', (_event, ctx) => ctx.ui.setFooter(() => new Text('nested adapter loaded', 0, 0)));
}
