import { resolve } from 'node:path';
import type { Message } from 'esbuild';
import { buildWeb } from '../src/web/build/app.js';

const entry = process.argv[2];
buildWeb(entry ? { entry: resolve(entry), outdir: resolve(import.meta.dirname, '../dist/web-probe'), minify: false } : {})
  .then(() => console.log('Built browser client'))
  .catch(error => {
    console.error(error.errors?.slice(0, 40).map((e: Message) => `${e.location?.file}:${e.location?.line} ${e.text}`).join('\n') ?? error);
    process.exitCode = 1;
  });
