import assert from 'node:assert/strict';
import test from 'node:test';
import { audit, references } from '../scripts/check-references.mjs';

const files = object => new Map(Object.entries(object));

test('real missing imports, exports, dynamic literal imports and module URLs fail', () => {
  const source = [
    'import "./missing.mjs";', 'export * from "./missing.mjs";',
    'await import("./missing.mjs");', 'new URL("./missing.json", import.meta.url);',
  ].join('\n');
  const result = audit(files({ 'scripts/a.mjs': source }));
  assert.equal(result.errors.length, 4);
});

test('quoted, template and commented synthetic code is not a module dependency', () => {
  const source = [
    '// import "./absent.js";',
    'const one = \'import "./absent.js";\';',
    'const two = `import "./absent.js"; ${1}`;',
    'const three = `new URL("./absent.json", import.meta.url)`;',
    '/* export * from "./absent.js"; */',
  ].join('\n');
  assert.equal(references('scripts/test.mjs', source).length, 0);
});

test('real dependencies after nested templates and inside functions are still checked', () => {
  const source = 'const text = `outer ${`inner ${1}`} end`; async function f(){ return import("./gone.mjs"); }';
  assert.equal(audit(files({ 'scripts/a.mjs': source })).errors.length, 1);
});

test('module references resolve against their own file, not a matching basename', () => {
  const source = 'import "./ok.mjs";';
  const input = files({ 'scripts/a.mjs': source, 'other/ok.mjs': '' });
  assert.equal(audit(input).errors.length, 1);
  input.set('scripts/ok.mjs', '');
  assert.equal(audit(input).errors.length, 0);
});

test('TypeScript output specifiers resolve to their tracked TypeScript inputs', () => {
  const input = files({ 'web/src/a.ts': 'import "./b.js";', 'web/src/b.ts': '' });
  assert.equal(audit(input).errors.length, 0);
  input.delete('web/src/b.ts');
  assert.equal(audit(input).errors.length, 1);
});

test('same URL inside an actual test is checked, not blanket-excluded', () => {
  const source = 'test("fixture", () => readFile(new URL("../missing.json", import.meta.url)));';
  assert.equal(audit(files({ 'web/test/a.mjs': source })).errors.length, 1);
});

test('known retirement assertions require absence, but a read of that path fails', () => {
  const source = 'assertRetired(new URL("../test-support/fixed-head.mjs", import.meta.url));';
  const input = files({ 'web/test/fixed-head-retirement.test.mjs': source });
  assert.equal(audit(input).errors.length, 0);
  input.set('web/test-support/fixed-head.mjs', '');
  assert.equal(audit(input).errors.length, 1);
  input.delete('web/test-support/fixed-head.mjs');
  input.set('web/test/fixed-head-retirement.test.mjs', source.replace('assertRetired', 'readFileSync'));
  assert.equal(audit(input).errors.length, 1);
});

test('exact installed inputs must exist after npm ci, with no directory wildcard', () => {
  const source = 'new URL("../node_modules/typescript/bin/tsc", import.meta.url);';
  const input = files({ 'web/scripts/assets.mjs': source });
  assert.equal(audit(input).errors.length, 1);
  assert.equal(audit(input, new Set(input.keys()), path => path === 'web/node_modules/typescript/bin/tsc').errors.length, 0);
  input.set('web/scripts/assets.mjs', source.replace('/tsc"', '/typo"'));
  assert.equal(audit(input, new Set(input.keys()), () => true).errors.length, 1);
});

test('only the named Cargo output is classified as generated', () => {
  const source = 'new URL("../target/debug/wi", import.meta.url);';
  assert.equal(audit(files({ 'scripts/cli_retest.mjs': source })).counts.generated, 1);
  assert.equal(audit(files({ 'scripts/cli_retest.mjs': source.replace('/wi"', '/typo"') })).errors.length, 1);
});

test('directory URLs resolve with trailing slashes, including the repository root', () => {
  const source = ['new URL("../../", import.meta.url);',
    'new URL("../src/", import.meta.url);', 'new URL("../e2e/", import.meta.url);'].join('\n');
  const input = files({ 'web/test/a.mjs': source, 'web/src/a.ts': '', 'web/e2e/a.mjs': '' });
  assert.equal(audit(input).errors.length, 0);
  input.set('web/test/a.mjs', 'new URL("../absent/", import.meta.url);');
  assert.equal(audit(input).errors.length, 1);
});

test('installed Playwright require inputs are checked on disk as well as URL inputs', () => {
  const input = files({
    'web/test/browser-case-diagnostics.test.mjs': 'require("../node_modules/playwright/lib/runner/taskRunner.js");',
    'web/test/browser-suite-launch.test.mjs': [
      'require("../node_modules/playwright/lib/reporters/base.js");',
      'require("../node_modules/playwright/lib/util.js");',
      'require("../node_modules/playwright/package.json");',
    ].join('\n'),
  });
  const paths = new Set(['lib/runner/taskRunner.js', 'lib/reporters/base.js', 'lib/util.js', 'package.json']
    .map(path => `web/node_modules/playwright/${path}`));
  assert.equal(audit(input, new Set(input.keys()), path => paths.has(path)).errors.length, 0);
  assert.equal(audit(input).errors.length, 4);
});
