import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const layers: Record<string, string[]> = {
  config: [], protocol: [], daemon: ['protocol'], client: ['protocol'], tui: ['protocol', 'config'],
  'web/shared': [],
  'web/server': ['daemon', 'client', 'protocol', 'config', 'web/shared'],
  'web/build': ['tui', 'protocol', 'web/shared'],
  cli: ['daemon', 'client', 'tui', 'web/server', 'protocol', 'config'],
};

// Compile tiny probes with the real project configurations: the listener cannot
// load terminal/build code, and the builder cannot load server code.
test('project references allow composition and reject cross-layer source imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-layers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['tsconfig.json', 'tsconfig.base.json']) {
    await writeFile(join(root, name), await readFile(join(repo, name)));
  }
  const modulePath = (from: string, to: string) => {
    const path = relative(join(root, 'src', from), join(root, 'src', to, 'index.js'));
    return path.startsWith('.') ? path : `./${path}`;
  };
  for (const [layer, dependencies] of Object.entries(layers)) {
    const dir = join(root, 'src', layer);
    await mkdir(dir, { recursive: true });
    const config = JSON.parse(await readFile(join(repo, 'src', layer, 'tsconfig.json'), 'utf8'));
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(config));
    await writeFile(join(dir, 'index.ts'), dependencies.map(name => `import '${modulePath(layer, name)}';`).join('\n') + '\nexport const value = true;\n');
  }
  const diagnostics: ts.Diagnostic[] = [];
  const host = ts.createSolutionBuilderHost(ts.sys, undefined, diagnostic => { diagnostics.push(diagnostic); }, () => {});
  const format = () => ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: file => file,
    getNewLine: () => ts.sys.newLine,
  });
  const build = () => {
    diagnostics.length = 0;
    return ts.createSolutionBuilder(host, [join(root, 'tsconfig.json')], { force: true }).build();
  };
  assert.equal(build(), ts.ExitStatus.Success, format());
  for (const [from, to] of [
    ['client', 'tui'], ['daemon', 'client'], ['tui', 'daemon'], ['protocol', 'daemon'],
    ['protocol', 'config'], ['config', 'protocol'],
    ['protocol', 'web/shared'], ['config', 'web/shared'], ['daemon', 'web/shared'], ['client', 'web/shared'], ['tui', 'web/shared'],
    ['web/shared', 'config'], ['web/shared', 'protocol'], ['web/shared', 'daemon'], ['web/shared', 'client'], ['web/shared', 'tui'],
    ['web/shared', 'web/server'], ['web/shared', 'web/build'],
    ['web/server', 'tui'], ['web/server', 'web/build'], ['client', 'web/server'], ['daemon', 'web/server'],
    ['web/build', 'web/server'],
  ]) {
    const file = join(root, 'src', from!, 'forbidden.ts');
    await writeFile(file, `import '${modulePath(from!, to!)}';\n`);
    assert.notEqual(build(), ts.ExitStatus.Success, `${from} must not import ${to}`);
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === 6059 || diagnostic.code === 6307), format());
    await rm(file);
  }
});
