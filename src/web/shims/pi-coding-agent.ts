/**
 * Browser entry for the public pi-coding-agent symbols used by the shared TUI.
 * The package root also loads providers, MCP, and process tools; the browser imports only
 * the display modules. The build resolves `pi-coding-agent-dist/...` to the pinned package.
 */
export { AssistantMessageComponent } from 'pi-coding-agent-dist/modes/interactive/components/assistant-message.js';
export { BashExecutionComponent } from 'pi-coding-agent-dist/modes/interactive/components/bash-execution.js';
export { BranchSummaryMessageComponent } from 'pi-coding-agent-dist/modes/interactive/components/branch-summary-message.js';
export { CompactionSummaryMessageComponent } from 'pi-coding-agent-dist/modes/interactive/components/compaction-summary-message.js';
export { CustomEditor } from 'pi-coding-agent-dist/modes/interactive/components/custom-editor.js';
export { CustomMessageComponent } from 'pi-coding-agent-dist/modes/interactive/components/custom-message.js';
// Shared for trusted adapters that patch this display component, not arbitrary private imports.
export { CustomEntryComponent } from 'pi-coding-agent-dist/modes/interactive/components/custom-entry.js';
export { SkillInvocationMessageComponent } from 'pi-coding-agent-dist/modes/interactive/components/skill-invocation-message.js';
export { ToolExecutionComponent } from 'pi-coding-agent-dist/modes/interactive/components/tool-execution.js';
export { TreeSelectorComponent } from 'pi-coding-agent-dist/modes/interactive/components/tree-selector.js';
export { UserMessageComponent } from 'pi-coding-agent-dist/modes/interactive/components/user-message.js';
export { Theme, getMarkdownTheme, getSelectListTheme, getSettingsListTheme, getLanguageFromPath, highlightCode, initTheme } from 'pi-coding-agent-dist/modes/interactive/theme/theme.js';
export { buildSessionProjection } from 'pi-coding-agent-dist/core/session-manager.js';
import {
  createShellRenderers, editRenderers, findRenderers, grepRenderers, lsRenderers, readRenderers, writeRenderers,
} from 'pi-coding-agent-dist/core/tools/renderers/index.js';
import { unavailable } from './vfs.js';

/** Compatibility with the shared transcript's factories, without importing ANY executor. */
function displayTool(name: string, renderers: object) {
  return { name, ...renderers, execute: (): never => unavailable(`Local tool execution (${name})`) };
}
export const createBashToolDefinition = (_cwd: string) => displayTool('bash', createShellRenderers('$'));
export const createPowerShellToolDefinition = (_cwd: string) => displayTool('powershell', createShellRenderers('PS>'));
export const createEditToolDefinition = (_cwd: string) => displayTool('edit', editRenderers);
export const createFindToolDefinition = (_cwd: string) => displayTool('find', findRenderers);
export const createGrepToolDefinition = (_cwd: string) => displayTool('grep', grepRenderers);
export const createLsToolDefinition = (_cwd: string) => displayTool('ls', lsRenderers);
export const createReadToolDefinition = (_cwd: string) => displayTool('read', readRenderers);
export const createWriteToolDefinition = (_cwd: string) => displayTool('write', writeRenderers);

/** Same parser as Pi 1.0.4's agent-session module, which would load the whole agent runtime. */
export function parseSkillBlock(text: string): { name: string; location: string; content: string; userMessage?: string } | null {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return { name: match[1]!, location: match[2]!, content: match[3]!, userMessage: match[4]?.trim() || undefined };
}

/** Browser clipboard. iOS may refuse writes that do not follow a recent tap. */
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
