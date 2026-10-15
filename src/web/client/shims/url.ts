export function fileURLToPath(url: string | URL): string {
  const value = typeof url === 'string' ? new URL(url) : url;
  if (value.protocol !== 'file:' || value.host) throw new TypeError('Expected a local file: URL');
  return decodeURIComponent(value.pathname);
}
export function pathToFileURL(path: string): URL {
  if (!path.startsWith('/')) throw new TypeError('Expected an absolute virtual path');
  return new globalThis.URL(`file://${path.split('/').map(part => encodeURIComponent(part)).join('/')}`);
}
export const URL_ = globalThis.URL;
export { URL_ as URL };
