import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const layers = ['protocol', 'daemon', 'client', 'tui', 'cli'] as const;

// Use the real project configurations with tiny source files. This checks compiler
// enforcement without modifying the checkout or depending on existing dist output.
test('project references allow composition and reject cross-layer source imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-layers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['tsconfig.json', 'tsconfig.base.json']) {
    await writeFile(join(root, name), await readFile(join(repo, name)));
  }
  for (const layer of layers) {
    const dir = join(root, 'src', layer);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tsconfig.json'), await readFile(join(repo, 'src', layer, 'tsconfig.json')));
    const dependencies = layer === 'cli' ? ['daemon', 'client', 'tui', 'protocol'] : layer === 'protocol' ? [] : ['protocol'];
    await writeFile(join(dir, 'index.ts'), dependencies.map(name => `import '../${name}/index.js';`).join('\n') + `\nexport const ${layer} = true;\n`);
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
  const initial = build();
  assert.equal(initial, ts.ExitStatus.Success, format());

  for (const [from, to] of [['client', 'tui'], ['daemon', 'client'], ['tui', 'daemon'], ['protocol', 'daemon']]) {
    await writeFile(join(root, 'src', from!, 'forbidden.ts'), `import '../${to}/index.js';\n`);
    assert.notEqual(build(), ts.ExitStatus.Success, `${from} must not import ${to}`);
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === 6059 || diagnostic.code === 6307),
      format());
    await rm(join(root, 'src', from!, 'forbidden.ts'));
  }
});
