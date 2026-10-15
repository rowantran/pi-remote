import type { BuildOptions } from 'esbuild';

/** Both browser bundles must exclude runtime code, including legacy package names. */
export const runtimeOnlyBrowserModule = /(?:@earendil-works|@mariozechner)\/(?:pi-agent-core|pi-ai\/(?:dist\/(?:api|auth|providers)|oauth|providers)|pi-coding-agent\/dist\/core\/(?:agent-session|extensions|tools\/(?:bash|read|edit|write|grep|find|ls|powershell)\.js))/;
export const browserBuildOptions = {
  bundle: true, format: 'esm', platform: 'browser', target: ['safari16.4', 'chrome120'],
  conditions: ['browser', 'import', 'default'], logLevel: 'silent', legalComments: 'none',
  metafile: true, write: false,
} satisfies BuildOptions;
