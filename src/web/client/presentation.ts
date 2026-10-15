import * as agent from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import * as ai from '@earendil-works/pi-ai';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import * as module from 'node:module';
import * as util from 'node:util';
import * as events from 'node:events';
import * as buffer from 'node:buffer';
import * as perfHooks from 'node:perf_hooks';
import * as jiti from './shims/jiti.js';
import { presentationRegistry } from './shims/globals.js';
import type { VirtualFiles } from './shims/vfs.js';
import { readPresentationConfig, type PresentationFactoryEntry } from '../../tui/presentation.js';
import { readPiDoubleEscapeAction, readPiHideThinkingBlock, readPiThemeSetting } from '../../tui/local-theme.js';
import type { TuiOptions } from '../../tui/tui.js';
import { applyBrowserAppearance, readBrowserAppearance } from './appearance.js';

export interface BrowserPresentationConfig extends VirtualFiles { presentation?: { hash: string }; presentationError?: string }
export interface BrowserPresentationBundle {
  factories: readonly PresentationFactoryEntry[];
  dynamic?: Record<string, any>;
  traceHome?: string;
}
let factories: readonly PresentationFactoryEntry[] = [];
export let presentationWarning: Error | undefined;

/** Both bundles use these exact module instances, including Pi's theme singleton and classes. */
export function installPresentationRegistry(): void {
  const registry = presentationRegistry();
  const modules: Record<string, Record<string, any>> = {
    '@earendil-works/pi-coding-agent': agent, '@earendil-works/pi-tui': tui, '@earendil-works/pi-ai': ai,
    '@earendil-works/pi-ai/compat': ai, jiti,
    'file:///__pi_browser__/modes/interactive/components/custom-entry.js': { CustomEntryComponent: (agent as any).CustomEntryComponent },
    '/__pi_browser__/modes/interactive/components/custom-entry.js': { CustomEntryComponent: (agent as any).CustomEntryComponent },
    fs, 'fs/promises': fsPromises, os, path, url, crypto, module, util, events, buffer, perf_hooks: perfHooks,
    process: { ...registry.globals.process, default: registry.globals.process },
  };
  for (const [specifier, namespace] of Object.entries(modules)) {
    registry.modules[specifier] = namespace;
    if (specifier.startsWith('@earendil-works/')) registry.modules[specifier.replace('@earendil-works/', '@mariozechner/')] = namespace;
    else if (!specifier.includes('/') && specifier !== 'jiti' || specifier === 'fs/promises') registry.modules[`node:${specifier}`] = namespace;
  }
  registry.import = specifier => jiti.createJiti().import(specifier);
}

/** A failed adapter never blocks attaching to the remote session or falls back to eval. */
export async function loadBrowserPresentation(
  config: BrowserPresentationConfig,
  notify: (error: unknown) => void,
  importer: (url: string) => Promise<BrowserPresentationBundle> = url => import(/* @vite-ignore */ url),
): Promise<void> {
  installPresentationRegistry();
  const registry = presentationRegistry();
  factories = [];
  presentationWarning = undefined;
  registry.dynamic = Object.create(null);
  registry.traceHome = undefined;
  if (config.presentationError) {
    presentationWarning = new Error(config.presentationError);
    notify(presentationWarning);
    return;
  }
  if (!config.presentation) return;
  try {
    const { hash } = config.presentation;
    if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error('Invalid presentation bundle hash');
    const bundle = await importer(`/api/presentation.js?v=${encodeURIComponent(hash)}`);
    if (!Array.isArray(bundle.factories) || bundle.factories.some(entry => typeof entry !== 'function'
      && (!entry || typeof entry.path !== 'string' || typeof entry.factory !== 'function'))) {
      throw new Error('Presentation bundle must export extension factories');
    }
    if (bundle.dynamic !== undefined && (!bundle.dynamic || typeof bundle.dynamic !== 'object' || Array.isArray(bundle.dynamic))) {
      throw new Error('Invalid bundled presentation modules');
    }
    registry.traceHome = typeof bundle.traceHome === 'string' ? bundle.traceHome : undefined;
    registry.dynamic = Object.fromEntries(Object.entries(bundle.dynamic ?? {}).map(([key, value]) => [jiti.presentationModuleKey(key), value]));
    factories = bundle.factories;
  } catch (error) {
    registry.dynamic = Object.create(null);
    registry.traceHome = undefined;
    presentationWarning = new Error(`Phone presentation unavailable; using built-in display. ${error instanceof Error ? error.message : String(error)}`);
    notify(presentationWarning);
  }
}

/** Shared by the saved read-only preview and live session, not hardcoded phone preferences. */
export async function browserPresentationOptions(notify: (error: unknown) => void = () => {}): Promise<TuiOptions> {
  const config = await readPresentationConfig();
  const selection = config.theme ?? await readPiThemeSetting() ?? 'system';
  let appearance;
  try { appearance = readBrowserAppearance(selection); }
  catch (error) {
    presentationWarning = new Error(`Phone theme unavailable; using system colors. ${error instanceof Error ? error.message : String(error)}`);
    notify(presentationWarning);
    appearance = readBrowserAppearance();
  }
  applyBrowserAppearance(appearance);
  return {
    theme: appearance.theme, appearance: appearance.appearance, bell: config.bell,
    hideThinkingBlock: await readPiHideThinkingBlock(), doubleEscapeAction: await readPiDoubleEscapeAction(),
    presentationFactories: factories,
  };
}
export function browserTerminalTheme(): ReturnType<typeof readBrowserAppearance>['terminal'] {
  const root = document.documentElement.style;
  return { background: root.getPropertyValue('--app-bg') || '#161616', foreground: root.getPropertyValue('--app-fg') || '#dedede', cursor: root.getPropertyValue('--app-fg') || '#dedede' };
}
