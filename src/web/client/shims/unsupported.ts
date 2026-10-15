/** Unsupported capabilities fail when invoked; they never pretend to succeed. */
export function unavailable(name: string): never {
  throw Object.assign(new Error(`${name} is not available in the browser client`), { code: 'ERR_BROWSER_UNSUPPORTED' });
}
