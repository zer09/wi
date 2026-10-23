import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { validateEventView, validateCursor } from '../dist/api.js';
import { WiSseParser, WiConversationSseParser } from '../dist/sse.js';

const web = fileURLToPath(new URL('../', import.meta.url)), root = dirname(web.slice(0, -1));
const active = ['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'];
const raw = ['client', 'state', 'view'];
const retired = ['src/state.ts', 'src/view.ts', 'dist/state.js', 'dist/view.js'].map(file => join(web, file));
const names = ['ClientError', 'CapturedCommand', 'ClientDependencies'];
const read = file => readFileSync(file, 'utf8');
function parse(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0, 'source must parse');
  return source;
}
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function assertRetired(exists = existsSync) {
  for (const file of retired) assert.equal(exists(file), false, 'raw runtime must stay retired');
}
function assertBridge(text, generated = false) {
  const source = parse(generated ? 'client.js' : 'client.ts', text);
  assert.equal(source.statements.length, 1, 'bridge has no extra declaration or runtime');
  const node = source.statements[0];
  assert.ok(ts.isExportDeclaration(node), 'bridge is an export declaration');
  assert.ok(node.exportClause && ts.isNamedExports(node.exportClause), 'bridge uses named exports');
  if (generated) {
    assert.equal(node.moduleSpecifier, undefined, 'compiled bridge has no dependency');
    assert.equal(node.exportClause.elements.length, 0, 'compiled bridge exports no values');
  } else {
    assert.equal(node.isTypeOnly, true, 'bridge is type-only');
    assert.equal(node.moduleSpecifier.text, './display-client.js');
    assert.deepEqual(node.exportClause.elements.map(binding => binding.name.text), names);
    for (const binding of node.exportClause.elements) assert.equal(binding.propertyName, undefined, 'direct compatibility aliases');
  }
}
function assertNoRawReference(file, text) {
  const source = parse(file, text);
  function check(reference, typeOnly = false) {
    if (!reference.startsWith('.')) return;
    let target = normalize(join(dirname(file), reference.split(/[?#]/)[0]));
    if (file.startsWith(join(web, 'src') + '/')) target = target.replace(/\.js$/, '.ts');
    for (const directory of ['src', 'dist']) for (const name of raw) {
      if (target !== join(web, directory, `${name}.${directory === 'src' ? 'ts' : 'js'}`)) continue;
      assert.ok(name === 'client' && directory === 'src' && typeOnly, 'retained consumer reaches raw runtime');
    }
  }
  walk(source, node => {
    if (ts.isImportDeclaration(node)) check(node.moduleSpecifier.text, node.importClause?.isTypeOnly);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) check(node.moduleSpecifier.text, node.isTypeOnly);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal.text, true);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')
      && ts.isStringLiteralLike(node.arguments[0])) check(node.arguments[0].text);
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && ts.isStringLiteralLike(node.arguments?.[0])) check(node.arguments[0].text);
  });
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return files(file);
    return /\.(?:ts|mjs|js)$/.test(entry.name) ? [file] : [];
  });
}
function assertServer(text) {
  const paths = [...text.matchAll(/"(\/assets\/[^"\n]+\.js)"\s*=>/g)].map(match => match[1]);
  assert.deepEqual(paths, active.map(name => `/assets/${name}.js`), 'serve exactly seven active JS assets');
  const includes = [...text.matchAll(/include_bytes!\("\.\.\/\.\.\/web\/dist\/([^"\n]+)"\)/g)].map(match => match[1]);
  assert.deepEqual(includes, active.map(name => `${name}.js`), 'embedded bytes exclude the type artifact');
}
function assertNativeInventory(text) {
  const assets = text.slice(text.indexOf('const ASSETS:'), text.indexOf('const RETIRED_ASSETS:'));
  assert.deepEqual([...assets.matchAll(/"(\/assets\/[^"\n]+\.js)"/g)].map(match => match[1]), active.map(name => `/assets/${name}.js`));
  const emitted = text.match(/modules,\s*\[(.*?)\]/s);
  assert.ok(emitted, 'native emitted inventory exists');
  assert.deepEqual([...emitted[1].matchAll(/"([^"\n]+\.js)"/g)].map(match => match[1]), ['api', 'app', 'client', ...active.slice(2)].map(name => `${name}.js`));
  const retiredList = text.match(/const RETIRED_ASSETS:.*?= &\[(.*?)\];/s);
  assert.ok(retiredList, 'native retired inventory exists');
  assert.deepEqual([...retiredList[1].matchAll(/"([^"]+)"/g)].map(match => match[1]), raw.map(name => `/assets/${name}.js`));
  assert.equal(text.split('.chain(RETIRED_ASSETS.iter().copied())').length - 1, 3, 'legacy paths join GET/HEAD, method and preflight rejection loops');
}

test('four raw source and generated runtime paths stay absent', () => {
  assertRetired();
  for (const file of retired) assert.throws(() => assertRetired(candidate => candidate === file), /must stay retired/);
  assert.deepEqual(readdirSync(join(web, 'src')).sort(), ['api', 'app', 'client', ...active.slice(2)].map(name => `${name}.ts`));
  assert.deepEqual(readdirSync(join(web, 'dist')).sort(), ['api', 'app', 'client', ...active.slice(2)].map(name => `${name}.js`));
});
test('actual compatibility source and compiled artifact have no raw runtime', () => {
  assertBridge(read(join(web, 'src/client.ts')));
  assertBridge(read(join(web, 'dist/client.js')), true);
});
test('bridge guards reject finite declarations imports values and resurrected controller', () => {
  const bridge = read(join(web, 'src/client.ts'));
  for (const mutant of [bridge.replace('export type', 'export'), bridge.replace('ClientDependencies', 'PendingCommand'),
    bridge + "\nimport './state.js';", bridge + '\nexport function createClient() {}',
    bridge + '\nexport type SnapshotValue = unknown;', bridge.replace('ClientError,', 'ClientError as RawError,')]) {
    assert.throws(() => assertBridge(mutant));
  }
  for (const mutant of ["export * from './display-client.js';", "import './state.js'; export {};", 'export const createClient = () => {};']) {
    assert.throws(() => assertBridge(mutant, true));
  }
  assertBridge('// Type compatibility only.\n' + bridge);
  assertBridge('// Empty compiler artifact.\nexport {};', true);
});
test('retained actual source tooling and test consumers do not import raw runtime', () => {
  for (const directory of ['src', 'dist', 'test', 'test-support', 'scripts', 'e2e']) {
    for (const file of files(join(web, directory))) assertNoRawReference(file, read(file));
  }
  // The subprocess program is executable tooling, not a negative inventory string.
  const file = join(web, 'test/protocol-tooling.test.mjs'), source = parse(file, read(file));
  const programs = [];
  walk(source, node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'spawnSync') {
      const script = node.arguments[1].elements[2];
      assert.ok(ts.isNoSubstitutionTemplateLiteral(script));
      programs.push(script.text);
    }
  });
  assert.equal(programs.length, 1, 'retain the lazy compiled-import smoke');
  assertNoRawReference(join(web, 'smoke.mjs'), programs[0]);
  for (const name of active.filter(name => name !== 'app')) assert.ok(programs[0].includes(`./dist/${name}.js`));
  assert.match(programs[0], /createDisplayClient\(\{ crypto: null \}\)/);
  assert.match(programs[0], /client\.snapshot\(\);\s*client\.disconnect\(\);/);
});
test('consumer guard rejects finite actual raw paths but permits shared API and negative inventories', () => {
  const file = join(web, 'test/control.mjs');
  for (const name of raw) for (const expression of ["import '../dist/NAME.js';", "export * from '../dist/NAME.js';",
    "import('../dist/NAME.js');", "require('../dist/NAME.js');", "new URL('../dist/NAME.js', import.meta.url);"]) {
    assert.throws(() => assertNoRawReference(file, expression.replace('NAME', name)), /reaches raw runtime/);
  }
  assertNoRawReference(file, "const rejected = ['/assets/state.js', '/assets/view.js', '/assets/client.js']; import '../dist/api.js';");
  assertNoRawReference(join(web, 'src/control.ts'), "import type { ClientError } from './client.js';");
  for (const validator of [validateEventView, validateCursor, WiSseParser, WiConversationSseParser]) assert.equal(typeof validator, 'function');
});
test('server serves seven runtime modules while native checks cover eight emitted modules and protected legacy paths', () => {
  assertServer(read(join(root, 'src/http_api/assets.rs')));
  assertNativeInventory(read(join(root, 'src/http_api/router/tests/asset_tests.rs')));
});
test('server inventory guards reject legacy resurrection and missing active or protected checks', () => {
  const server = read(join(root, 'src/http_api/assets.rs')), native = read(join(root, 'src/http_api/router/tests/asset_tests.rs'));
  for (const name of raw) assert.throws(() => assertServer(server + `\n"/assets/${name}.js" => (include_bytes!("../../web/dist/${name}.js"), "text/javascript"),`));
  assert.throws(() => assertServer(server.replace('"/assets/app.js"', '"/assets/missing.js"')));
  assert.throws(() => assertNativeInventory(native.replace('"/assets/state.js"', '"/assets/missing.js"')));
  assert.throws(() => assertNativeInventory(native.replace('.chain(RETIRED_ASSETS.iter().copied())', '')));
  assertServer(server + '\n// Unchanged raw APIs remain protected.\n');
  assertNativeInventory(native + '\n// Existing TCP assertions remain normal tests.\n');
});
