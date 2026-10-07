import { Text } from '@earendil-works/pi-tui';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'fixture', label: 'Fixture', description: 'Display fixture', parameters: { type: 'object', properties: {} } as any,
    async execute() { throw new Error('EXECUTE MUST NEVER RUN'); },
    renderCall(args, _theme, ctx) {
      ctx.state.renders = (ctx.state.renders ?? 0) + 1;
      ctx.state.invalidate = ctx.invalidate;
      return new Text(`call:${args.value}:${ctx.state.renders}:${ctx.lastComponent ? 'reused' : 'new'}`, 0, 0);
    },
    renderResult(result, options, _theme, ctx) {
      return new Text(`result:${ctx.args.value}:${ctx.state.renders}:${options.expanded}:${result.details}`, 0, 0);
    },
  });
  pi.registerToolRenderer((name, next) => name === 'resolver' ? { renderCall: () => new Text('first', 0, 0) } : next());
  pi.registerToolRenderer((name, next) => name === 'resolver' ? { renderCall: () => new Text('second', 0, 0) } : next());
  pi.registerMessageRenderer('fixture', (message) => new Text(`message:${message.details}`, 0, 0));
  pi.registerEntryRenderer('fixture', (entry) => new Text(`entry:${entry.data}`, 0, 0));
  pi.registerMarkdownTransformer(text => text.replace('old', 'new'));
  pi.on('before_agent_start', () => { throw new Error('NON-DISPLAY HOOK MUST NEVER RUN'); });
  pi.on('tool_call', () => { throw new Error('TOOL HOOK MUST NEVER RUN'); });
  pi.on('context', () => { throw new Error('CONTEXT HOOK MUST NEVER RUN'); });
  pi.events.on('local', () => { pi.events.emit('local-result', 'ok'); });
  pi.events.on('local-result', value => { if (value !== 'ok') throw new Error('bus'); });
  pi.on('session_start', (_event, ctx) => {
    pi.events.emit('local', null);
    ctx.ui.setFooter((_tui, _theme, footer) => {
      const off = footer.onBranchChange(() => ctx.ui.notify('branch changed'));
      return { dispose: off, invalidate() {}, render() {
        const branch = ctx.sessionManager.getBranch();
        const routed = ctx.modelRegistry.find('physical', 'real');
        return [JSON.stringify({
          branch: branch.map(entry => entry.id), name: ctx.model?.id, routed: routed?.id,
          git: footer.getGitBranch(), providers: footer.getAvailableProviderCount(),
          statuses: [...footer.getExtensionStatuses()], usage: ctx.getContextUsage(),
        })];
      } };
    });
    ctx.ui.setHeader(() => new Text('header', 0, 0));
    ctx.ui.setWidget('above', ['widget']);
    ctx.ui.setWidget('below', () => new Text('component widget', 0, 0), { placement: 'belowEditor' });
    ctx.ui.setStatus('local', 'local status');
    ctx.ui.setWorkingMessage('working');
  });
  pi.registerCommand('local', { handler: async (args, ctx) => { ctx.ui.setEditorText(args); ctx.ui.setToolsExpanded(true); } });
  pi.registerShortcut('alt+o', { handler: async ctx => ctx.ui.setWorkingMessage('shortcut') });
  pi.registerCommand('mutate', { handler: async () => { pi.appendEntry('forbidden', {}); } });
  pi.registerCommand('inspect-readonly', { handler: async (_, ctx) => { ctx.sessionManager.getBranch()[0].id = 'changed'; } });
  pi.on('agent_start', (_event, ctx) => ctx.ui.setWorkingMessage('agent'));
  pi.on('agent_settled', (_event, ctx) => ctx.ui.setWorkingMessage());
  pi.on('session_shutdown', (_event, ctx) => ctx.ui.notify('shutdown'));
}
