import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

function imports(source) {
  return ts.preProcessFile(source, true, true).importedFiles.map(entry => entry.fileName);
}
function checkImports(source) {
  for (const name of imports(source)) {
    if (name.startsWith('./') || name.startsWith('../')) {
      assert.ok(name.endsWith('.js'), 'Relative TypeScript imports must end in .js');
    }
  }
}

test('all relative TypeScript imports end in .js for browser module resolution', () => {
  const root = new URL('../src/', import.meta.url);
  for (const path of readdirSync(root, { recursive: true }).filter(path => path.endsWith('.ts'))) {
    checkImports(readFileSync(new URL(path, root), 'utf8'));
  }
});

test('import check covers static, side-effect, re-export, dynamic and type imports', () => {
  for (const reference of ['./module', '../module.ts', './module.js?query']) {
    for (const source of [
      `import { value } from '${reference}';`, `import '${reference}';`,
      `export { value } from '${reference}';`, `export * from '${reference}';`,
      `const module = import('${reference}');`, `type T = import('${reference}').T;`,
      `import type { T } from '${reference}';`,
    ]) {
      assert.deepEqual(imports(source), [reference]);
      assert.throws(() => checkImports(source), /must end in .js/);
      checkImports(source.replace(reference, './module.js'));
    }
  }
});

test('generated browser imports use existing relative .js modules', () => {
  const root = new URL('../dist/', import.meta.url);
  for (const path of readdirSync(root).filter(path => path.endsWith('.js'))) {
    const source = readFileSync(new URL(path, root), 'utf8');
    checkImports(source);
    for (const name of imports(source)) {
      assert.ok(name.startsWith('./'), 'No external or bare production import');
      assert.ok(existsSync(new URL(name, root)), 'Generated import target exists');
    }
  }
});

test('compiled protocol and view modules import without DOM, network or browser-storage access', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    for (const key of ['document', 'window', 'fetch', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB']) {
      Object.defineProperty(globalThis, key, { get() { throw new Error('unexpected global access'); } });
    }
    await import('./dist/api.js');
    await import('./dist/sse.js');
    await import('./dist/state.js');
    await import('./dist/view.js');
    const { createClient } = await import('./dist/client.js');
    const client = createClient({ crypto: null });
    client.snapshot();
    client.disconnect();
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
