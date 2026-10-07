import { fileURLToPath } from 'node:url';

/** Node arguments that run the module `name` beside `moduleUrl`, with the same
 * extension as the caller. A source checkout runs `.ts` modules, which need the
 * local tsx loader; compiled `dist/` modules run directly. */
export function nodeModuleArgs(moduleUrl: string, name: string): string[] {
  const source = moduleUrl.endsWith('.ts');
  const path = fileURLToPath(new URL(`./${name}${source ? '.ts' : '.js'}`, moduleUrl));
  return source ? ['--import', import.meta.resolve('tsx'), path] : [path];
}
