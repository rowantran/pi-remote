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
import { type Component, type TUI, Editor, matchesKey, Text } from '@earendil-works/pi-tui';
import { WidthCache } from './width-cache.js';
import type { RecordValue, Snapshot } from './protocol.js';
import { ReadonlyHistory, readonlyCopy } from './presentation-history.js';
import { safeText } from './view.js';

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
export interface PresentationConfig { extensions: string[]; theme?: string; bell?: boolean }
export async function readPresentationConfig(
  path = resolve(homedir(), '.pi/remote-client.json'), cliExtensions: string[] = [],
): Promise<PresentationConfig> {
  let config: RecordValue = {};
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.extensions !== undefined && (!Array.isArray(config.extensions) || config.extensions.some((p: unknown) => typeof p !== 'string' || !p)))
    || (config.theme !== undefined && typeof config.theme !== 'string')
    || (config.bell !== undefined && typeof config.bell !== 'boolean')) throw new Error(`Invalid presentation config: ${path}`);
  return {
    extensions: [...new Set([
      ...(config.extensions ?? []).map((p: string) => modulePath(p, dirname(resolve(path)))),
      ...cliExtensions.map(p => modulePath(p)),
    ])], theme: config.theme, bell: config.bell,
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
/** Sanitized, immutable data from a remote string-array widget, not a local component. */
export interface RemotePresentationWidget {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: 'aboveEditor' | 'belowEditor';
}
/** pi-remote-only UI additions; these are not methods on stock Pi's ExtensionUIContext. */
export interface PresentationUIContext extends ExtensionUIContext {
  getRemoteWidget(key: string): RemotePresentationWidget | undefined;
}
export type PresentationChange = 'layout' | 'transcript';
export interface PresentationHostOptions {
  snapshot: () => Snapshot;
  tui: TUI;
  theme?: () => Theme;
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  invalidate: (scope: PresentationChange) => void;
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
interface ComponentRow {
  active: boolean; call?: DisposableComponent; result?: DisposableComponent;
  nativeInvalidate?: () => void; invalidate: () => void;
}
interface Hook { owner: Owner; fn: (...args: any[]) => any }
interface Owner { path: string; enabled: boolean }
const DISPLAY_EVENTS = new Set([
  'session_start', 'session_shutdown', 'session_switch', 'session_tree', 'session_compact',
  'session_info_changed', 'model_select', 'thinking_level_select', 'agent_start', 'agent_end',
  'agent_settled', 'message_start', 'message_update', 'tool_execution_start',
  'tool_execution_update', 'tool_execution_end',
]);

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
  workingIndicatorRevision = 0;
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
  private readonly history = new ReadonlyHistory();
  private readonly rows = new Map<string, ToolRow>();
  private readonly componentRows = new Map<string, ComponentRow>();
  private readonly componentContexts = new WeakMap<object, ComponentRow>();
  private readonly loaded = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly disabled = new WeakSet<Function>();
  private readonly guardedComponents = new WeakMap<object, DisposableComponent>();
  private readonly failedComponents = new WeakSet<object>();
  private readonly originalComponents = new WeakMap<object, DisposableComponent>();
  private _rendererRevision = 0;
  /** Changes when transcript registrations change; cached Pi components must be recreated. */
  get rendererRevision(): number { return this._rendererRevision; }
  /** A stable bridge for Pi's public user/assistant message components. */
  readonly markdownTransformers: readonly MarkdownTransformer[] = [
    (text, context) => this.transformMarkdown(text, context),
  ];
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
  private changed(scope: PresentationChange = 'layout'): void { if (!this.stopped) this.options.invalidate(scope); }
  private renderersChanged(): void { this._rendererRevision++; this.changed('transcript'); }
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
      } catch (error) {
        owner.enabled = false; this.renderersChanged(); this.report(resolved, error);
      }
    }
    this.changed();
  }
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true; await this.dispatch({ type: 'session_start', reason: 'startup' });
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
    await this.dispatch({ type: 'session_shutdown', reason: 'quit' }); this.stopped = true;
    this.footer?.dispose?.(); this.header?.dispose?.();
    for (const widget of this.widgets.values()) widget.component.dispose?.();
    this.retainToolCalls([]); this.branchListeners.clear(); this.bus.clear();
    this.history.dispose();
  }
  async command(name: string, args = ''): Promise<boolean> {
    const hook = this.commands.get(name.replace(/^\//, ''));
    if (!hook || this.stopped) return false;
    await this.invoke(hook, args, this.context); this.changed('transcript'); return true;
  }
  get commandNames(): string[] { return [...this.commands.keys()]; }
  hasShortcut(data: string): boolean { return !this.stopped && [...this.shortcuts.keys()].some(key => matchesKey(data, key as any)); }
  async shortcut(data: string): Promise<boolean> {
    if (this.stopped) return false;
    for (const [key, hook] of this.shortcuts) {
      if (matchesKey(data, key as any)) { await this.invoke(hook, this.context); this.changed('transcript'); return true; }
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
        this.renderersChanged();
      },
      registerToolRenderer: (fn: ToolRendererResolver) => { this.resolvers.push(hook(fn)); this.renderersChanged(); },
      registerMessageRenderer: (name: string, fn: MessageRenderer) => { this.messages.set(name, hook(fn)); this.renderersChanged(); },
      registerEntryRenderer: (name: string, fn: EntryRenderer) => { this.entries.set(name, hook(fn)); this.renderersChanged(); },
      registerMarkdownTransformer: (fn: MarkdownTransformer) => { this.markdown.push(hook(fn)); this.renderersChanged(); },
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
        this.changed('transcript');
      },
      getRemoteWidget: (key: string): RemotePresentationWidget | undefined => {
        // Read remote state even when a local widget overrides this key. A clear event can
        // remain in the client's UI list until its next full snapshot; treat it as absent.
        const record = this.snapshot.ui.find(item => item.method === 'setWidget' && item.widgetKey === key);
        if (!Array.isArray(record?.widgetLines) || record.widgetLines.length === 0
          || record.widgetLines.some((line: unknown) => typeof line !== 'string')) return undefined;
        // A component's render() must return one terminal row per string. Text widgets
        // accept embedded newlines/tabs, but passing those straight to a custom component
        // can bypass width checks and move the terminal cursor unexpectedly.
        const lines = record.widgetLines.flatMap((line: string) =>
          safeText(line).replace(/\t/g, ' ').split(/[\n\u2028\u2029]/));
        return readonlyCopy({ key, lines,
          placement: record.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' });
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
      setWorkingIndicator: (options?: RecordValue) => {
        this.workingIndicator = options; this.workingIndicatorRevision++; this.changed();
      },
      setHiddenThinkingLabel: (label?: string) => { this.hiddenThinkingLabel = label; this.changed(); },
    };
    const sessionManager = this.restricted({
      getEntries: () => this.history.getEntries(this.snapshot),
      getBranch: (leafId?: string) => this.history.getBranch(this.snapshot, leafId),
      getEntry: (id: string) => this.history.getEntry(this.snapshot, id),
      getLeafId: () => this.snapshot.leafId,
      getSessionId: () => this.snapshot.state.sessionId ?? this.snapshot.slot.id,
      getSessionName: () => this.snapshot.state.sessionName ?? this.snapshot.slot.sessionName,
      getSessionFile: () => this.snapshot.slot.sessionFile,
      getCwd: () => this.snapshot.slot.cwd,
      getHeader: () => this.history.getHeader(this.snapshot),
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
    if (existing) return this.failedComponents.has(existing) ? undefined : existing;
    let failed = false;
    const widthCache = new WidthCache();
    const guarded = new Proxy(value, { get: (target, property) => {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...args: any[]) => {
        if (failed && property !== 'dispose') return property === 'render' ? [] : undefined;
        try {
          const result = member.apply(target, args);
          if (property === 'dispose') widthCache.clear();
          return property === 'render' ? widthCache.clamp(result, args[0]) : result;
        } catch (error) {
          failed = true; this.failedComponents.add(guarded); widthCache.clear(); this.report(key, error);
          // Remove only widgets using this failed component, including shared/cached
          // components. A replacement under the same key must not be removed instead.
          let removed = false;
          for (const [widgetKey, widget] of this.widgets) if (widget.component === guarded) {
            this.widgets.delete(widgetKey); removed = true;
          }
          if (removed) {
            if (property !== 'dispose') guarded.dispose?.();
            this.changed(); // The next layout shows any matching remote plain-text copy.
          }
          return property === 'render' ? [] : undefined;
        }
      };
    }, set: (target, property, value) => Reflect.set(target, property, value, target) });
    this.guardedComponents.set(value, guarded); this.guardedComponents.set(guarded, guarded);
    this.originalComponents.set(guarded, value);
    return guarded;
  }
  resolveToolRenderer(name: string, fallback?: ToolRenderers): ToolRenderers | undefined {
    const resolveAt = (index: number): ToolRenderers | undefined => {
      const hook = this.resolvers[index];
      if (!hook) return this.tools.get(name) ?? fallback;
      if (!hook.owner.enabled || this.disabled.has(hook.fn)) return resolveAt(index + 1);
      // A resolver can call next() before failing. Do not run downstream resolvers twice.
      let resolved = false;
      let next: ToolRenderers | undefined;
      const resolveNext = () => {
        if (!resolved) { resolved = true; next = resolveAt(index + 1); }
        return next;
      };
      const result = this.call(`tool resolver ${name}`, hook.fn, name, resolveNext);
      return this.disabled.has(hook.fn) ? resolveNext() : result;
    };
    return resolveAt(0);
  }
  /**
   * Render-only definitions for Pi's public ToolExecutionComponent. Pi owns renderer state,
   * previous components, invalidation, expansion, images and shell layout on this path.
   * The fallback belongs at the end of the resolver chain, so next() can discover it.
   */
  toolRenderers(name: string, fallback?: ToolRenderers): ToolRenderers | undefined {
    if (this.stopped) return undefined;
    const renderers = this.resolveToolRenderer(name, fallback);
    if (!renderers) return undefined;
    const { renderShell, renderCall, renderResult } = renderers;
    // Enumerate only presentation fields, even when a resolver returns a full tool definition.
    return {
      renderShell,
      renderCall: renderCall && ((args, theme, context) => {
        const safeArgs = readonlyCopy(args);
        const row = this.componentRow(name, context);
        return this.toolComponent(row, 'call', `tool call ${name}`, renderCall,
          safeArgs, theme, this.componentContext(row, context, safeArgs));
      }),
      renderResult: renderResult && ((result, options, theme, context) => {
        const row = this.componentRow(name, context);
        return this.toolComponent(row, 'result', `tool result ${name}`, renderResult, readonlyCopy(result), options,
          theme, this.componentContext(row, context, readonlyCopy(context.args)));
      }),
    };
  }
  private componentRow(name: string, context: RenderContext): ComponentRow {
    if (this.stopped) throw new Error('Presentation host has stopped');
    // State identity identifies a Pi component incarnation; the host never reads or owns
    // its contents. A new component with the same call id must retire old callbacks too.
    let row = this.componentContexts.get(context.state);
    if (!row) {
      const key = `${context.toolCallId}\0${name}`;
      const previous = this.componentRows.get(key);
      if (previous) this.releaseComponentRow(previous);
      row = { active: !this.stopped, invalidate: () => {
        if (row!.active && !this.stopped) row!.nativeInvalidate?.();
      } };
      this.componentContexts.set(context.state, row);
      this.componentRows.set(key, row);
    }
    if (row.active) row.nativeInvalidate = context.invalidate;
    return row;
  }
  private componentContext(row: ComponentRow, context: RenderContext, args: unknown): RenderContext {
    return {
      ...context, args, invalidate: row.invalidate,
      // Keep component identity transparent to renderers that reuse their original instance.
      lastComponent: context.lastComponent && (this.originalComponents.get(context.lastComponent) ?? context.lastComponent),
    };
  }
  private releaseComponentRow(row: ComponentRow): void {
    row.active = false; row.nativeInvalidate = undefined;
    for (const component of new Set([row.call, row.result])) component?.dispose?.();
    row.call = undefined; row.result = undefined;
  }
  private toolComponent(row: ComponentRow, slot: 'call' | 'result', key: string,
    renderer: (...args: any[]) => Component, ...args: any[]): Component {
    if (!row.active || this.stopped) throw new Error('Presentation tool row has been removed');
    const component = this.component(key, this.call(key, renderer, ...args));
    const previous = row[slot];
    row[slot] = component;
    const other = row[slot === 'call' ? 'result' : 'call'];
    if (previous !== component && previous !== other) previous?.dispose?.();
    if (component) return component;
    if (!this.disabled.has(renderer)) {
      this.disabled.add(renderer); this.report(key, 'Renderer did not return a component');
    }
    // Pi catches renderer factory failures and supplies its standard fallback. Returning
    // undefined here instead would leave Pi holding an invalid component until render time.
    throw new Error(`${key} is unavailable`);
  }
  /** Guarded callback for Pi's public CustomMessageComponent, using Pi's supplied theme. */
  messageRenderer(customType: string): MessageRenderer | undefined {
    const hook = this.messages.get(customType);
    if (!hook?.owner.enabled || this.stopped) return undefined;
    return (message, options, theme) => {
      if (!hook.owner.enabled || this.stopped) return undefined;
      return this.component(`message ${customType}`,
        this.call(`message ${customType}`, hook.fn, readonlyCopy(message), options, theme));
    };
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
    for (const [key, row] of this.componentRows) if (!keep.has(key.split('\0')[0])) {
      this.releaseComponentRow(row); this.componentRows.delete(key);
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
