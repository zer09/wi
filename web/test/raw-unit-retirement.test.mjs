import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const retired = ['client-fixtures.mjs', 'client.test.mjs', 'client-commands.test.mjs', 'client-races.test.mjs',
  'state.test.mjs', 'state-transitions.test.mjs', 'view.test.mjs', 'view-render.test.mjs'].map(name => join(root, 'test', name));
const read = file => readFileSync(file, 'utf8');
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const controls = [
  { file: 'display-api.test.mjs', module: '../dist/display-api.js', names: ['validateConversationPage'], titles: [
    'C1 reconciliation checks identities and exact body, not first+1/raw proof',
    'C1 snapshots enforce head/header/anchor/resource consistency and ordered nonhuman entries',
  ] },
  { file: 'display-client.test.mjs', module: '../dist/display-client.js', names: ['createDisplayClient'], titles: [
    'requests keep bearer only in headers and exact same-origin protected init',
    'fresh connection401 clears memory; invalid Connect cannot fetch',
    'Send publishes immutable pending before await, protects duplicate submit and uses exact original retry body',
    'acceptance commit unknown retains frozen original command and edited draft until Disconnect clears bookkeeping',
    '202 cleanup warning/notices survive rebase; receipt proves acceptance without range proof',
    'failed explicit fresh-Latest rebase retains stale window, draft and pending identity; no retry or cancel',
    'explicit Cancel alone posts empty body for server active state; disconnect only stops reader',
  ] },
  { file: 'display-store.test.mjs', module: '../dist/display-store.js', names: ['applyConversationChanges'], titles: [
    'C1 loaded snapshots contain only generic display state and deep immutable arrays',
    'C1 block and entry chronology uses BigInt not kind or timestamp',
    'C1 whole change batch rolls back later structural range and identity failures before cursor publication',
    'C1 new content epoch clears only its entry layout and stale content continuation',
  ] },
  { file: 'display-transport.test.mjs', module: '../dist/sse.js', names: ['WiConversationSseParser'], titles: [
    'display handler failure stops parsing and preserves prior publication',
    'comments and partial EOF do not publish or reconnect; multi-data is JSON whitespace',
    'raw parser rejects display event but retains its public parser surface',
  ] },
  { file: 'display-view.test.mjs', module: '../dist/display-view.js', names: ['mountDisplayView'], titles: [
    'C display renderer preserves generic hash/origin rules with no raw runtime imports',
    'C store chronology and supplied field order render one Human and no duplicated result',
    'C keyed rows keep disclosure focus and draft selection across revisions and backward merges',
    'C failed rebase retains stale window and pending/draft; disconnect clears sensitive nodes and form values',
  ] },
  { file: 'api.test.mjs', module: '../dist/api.js', names: [], titles: [
    'UUID identities match Rust canonical non-nil semantics without imposing version 4',
    'pure request helpers keep synthetic owner auth only in headers and preserve command bytes',
  ] },
  { file: 'sse.test.mjs', module: './wire-fixtures.mjs', names: [], titles: [
    'SSE fatal UTF-8 retains valid prefix even when a later bad byte shares its chunk',
    'SSE callback failure stops parsing and does not expose exception details',
  ] },
  { file: 'reload-app-realm.test.mjs', module: '../test-support/display-dom.mjs', names: ['Element'], titles: [
    'fresh actual display app realm retains hash but no token/draft/pending; explicit Connect gets matching Latest then SSE without raw replay or automatic mutation',
    'late old-realm Latest cannot install display state or attach observation after unload; new realm stays independent',
  ] },
];

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}
function references(source) {
  assert.equal(source.parseDiagnostics.length, 0, 'source must parse');
  const paths = [];
  walk(source, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) paths.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      assert.ok(ts.isStringLiteralLike(node.arguments[0]), 'module reference must be literal');
      paths.push(node.arguments[0].text);
    }
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && ts.isStringLiteralLike(node.arguments?.[0])) paths.push(node.arguments[0].text);
  });
  return paths;
}
function assertNoRetiredReference(file, text) {
  for (const reference of references(parse(file, text))) {
    if (reference.startsWith('.')) {
      const target = normalize(join(dirname(file), reference.split(/[?#]/)[0]));
      assert.equal(retired.includes(target), false, 'actual reference to retired raw unit or fixture');
    }
  }
}
function assertRetired(exists = existsSync) {
  for (const file of retired) assert.equal(exists(file), false, 'exclusive raw unit or fixture must stay retired');
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return files(file);
    return /\.(?:mjs|ts)$/.test(entry.name) ? [file] : [];
  });
}
function assertActiveGraph(directory, overrides = new Map()) {
  const pending = [join(root, directory, `app.${directory === 'src' ? 'ts' : 'js'}`)], seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    assert.equal(['client', 'state', 'view'].some(name => file === join(root, directory, `${name}.${directory === 'src' ? 'ts' : 'js'}`)), false, 'active graph reaches raw reconstruction');
    seen.add(file);
    const source = parse(file, overrides.get(file) ?? read(file));
    // Include type-only edges. A negative asset inventory string is not an import.
    for (const reference of references(source)) {
      if (!reference.startsWith('.')) continue;
      let target = normalize(join(dirname(file), reference));
      if (directory === 'src') target = target.replace(/\.js$/, '.ts');
      assert.equal(dirname(target), join(root, directory), 'active module stays in its directory');
      // Report a retired dependency even when its deleted target cannot resolve.
      assert.equal(['client', 'state', 'view'].some(name => target === join(root, directory, `${name}.${directory === 'src' ? 'ts' : 'js'}`)), false, 'active graph reaches raw reconstruction');
      assert.ok(existsSync(target), 'active dependency resolves');
      pending.push(target);
    }
  }
  for (const name of ['display-client', 'display-store', 'display-view', 'display-api', 'api', 'sse']) {
    assert.ok(seen.has(join(root, directory, `${name}.${directory === 'src' ? 'ts' : 'js'}`)), 'traverse actual active display graph');
  }
  return seen;
}
function assertControl(text, control) {
  const source = parse(control.file, text);
  assert.equal(source.parseDiagnostics.length, 0, 'retained control must parse');
  assertNoRetiredReference(join(root, 'test', control.file), text);
  const imports = source.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === control.module);
  assert.equal(imports.length, 1, 'retained control actual import');
  const bindings = imports[0].importClause?.namedBindings;
  for (const name of control.names) assert.ok(bindings && ts.isNamedImports(bindings)
    && bindings.elements.some(binding => (binding.propertyName ?? binding.name).text === name), 'retained actual API binding');
  for (const title of control.titles) {
    const calls = [];
    walk(source, node => {
      if (ts.isCallExpression(node) && /^test(?:\.|$)/.test(node.expression.getText(source)) && node.arguments[0]?.text === title) calls.push(node);
    });
    assert.equal(calls.length, 1, 'retain exact authored control');
    const call = calls[0];
    assert.equal(call.expression.getText(source), 'test', 'retained control executes normally');
    const callback = call.arguments[1];
    assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)), 'actual retained callback');
    let assertions = 0;
    walk(callback, node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'assert') assertions++;
    });
    assert.ok(assertions > 0, 'retained callback contains assertions');
  }
}

test('eight exclusive raw units and fixture stay retired without requiring raw runtime removal', () => assertRetired());
test('retirement path guard rejects each restored path without writing files', () => {
  for (const restored of retired) assert.throws(() => assertRetired(file => file === restored), /must stay retired/);
});
test('actual retained source imports and URL references do not consume retired raw units or fixture', () => {
  for (const directory of ['src', 'test', 'test-support', 'e2e', 'scripts']) {
    for (const file of files(join(root, directory))) assertNoRetiredReference(file, read(file));
  }
});
test('actual reference guard rejects finite import export dynamic require and URL consumers', () => {
  const file = join(root, 'test', 'retained.test.mjs');
  for (const removed of retired) {
    const reference = './' + removed.slice(removed.lastIndexOf('/') + 1);
    for (const text of [`import '${reference}';`, `export * from '${reference}';`, `import('${reference}');`,
      `require('${reference}');`, `new URL('${reference}', import.meta.url);`]) {
      assert.throws(() => assertNoRetiredReference(file, text), /actual reference to retired/);
    }
  }
});
test('reference positives permit negative inventories shared raw API and the retained type bridge', () => {
  const file = join(root, 'test', 'retained.test.mjs');
  assertNoRetiredReference(file, `const negativePaths = ${JSON.stringify(retired)}; import './wire-fixtures.mjs'; import '../dist/api.js';`);
  assertNoRetiredReference(join(root, 'src', 'client.ts'), "import type { ClientError } from './display-client.js'; export type { ClientError } from './display-client.js';");
});
test('active source type imports and generated static graph exclude raw client reducer and renderer', () => {
  assertActiveGraph('src'); assertActiveGraph('dist');
});
test('active graph sensitivity rejects actual raw dependencies from app controller and renderer', () => {
  for (const directory of ['src', 'dist']) for (const consumer of ['app', 'display-client', 'display-view']) for (const name of ['client', 'state', 'view']) {
    const file = join(root, directory, `${consumer}.${directory === 'src' ? 'ts' : 'js'}`);
    const text = read(file) + `\nimport './${name}.js';\n`;
    assert.throws(() => assertActiveGraph(directory, new Map([[file, text]])), /active graph reaches raw reconstruction/);
  }
  const file = join(root, 'src', 'display-view.ts');
  assert.throws(() => assertActiveGraph('src', new Map([[file, read(file) + "\nimport type { ClientSnapshot } from './client.js';\n"]])), /active graph reaches raw reconstruction/);
});
test('actual retained API framing privacy identity epoch controller and renderer controls remain normal tests', () => {
  for (const control of controls) assertControl(read(join(root, 'test', control.file)), control);
});
test('retained control sensitivity rejects missing titles skipped tests empty callbacks and wrong imports', () => {
  for (const control of controls) {
    const text = read(join(root, 'test', control.file)), source = parse(control.file, text);
    let call;
    walk(source, node => { if (ts.isCallExpression(node) && node.expression.getText(source) === 'test' && node.arguments[0]?.text === control.titles[0]) call = node; });
    assert.ok(call);
    const title = call.arguments[0], callback = call.arguments[1], callee = call.expression;
    for (const [node, replacement] of [[title, "'removed control'"], [callee, 'test.skip'], [callback, '() => {}']]) {
      const mutant = text.slice(0, node.getStart(source)) + replacement + text.slice(node.end);
      assert.throws(() => assertControl(mutant, control));
    }
    assert.throws(() => assertControl(text.replace(control.module, '../dist/state.js'), control), /retained control actual import/);
    assertControl(text + '\n// Ordinary frozen display observations remain valid.\nconst retainedObservation = Object.freeze({});\n', control);
  }
});
