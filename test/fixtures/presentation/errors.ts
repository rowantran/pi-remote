import { Text } from '@earendil-works/pi-tui';
export default function (pi: any) {
  pi.registerEntryRenderer('broken', () => { throw new Error('renderer failed'); });
  pi.registerMessageRenderer('broken', () => ({ render() { throw new Error('component failed'); }, invalidate() {} }));
  pi.registerMarkdownTransformer(() => { throw new Error('markdown failed'); });
  pi.registerTool({ name: 'broken', parameters: {}, renderCall() { throw new Error('tool renderer failed'); }, execute() { throw new Error('MUST NOT EXECUTE'); } });
  pi.registerCommand('exec', { handler() { pi.exec('must-not-run'); } });
  pi.registerCommand('send', { handler() { pi.sendUserMessage('must-not-send'); } });
  pi.registerCommand('provider', { handler() { pi.registerProvider('must-not-register', {}); } });
  pi.registerCommand('virtual', { handler() { pi.registerVirtualModel({}); } });
  pi.registerCommand('mcp', { handler() { pi.registerMcpServer('must-not-start', {}); } });
  pi.registerCommand('model', { handler() { pi.setModel({}); } });
  pi.registerCommand('context-exec', { handler(_: string, ctx: any) { ctx.executeTool('bash', {}); } });
  pi.on('agent_start', () => { throw new Error('handler failed'); });
  pi.on('agent_start', (_event: any, ctx: any) => ctx.ui.setWorkingMessage('survived'));
  pi.on('session_start', (_event: any, ctx: any) => ctx.ui.setHeader(() => new Text('error fixture', 0, 0)));
}
