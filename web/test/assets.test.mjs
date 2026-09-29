import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAssets } from '../scripts/assets.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wi-assets-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(new URL('../tsconfig.json', import.meta.url), join(root, 'tsconfig.json'));
  put(root, 'src/app.ts', "import { label } from './nested/label.js';\nexport const title: string = label;\n");
  put(root, 'src/nested/label.ts', "export const label: string = 'Wi';\n");
  return root;
}

function put(root, name, content) {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function snapshot(directory) {
  if (!existsSync(directory)) return null;
  const files = [];
  function visit(relative) {
    const path = join(directory, relative);
    const info = lstatSync(path);
    const entry = { name: relative, mtime: info.mtimeMs, inode: info.ino };
    if (info.isDirectory()) {
      files.push(entry);
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else {
      files.push({ ...entry, bytes: readFileSync(path) });
    }
  }
  visit('');
  return files;
}

function noStaging(root) {
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('.assets-')), []);
}

test('build publishes the complete nested module set and removes obsolete output', t => {
  const root = fixture(t);
  put(root, 'dist/obsolete.js', 'old output');
  assert.equal(runAssets('build', root), 'Built 2 generated asset(s).');
  assert.deepEqual(snapshot(join(root, 'dist')).map(entry => entry.name), [
    '', 'app.js', 'nested', 'nested/label.js',
  ]);
  assert.match(readFileSync(join(root, 'dist/app.js'), 'utf8'), /from '\.\/nested\/label\.js'/);
  noStaging(root);
});

test('typecheck emits no files', t => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.equal(runAssets('typecheck', root), 'TypeScript typecheck passed.');
  assert.deepEqual(snapshot(root), before);
});

test('verification compares matching output without replacing or changing assets', t => {
  const root = fixture(t);
  runAssets('build', root);
  const before = snapshot(join(root, 'dist'));
  const entries = readdirSync(root).sort();
  assert.equal(runAssets('verify', root), 'Verified 2 generated asset(s).');
  assert.deepEqual(snapshot(join(root, 'dist')), before);
  assert.deepEqual(readdirSync(root).sort(), entries);
  noStaging(root);
});

test('a deliberate type error cannot publish changed, new, or partial assets', t => {
  const root = fixture(t);
  runAssets('build', root);
  const before = snapshot(join(root, 'dist'));
  put(root, 'src/nested/label.ts', "export const label: string = 'Changed';\n");
  put(root, 'src/new.ts', 'export const added = true;\n');
  put(root, 'src/invalid.ts', 'export const invalid: string = 42;\n');
  for (const mode of ['build', 'verify', 'typecheck']) {
    assert.throws(() => runAssets(mode, root), /TS2322/);
    assert.deepEqual(snapshot(join(root, 'dist')), before);
    noStaging(root);
  }
});

test('a type error on the first build leaves dist absent', t => {
  const root = fixture(t);
  put(root, 'src/invalid.ts', 'export const invalid: string = 42;\n');
  assert.throws(() => runAssets('build', root), /TS2322/);
  assert.equal(existsSync(join(root, 'dist')), false);
  noStaging(root);
});

test('verification reports stale, missing, and extra files without repairing output', t => {
  const root = fixture(t);
  runAssets('build', root);
  const app = readFileSync(join(root, 'dist/app.js'));
  // A same-length byte change must fail even when the file inventory still matches.
  app[0] ^= 1;
  put(root, 'dist/app.js', app);
  rmSync(join(root, 'dist/nested/label.js'));
  // These files have no Git entry, and the verifier must not filter by extension.
  put(root, 'dist/untracked.js', 'extra');
  put(root, 'dist/nested/extra.txt', 'extra');
  put(root, 'dist/.hidden', 'extra');
  const before = snapshot(join(root, 'dist'));
  assert.throws(() => runAssets('verify', root), error => {
    assert.equal(error.message, [
      'Generated assets differ:',
      'stale: app.js',
      'missing: nested/label.js',
      'extra: .hidden',
      'extra: nested/extra.txt',
      'extra: untracked.js',
    ].join('\n'));
    return true;
  });
  assert.deepEqual(snapshot(join(root, 'dist')), before);
  noStaging(root);
});

test('verification reports a missing dist directory without creating it', t => {
  const root = fixture(t);
  assert.throws(() => runAssets('verify', root), error => {
    assert.equal(error.message, 'Generated assets differ:\nmissing: app.js\nmissing: nested/label.js');
    return true;
  });
  assert.equal(existsSync(join(root, 'dist')), false);
  noStaging(root);
});

test('verification rejects symlink output instead of following it', t => {
  const root = fixture(t);
  runAssets('build', root);
  symlinkSync(join(root, 'src/app.ts'), join(root, 'dist/link.js'));
  assert.throws(() => runAssets('verify', root), /nonregular entry: link\.js/);
  assert.ok(lstatSync(join(root, 'dist/link.js')).isSymbolicLink());
  noStaging(root);
});
