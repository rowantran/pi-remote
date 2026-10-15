import { createWriteStream } from 'node:fs';
import { bundlePresentation } from './presentation-bundle.js';

// The parent owns the deadline and all output bounds. fd 3 is a private result channel;
// trusted factories may log to stdout/stderr without corrupting the result protocol.
async function send(value: unknown): Promise<void> {
  const output = createWriteStream('', { fd: 3 });
  await new Promise<void>((accept, reject) => {
    output.once('error', reject);
    output.end(JSON.stringify(value), accept);
  });
}
async function main(): Promise<void> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    if ((size += data.length) > 128 * 1024) throw new Error('Presentation worker request exceeds limit');
    chunks.push(data);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { extensions: string[] };
  // Trace keys describe this machine's real home, not the browser's virtual home option.
  const result = await bundlePresentation(request.extensions);
  if (Buffer.byteLength(result.bundle) > 8 * 1024 * 1024) throw new Error('Presentation bundle exceeds limit');
  await send({ ok: true, result });
}

try { await main(); process.exit(0); }
catch (error) {
  await send({ ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 16 * 1024) });
  process.exit(1);
}
