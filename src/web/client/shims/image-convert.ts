import { getCapabilities } from '@earendil-works/pi-tui';
import { unavailable } from './vfs.js';

/** xterm.js has no Kitty image protocol. Pi renders its normal image text fallback. */
export function ensurePngTranscoder(_onRegistered: () => void): void {
  if (getCapabilities().images === 'kitty') unavailable('Native terminal image transcoding');
}
export async function loadPngTranscoder(): Promise<never> { return unavailable('Native terminal image transcoding'); }
export async function convertImageBytesToPng(_bytes: Uint8Array): Promise<never> { return unavailable('Native image transcoding'); }
export async function convertToPng(data: string, mimeType: string): Promise<{ data: string; mimeType: string }> {
  if (mimeType !== 'image/png') unavailable('Native image transcoding');
  return { data, mimeType };
}
