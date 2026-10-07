import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import {
  Theme, type ExtensionAPI, type ExtensionUIContext, type ToolDefinition,
  type ToolRenderers, type ToolRendererResolver, type ToolRenderResultOptions,
  type MessageRenderer, type EntryRenderer, type MarkdownTransformer, type MarkdownTransformContext,
} from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, Editor, matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { RecordValue, Snapshot } from './protocol.js';
import { activeBranch, messageKey } from './view.js';

/**
 * Local presentation compatibility, NOT a JavaScript sandbox. Only explicitly trusted files may
 * be loaded. Imports and factories have ordinary process privileges, including module side effects.
 * This host never discovers Pi extensions, creates an AgentSession, or receives a remote connection.
 * Its context API blocks tool execution, persistent writes and remote session control.
 * Custom editors are trusted input controllers: the TUI gives them a submission callback,
 * so they can submit prompts/commands. These guards are compatibility checks, not isolation.
 * This is not the complete ExtensionAPI: local dialogs/custom overlays (ui.custom), credential
 * access, provider registration and session-control APIs are intentionally unsupported.
 */
export interface PresentationConfig { extensions: string[]; theme?: string }
export async function readPresentationConfig(
  path = resolve(homedir(), '.pi/remote-client.json'), cliExtensions: string[] = [],
): Promise<PresentationConfig> {
  let config: RecordValue = {};
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.extensions !== undefined && (!Array.isArray(config.extensions) || config.extensions.some((p: unknown) => typeof p !== 'string' || !p)))
    || (config.theme !== undefined && typeof config.theme !== 'string')) throw new Error(`Invalid presentation config: ${path}`);
  return {
    extensions: [...new Set([
      ...(config.extensions ?? []).map((p: string) => modulePath(p, dirname(resolve(path)))),
      ...cliExtensions.map(p => modulePath(p)),
    ])], theme: config.theme,
  };
}
function modulePath(path: string, base = process.cwd()): string {
  return resolve(base, path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
}

type DisposableComponent = Component & { dispose?(): void };
type EditorFactory = NonNullable<Parameters<ExtensionUIContext['setEditorComponent']>[0]>;
type RenderContext = Parameters<NonNullable<ToolDefinition<any, any>['renderCall']>>[2];
export type PresentationToolContext = Partial<RenderContext> & { toolCallId: string };
export interface PresentationWidget { component: DisposableComponent; placement: 'aboveEditor' | 'belowEditor' }
export interface PresentationHostOptions {
  snapshot: () => Snapshot;
  tui: TUI;
  theme?: () => Theme;
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  invalidate: () => void;
  getEditorText?: () => string;
  setEditorText?: (text: string) => void;
  getToolsExpanded?: () => boolean;
  setToolsExpanded?: (expanded: boolean) => void;
  setTitle?: (title: string) => void;
}
interface ToolRow {
  state: RecordValue; args: any; call?: DisposableComponent; result?: DisposableComponent;
  active: boolean; onInvalidate?: () => void; invalidate: () => void;
}
interface Hook { owner: Owner; fn: (...args: any[]) => any }
interface Owner { path: string; enabled: boolean }
const DISPLAY_EVENTS = new Set([
  'session_start', 'session_shutdown', 'session_switch', 'session_tree', 'session_compact',
  'session_info_changed', 'model_select', 'thinking_level_select', 'agent_start', 'agent_end',
  'agent_settled', 'message_start', 'message_update', 'tool_execution_start',
  'tool_execution_update', 'tool_execution_end',
]);

/** Clone and freeze wire data; extension code never receives mutable snapshot objects. */
function readonlyCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: any): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy;
}

/** Public Theme constructor only; callers may supply their own live public theme getter. */
export function createPresentationTheme(): Theme {
  const foreground = 'accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode'.split(' ');
  const background = 'selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg'.split(' ');
  return new Theme(
    { ...Object.fromEntries(foreground.map(key => [key, ''])), accent: 6, muted: 8, dim: 8, success: 2, error: 1, warning: 3 } as any,
    Object.fromEntries(background.map(key => [key, ''])) as any, '256color', { name: 'remote-default' },
  );
}

export class PresentationHost {
  footer?: DisposableComponent;
  header?: DisposableComponent;
  editorFactory?: EditorFactory;
  readonly widgets = new Map<string, PresentationWidget>();
  workingMessage?: string;
  workingVisible = true;
  workingIndicator?: RecordValue;
  hiddenThinkingLabel?: string;
  readonly tools = new Map<string, ToolRenderers & { name: string; description?: string; parameters?: unknown; label?: string }>();
  private readonly hooks = new Map<string, Hook[]>();
  private readonly bus = new Map<string, Hook[]>();
  private readonly commands = new Map<string, Hook>();
  private readonly shortcuts = new Map<string, Hook>();
  private readonly resolvers: Hook[] = [];
  private readonly messages = new Map<string, Hook>();
  private readonly entries = new Map<string, Hook>();
  private readonly markdown: Hook[] = [];
  private readonly statuses = new Map<string, string>();
  private readonly branchListeners = new Set<() => void>();
  private readonly rows = new Map<string, ToolRow>();
  private readonly loaded = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly disabled = new WeakSet<Function>();
  private readonly guardedComponents = new WeakMap<object, DisposableComponent>();
  private readonly fallbackTheme = createPresentationTheme();
  private started = false;
  private stopped = false;
  private branch: string | null;
  private current?: Snapshot;
  private context: any;

  constructor(private readonly options: PresentationHostOptions) {
    this.branch = this.snapshot.presentation?.gitBranch ?? null;
    this.context = this.makeContext();
  }
  private get snapshot(): Snapshot { return this.current ?? this.options.snapshot(); }
  get theme(): Theme { return this.options.theme?.() ?? this.fallbackTheme; }
  private report(key: string, error: unknown): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    try { this.options.notify(`Local presentation: ${key}: ${error instanceof Error ? error.message : String(error)}`, 'warning'); } catch { /* UI may be closing. */ }
  }
  private blocked(name: string): never {
    const message = `${name} is unavailable in the presentation-only host; nothing was sent or executed`;
    this.report(name, message); throw new Error(message);
  }
  private changed(): void { if (!this.stopped) this.options.invalidate(); }
  private call<T>(key: string, fn: (...args: any[]) => T, ...args: any[]): T | undefined {
    if (this.disabled.has(fn)) return undefined;
    try { return fn(...args); }
    catch (error) { this.disabled.add(fn); this.report(key, error); return undefined; }
  }
  private async invoke(hook: Hook, ...args: any[]): Promise<void> {
    if (!hook.owner.enabled || this.disabled.has(hook.fn)) return;
    try { await hook.fn(...args); }
    catch (error) { this.disabled.add(hook.fn); this.report(hook.owner.path, error); }
  }
  /** Load exact files only. No directory, package, git, glob, or standard Pi resource discovery. */
  async load(paths: readonly string[]): Promise<void> {
    const require = createRequire(import.meta.url);
    const alias: Record<string, string> = {};
    for (const pkg of ['pi-coding-agent', 'pi-tui', 'pi-agent-core', 'pi-ai']) {
      const target = fileURLToPath(import.meta.resolve(`@earendil-works/${pkg}${pkg === 'pi-ai' ? '/compat' : ''}`));
      alias[`@earendil-works/${pkg}`] = target; alias[`@mariozechner/${pkg}`] = target;
    }
    for (const suffix of ['/compat', '/oauth', '/providers/all']) {
      alias[`@earendil-works/pi-ai${suffix}`] = fileURLToPath(import.meta.resolve(`@earendil-works/pi-ai${suffix}`));
      alias[`@mariozechner/pi-ai${suffix}`] = alias[`@earendil-works/pi-ai${suffix}`];
    }
    for (const suffix of ['', '/compile', '/value']) {
      alias[`typebox${suffix}`] = require.resolve(`typebox${suffix}`);
      alias[`@sinclair/typebox${suffix}`] = alias[`typebox${suffix}`];
    }
    const jiti = createJiti(import.meta.url, { alias, moduleCache: false });
    for (const path of paths) {
      const resolved = modulePath(path);
      if (this.loaded.has(resolved)) continue;
      this.loaded.add(resolved);
      const owner: Owner = { path: resolved, enabled: true };
      try {
        if (!(await stat(resolved)).isFile()) throw new Error('Select a trusted extension file, not a directory');
        const factory = await jiti.import<any>(resolved, { default: true });
        if (typeof factory !== 'function') throw new Error('Extension must export a default factory');
        await factory(this.makeAPI(owner));
      } catch (error) { owner.enabled = false; this.report(resolved, error); }
    }
    this.changed();
  }
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true; await this.dispatch({ type: 'session_start' });
  }
  update(snapshot: Snapshot): void {
    this.current = snapshot;
    const branch = snapshot.presentation?.gitBranch ?? null;
    if (branch !== this.branch) {
      this.branch = branch;
      for (const listener of [...this.branchListeners]) this.call('branch listener', listener);
    }
    this.footer?.invalidate(); this.header?.invalidate();
    for (const widget of this.widgets.values()) widget.component.invalidate();
    this.changed();
  }
  async dispatch(event: RecordValue): Promise<void> {
    if (!DISPLAY_EVENTS.has(event.type) || this.stopped) return;
    for (const hook of [...(this.hooks.get(event.type) ?? [])]) await this.invoke(hook, readonlyCopy(event), this.context);
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    await this.dispatch({ type: 'session_shutdown' }); this.stopped = true;
    this.footer?.dispose?.(); this.header?.dispose?.();
    for (const widget of this.widgets.values()) widget.component.dispose?.();
    this.retainToolCalls([]); this.branchListeners.clear(); this.bus.clear();
  }
  async command(name: string, args = ''): Promise<boolean> {
    const hook = this.commands.get(name.replace(/^\//, ''));
    if (!hook || this.stopped) return false;
    await this.invoke(hook, args, this.context); this.changed(); return true;
  }
  get commandNames(): string[] { return [...this.commands.keys()]; }
  hasShortcut(data: string): boolean { return !this.stopped && [...this.shortcuts.keys()].some(key => matchesKey(data, key as any)); }
  async shortcut(data: string): Promise<boolean> {
    if (this.stopped) return false;
    for (const [key, hook] of this.shortcuts) {
      if (matchesKey(data, key as any)) { await this.invoke(hook, this.context); this.changed(); return true; }
    }
    return false;
  }
  private register(map: Map<string, Hook[]>, name: string, hook: Hook): () => void {
    const hooks = map.get(name) ?? []; map.set(name, hooks); hooks.push(hook);
    return () => { const index = hooks.indexOf(hook); if (index >= 0) hooks.splice(index, 1); };
  }
  private makeAPI(owner: Owner): ExtensionAPI {
    const hook = (fn: Hook['fn']): Hook => ({ owner, fn });
    const api: RecordValue = {
      on: (name: string, fn: Hook['fn']) => {
        if (!DISPLAY_EVENTS.has(name)) { this.report(`${owner.path}: pi.on(${name})`, 'Ignored non-display hook'); return () => {}; }
        return this.register(this.hooks, name, hook(fn));
      },
      registerTool: (tool: ToolDefinition<any, any>) => {
        // Deliberately enumerate fields. Never retain execute, prepareArguments or prepareLoadout,
        // even indirectly by closing over the original tool definition.
        const { renderCall, renderResult } = tool;
        this.tools.set(tool.name, {
          name: tool.name, label: tool.label, description: tool.description, parameters: readonlyCopy(tool.parameters),
          renderShell: tool.renderShell,
          renderCall: renderCall && ((...args) => owner.enabled ? renderCall(...args) : undefined as any),
          renderResult: renderResult && ((...args) => owner.enabled ? renderResult(...args) : undefined as any),
        });
      },
      registerToolRenderer: (fn: ToolRendererResolver) => this.resolvers.push(hook(fn)),
      registerMessageRenderer: (name: string, fn: MessageRenderer) => this.messages.set(name, hook(fn)),
      registerEntryRenderer: (name: string, fn: EntryRenderer) => this.entries.set(name, hook(fn)),
      registerMarkdownTransformer: (fn: MarkdownTransformer) => this.markdown.push(hook(fn)),
      registerCommand: (name: string, command: RecordValue) => this.commands.set(name, hook(command.handler)),
      registerShortcut: (key: string, shortcut: RecordValue) => this.shortcuts.set(key, hook(shortcut.handler)),
      registerFlag: () => {}, getFlag: () => undefined,
      getThinkingLevel: () => this.snapshot.state.thinkingLevel,
      getSessionName: () => this.snapshot.state.sessionName ?? this.snapshot.slot.sessionName,
      getActiveTools: () => readonlyCopy(this.snapshot.state.activeTools ?? []),
      getAllTools: () => [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
      getCommands: () => [...this.commands.keys()].map(name => ({ name })),
      getEnabledModels: () => readonlyCopy(this.snapshot.presentation?.enabledModels ?? []),
      events: {
        on: (name: string, fn: Hook['fn']) => this.register(this.bus, name, hook(fn)),
        emit: (name: string, value: unknown) => {
          for (const listener of [...(this.bus.get(name) ?? [])]) void this.invoke(listener, value);
        },
      },
    };
    return this.restricted(api, 'pi') as ExtensionAPI;
  }
  private restricted(target: RecordValue, prefix: string): any {
    return new Proxy(target, { get: (obj, key) => {
      if (key in obj) return obj[key as string];
      if (key === 'then' || typeof key === 'symbol') return undefined;
      return () => this.blocked(`${prefix}.${String(key)}`);
    } });
  }
  private makeContext(): any {
    const host = this;
    const ui: RecordValue = {
      get theme() { return host.theme; },
      notify: (message: string, type?: 'info' | 'warning' | 'error') => this.options.notify(message, type),
      setStatus: (key: string, text?: string) => { if (text === undefined) this.statuses.delete(key); else this.statuses.set(key, text); this.changed(); },
      setFooter: (factory?: Function) => {
        this.footer?.dispose?.();
        this.footer = factory ? this.component('footer', this.call('footer factory', factory as any, this.options.tui, this.theme, this.footerData)) : undefined;
        this.changed();
      },
      setHeader: (factory?: Function) => {
        this.header?.dispose?.();
        this.header = factory ? this.component('header', this.call('header factory', factory as any, this.options.tui, this.theme)) : undefined;
        this.changed();
      },
      setWidget: (key: string, content?: string[] | string | Function, options?: RecordValue) => {
        this.widgets.get(key)?.component.dispose?.(); this.widgets.delete(key);
        if (content !== undefined) {
          const component = this.component(`widget ${key}`, typeof content === 'function'
            ? this.call(`widget factory ${key}`, content as any, this.options.tui, this.theme)
            : new Text(Array.isArray(content) ? content.join('\n') : content, 0, 0));
          if (component) this.widgets.set(key, { component, placement: options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' });
        }
        this.changed();
      },
      setEditorComponent: (factory?: EditorFactory) => {
        this.editorFactory = factory && ((tui, theme, keybindings) => {
          const editor = this.call('editor factory', factory, tui, theme, keybindings) ?? new Editor(tui, theme);
          return this.component('editor', editor)! as ReturnType<EditorFactory>;
        });
        this.changed();
      },
      getEditorComponent: () => this.editorFactory,
      getEditorText: () => this.options.getEditorText?.() ?? '',
      setEditorText: (text: string) => { this.options.setEditorText?.(text); this.changed(); },
      pasteToEditor: (text: string) => { this.options.setEditorText?.((this.options.getEditorText?.() ?? '') + text); this.changed(); },
      getToolsExpanded: () => this.options.getToolsExpanded?.() ?? false,
      setToolsExpanded: (expanded: boolean) => { this.options.setToolsExpanded?.(expanded); this.changed(); },
      setTitle: (title: string) => this.options.setTitle?.(title),
      setWorkingMessage: (message?: string) => { this.workingMessage = message; this.changed(); },
      setWorkingVisible: (visible: boolean) => { this.workingVisible = visible; this.changed(); },
      setWorkingIndicator: (options?: RecordValue) => { this.workingIndicator = options; this.changed(); },
      setHiddenThinkingLabel: (label?: string) => { this.hiddenThinkingLabel = label; this.changed(); },
    };
    const sessionManager = this.restricted({
      getEntries: () => readonlyCopy(this.snapshot.entries),
      getBranch: (leafId?: string) => {
        const snapshot = this.snapshot;
        const branch = activeBranch(snapshot.entries, leafId ?? snapshot.leafId);
        if (leafId === undefined) {
          const seen = new Set(branch.filter(entry => entry.type === 'message').map(entry => messageKey(entry.message)));
          for (const message of snapshot.live.messages) if (!seen.has(messageKey(message))) {
            branch.push({ type: 'message', id: `live:${messageKey(message)}`, message });
          }
        }
        return readonlyCopy(branch);
      },
      getEntry: (id: string) => readonlyCopy(this.snapshot.entries.find(entry => entry.id === id)),
      getLeafId: () => this.snapshot.leafId,
      getSessionId: () => this.snapshot.state.sessionId ?? this.snapshot.slot.id,
      getSessionName: () => this.snapshot.state.sessionName ?? this.snapshot.slot.sessionName,
      getSessionFile: () => this.snapshot.slot.sessionFile,
      getCwd: () => this.snapshot.slot.cwd,
      getHeader: () => readonlyCopy(this.snapshot.entries.find(entry => entry.type === 'session')),
    }, 'ctx.sessionManager');
    const models = () => this.snapshot.presentation?.models ?? [];
    const modelRegistry = this.restricted({
      find: (provider: string, id: string) => readonlyCopy(models().find(model => model.provider === provider && model.id === id)),
      getAll: () => readonlyCopy(models()), getAvailable: () => readonlyCopy(models()),
      isUsingOAuth: (model: RecordValue) => this.snapshot.presentation?.oauthProviders?.includes(model.provider) ?? false,
    }, 'ctx.modelRegistry');
    return this.restricted({
      get cwd() { return host.snapshot.slot.cwd; },
      get model() { return readonlyCopy(host.snapshot.state.model); },
      get thinkingLevel() { return host.snapshot.state.thinkingLevel; },
      get sessionId() { return host.snapshot.state.sessionId ?? host.snapshot.slot.id; },
      get homeDir() { return host.snapshot.presentation?.homeDir; },
      hasUI: true, mode: 'tui', ui: this.restricted(ui, 'ctx.ui'), sessionManager, modelRegistry,
      getContextUsage: () => readonlyCopy(this.snapshot.presentation?.stats?.contextUsage),
      isIdle: () => !this.snapshot.live.busy,
      hasPendingMessages: () => !!(this.snapshot.live.steering.length || this.snapshot.live.followUp.length),
      getSystemPrompt: () => '',
    }, 'ctx');
  }
  readonly footerData = {
    getGitBranch: (): string | null => this.snapshot.presentation?.gitBranch ?? null,
    getExtensionStatuses: (): ReadonlyMap<string, string> => {
      const statuses = new Map<string, string>();
      for (const record of this.snapshot.ui) if (record.method === 'setStatus') {
        const key = record.statusKey ?? record.key;
        if (typeof key === 'string' && typeof record.statusText === 'string') statuses.set(key, record.statusText);
      }
      for (const [key, value] of this.statuses) statuses.set(key, value);
      return statuses;
    },
    getAvailableProviderCount: (): number => new Set((this.snapshot.presentation?.models ?? []).map(model => model.provider)).size,
    onBranchChange: (callback: () => void): (() => void) => { this.branchListeners.add(callback); return () => this.branchListeners.delete(callback); },
  };
  /** Exceptions from component render/input/invalidate/dispose are contained locally. */
  private component(key: string, value?: DisposableComponent): DisposableComponent | undefined {
    if (!value || typeof value.render !== 'function') return undefined;
    const existing = this.guardedComponents.get(value);
    if (existing) return existing;
    let failed = false;
    const guarded = new Proxy(value, { get: (target, property) => {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...args: any[]) => {
        if (failed && property !== 'dispose') return property === 'render' ? [] : undefined;
        try {
          const result = member.apply(target, args);
          return property === 'render' ? result.map((line: string) => truncateToWidth(line, args[0], '')) : result;
        } catch (error) { failed = true; this.report(key, error); return property === 'render' ? [] : undefined; }
      };
    }, set: (target, property, value) => Reflect.set(target, property, value, target) });
    this.guardedComponents.set(value, guarded); this.guardedComponents.set(guarded, guarded);
    return guarded;
  }
  resolveToolRenderer(name: string): ToolRenderers | undefined {
    const resolveAt = (index: number): ToolRenderers | undefined => {
      const hook = this.resolvers[index];
      if (!hook) return this.tools.get(name);
      if (!hook.owner.enabled || this.disabled.has(hook.fn)) return resolveAt(index + 1);
      return this.call(`tool resolver ${name}`, hook.fn, name, () => resolveAt(index + 1));
    };
    return resolveAt(0);
  }
  private row(name: string, args: unknown, input: PresentationToolContext, slot: 'call' | 'result'): { row: ToolRow; context: RenderContext } {
    const key = `${input.toolCallId}\0${name}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { state: {}, args: {}, active: true, invalidate: () => {
        if (!row!.active) return;
        row!.call?.invalidate(); row!.result?.invalidate(); row!.onInvalidate?.(); this.changed();
      } };
      this.rows.set(key, row);
    }
    row.onInvalidate = input.invalidate;
    if (args !== undefined) row.args = readonlyCopy(args);
    return { row, context: {
      cwd: this.snapshot.slot.cwd, executionStarted: true, argsComplete: true, isPartial: false,
      expanded: this.options.getToolsExpanded?.() ?? false, showImages: false, isError: false,
      ...input, args: row.args, state: row.state, invalidate: row.invalidate, lastComponent: row[slot],
    } };
  }
  renderCall(name: string, args: unknown, input: PresentationToolContext): Component | undefined {
    const renderer = this.resolveToolRenderer(name)?.renderCall;
    if (!renderer) return undefined;
    const { row, context } = this.row(name, args, input, 'call');
    const next = this.component(`tool call ${name}`, this.call(`tool call ${name}`, renderer, context.args, this.theme, context));
    if (row.call !== next) row.call?.dispose?.();
    return row.call = next;
  }
  renderResult(name: string, result: any, options: ToolRenderResultOptions, input: PresentationToolContext): Component | undefined {
    const renderer = this.resolveToolRenderer(name)?.renderResult;
    if (!renderer) return undefined;
    const { row, context } = this.row(name, input.args, { ...input, ...options }, 'result');
    const next = this.component(`tool result ${name}`, this.call(`tool result ${name}`, renderer, readonlyCopy(result), options, this.theme, context));
    if (row.result !== next) row.result?.dispose?.();
    return row.result = next;
  }
  /** Parent calls this when transcript rows disappear or a session changes. */
  retainToolCalls(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const [key, row] of this.rows) if (!keep.has(key.split('\0')[0])) {
      row.active = false; row.onInvalidate = undefined;
      row.call?.dispose?.(); row.result?.dispose?.();
      row.call = undefined; row.result = undefined; row.state = {}; row.args = undefined;
      this.rows.delete(key);
    }
  }
  renderMessage(message: RecordValue, options: { expanded: boolean; outputPad?: number }): Component | undefined {
    const hook = this.messages.get(message.customType);
    if (!hook?.owner.enabled) return undefined;
    return this.component(`message ${message.customType}`, this.call(`message ${message.customType}`, hook.fn, readonlyCopy(message), { outputPad: 0, ...options }, this.theme));
  }
  renderEntry(entry: RecordValue, options: { expanded: boolean }): Component | undefined {
    const hook = this.entries.get(entry.customType);
    if (!hook?.owner.enabled) return undefined;
    return this.component(`entry ${entry.customType}`, this.call(`entry ${entry.customType}`, hook.fn, readonlyCopy(entry), options, this.theme));
  }
  transformMarkdown(text: string, context: MarkdownTransformContext): string {
    for (const hook of this.markdown) if (hook.owner.enabled) {
      const transformed = this.call(`markdown ${hook.owner.path}`, hook.fn, text, readonlyCopy(context));
      if (typeof transformed === 'string') text = transformed;
    }
    return text;
  }
}
