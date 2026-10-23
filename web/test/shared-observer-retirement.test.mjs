import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as assets from '../test-support/stale-history.mjs';
import * as presentation from '../test-support/presentation.mjs';

const parse = text => ts.createSourceFile('shared.js', text, ts.ScriptTarget.Latest, true);
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const modules = {
  assets: { path: '../test-support/stale-history.mjs', exports: ['checkEmbeddedAssets'], pins: {
    checkEmbeddedAssets: '278872d9b97b60f71a6686df3a08ca9598006f59670ee0ca0613efce77a05448',
  } },
  presentation: { path: '../test-support/presentation.mjs', exports: ['answer', 'data', 'labels', 'measurement', 'skillOutput'], pins: {
    readFile: '198942038370a434c48f68d9acd73dc27ff35eafc8dca88a5eccfddf37dbb5f2',
    data: '78eb780de38ef76974be878bb3ebd1b1280e0e46ab268253907b5c6616fd3be4',
    answer: 'a8a356e55e254ac712d49345026ffcc327f50b2161457fb49834ad6fcf55c7dc',
    skillOutput: '104b8aa13ec19d5c9e4c17d4622ba3d592990f75c6fcd8b1a14598d36cc9b192',
    labels: 'f1a26808e921b1f2f9eeedc39c598c8617a477a9f45257b6e64ba7786973529c',
    timingFields: '494d745da09e8335b2044e90e7039f5046e60e9997f10445b6ed695b54f72023',
    countFields: '7ce42424dc14b8e0f2f699d8b7ea664e93a1bb7a8253bbf500c0cdee0e190968',
    measurement: 'e8b50f10c332a888afcbb36c923b14b3fef0ae932239717b1d3026ee8e1b1a2b',
  } },
};
const controls = {
  './stale-history-observer.test.mjs': {
    'asset verification compares exact bytes and reports no response data': '16f136f0a18d5bfe44515f6498bba129a444c32ecd1631d4a299a480c7cb450e',
  },
  './presentation.test.mjs': {
    'finite measurement output has exactly three closed labels and numeric fields': '29cbc1a2e8a2f25e274f5740119124e025350acaf38ecb906ad6227ee5d71161',
    'presentation bytes remain distinct inert canaries and successful skill output remains a string': '720f69e6dc737bc6c1807c3e3cef173b5f5e4d6bf65a49f3bc9150872310f855',
  },
};
const assetSpecs = ['task-account-mismatch', 'task-disconnect-epoch', 'task-incomplete-history',
  'task-selection-epoch', 'task-stale-history', 'task-unbound-history'];
const browserCases = {
  '../e2e/task-stale-history.spec.mjs': 'one Send rejects stale captured history after one real browser rename commits',
  '../e2e/presentation.spec.mjs': 'real presentation display, private boundary and finite measurements',
};
const retiredNames = ['installStaleHistoryObserver', 'localRender', 'staleHistoryCapture',
  'presentationCapture', 'wiPresentationResponse', 'createConversation', 'applyEvent', 'selectDisplay',
  'fingerprints', 'history_complete'];

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}
function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
}
function assertNoRawObserver(source) {
  assert.equal(source.parseDiagnostics.length, 0, 'shared source must parse');
  walk(source, node => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      assert.equal(retiredNames.includes(node.text), false, 'retired shared observer or replay reference');
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && /(?:^|\/)(?:presentation|stale-history)\.mjs$/.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        assert.equal(bindings.elements.some(binding => (binding.propertyName ?? binding.name).text === 'observe'), false, 'retired shared observe import');
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      assert.equal(['/assets/state.js', '/assets/view.js'].includes(node.moduleSpecifier.text), false, 'raw browser replay module');
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      assert.equal(['/assets/state.js', '/assets/view.js'].includes(node.arguments[0].text), false, 'raw browser replay module');
    }
    if (ts.isCallExpression(node)) {
      assert.equal(['addInitScript', 'evaluateOnNewDocument', 'exposeBinding', 'clone'].includes(propertyName(node.expression)), false, 'raw shared browser capture');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left, object = target.expression, name = propertyName(target);
      const global = object && ts.isIdentifier(object) && ['globalThis', 'window', 'self'].includes(object.text);
      const globalObject = object && (ts.isPropertyAccessExpression(object) || ts.isElementAccessExpression(object))
        && ts.isIdentifier(object.expression) && ['globalThis', 'window', 'self'].includes(object.expression.text)
        && propertyName(object) === 'Object';
      // Reading frozen values is valid. Replacing globals would restore the retired capture.
      assert.equal((ts.isIdentifier(target) && target.text === 'fetch') || (global && name === 'fetch')
        || (name === 'freeze' && ((object && ts.isIdentifier(object) && object.text === 'Object') || globalObject)), false, 'raw shared global replacement');
    }
  });
}
function assertSharedModule(source, family) {
  assertNoRawObserver(source);
  const exported = [];
  for (const node of source.statements) {
    if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(node)) exported.push(node.name?.text);
      else if (ts.isVariableStatement(node)) exported.push(...node.declarationList.declarations.map(declaration => declaration.name.getText(source)));
    }
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) assert.fail('unexpected shared export forwarding');
  }
  assert.deepEqual(exported.sort(), modules[family].exports, 'retained shared exports only');
  // Pin the retained AST text, not the surrounding removed comments or line numbers.
  for (const [name, digest] of Object.entries(modules[family].pins)) {
    const nodes = source.statements.filter(node => node.name?.text === name
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === name))
      || (name === 'readFile' && ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'node:fs/promises'));
    assert.equal(nodes.length, 1, 'retained shared declaration');
    assert.equal(hash(nodes[0].getText(source)), digest, 'retained shared AST bytes');
  }
}
function assertControls(source, expected) {
  assertNoRawObserver(source);
  const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && /^test(?:\.|$)/.test(node.expression.expression.getText(source)));
  assert.deepEqual(cases.map(node => node.expression.arguments[0]?.text), Object.keys(expected), 'retained unit titles only');
  for (const node of cases) {
    assert.equal(node.expression.expression.getText(source), 'test', 'retained control executes normally');
    assert.equal(hash(node.getText(source)), expected[node.expression.arguments[0].text], 'retained control AST bytes');
  }
}
function assertImport(source, module, names) {
  const imports = source.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === module);
  assert.equal(imports.length, 1, 'actual retained shared import');
  const bindings = imports[0].importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings), 'actual named shared import');
  assert.deepEqual(bindings.elements.map(binding => (binding.propertyName ?? binding.name).text).sort(), [...names].sort(), 'actual shared import bindings');
}
function assertAssetConsumer(source) {
  assertNoRawObserver(source);
  assertImport(source, modules.assets.path, ['checkEmbeddedAssets']);
  let calls = 0;
  walk(source, node => {
    if (ts.isCallExpression(node) && propertyName(node.expression) === 'evaluate'
      && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'checkEmbeddedAssets') calls++;
  });
  assert.equal(calls, 1, 'retained actual asset evaluation');
}
function assertBrowserCase(source, title) {
  assertNoRawObserver(source);
  const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ['test', 'test.skip', 'test.only', 'test.fixme'].includes(node.expression.expression.getText(source)));
  assert.equal(cases.length, 1, 'actual retained browser case');
  const call = cases[0].expression;
  assert.equal(call.expression.getText(source), 'test', 'actual retained browser case');
  assert.equal(call.arguments[0]?.text, title, 'retained browser title');
  const callback = call.arguments[1];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    && callback.body && ts.isBlock(callback.body), 'retained browser callback');
  const counts = { startFixture: 0, 'page.goto': 0, 'fixture.inspect': 0 };
  let cleanup = false;
  walk(callback.body, node => {
    if (ts.isTryStatement(node) && node.finallyBlock) cleanup = true;
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (Object.hasOwn(counts, name)) counts[name]++;
    }
  });
  assert.ok(counts.startFixture === 1 && counts['page.goto'] === 1 && counts['fixture.inspect'] > 0 && cleanup, 'retained browser activity and cleanup');
}

test('shared helper actual module APIs retain assets and presentation data without obsolete observers', () => {
  assert.deepEqual(Object.keys(assets), modules.assets.exports);
  assert.deepEqual(Object.keys(presentation), modules.presentation.exports);
  for (const [family, module] of Object.entries(modules)) assertSharedModule(parse(read(module.path)), family);
});
test('shared retained asset, measurement and inert unit controls keep exact executed AST text', () => {
  for (const [path, expected] of Object.entries(controls)) assertControls(parse(read(path)), expected);
});
test('six actual asset specs and presentation consumers keep their shared imports and callbacks', () => {
  for (const spec of assetSpecs) assertAssetConsumer(parse(read(`../e2e/${spec}.spec.mjs`)));
  for (const [path, title] of Object.entries(browserCases)) assertBrowserCase(parse(read(path)), title);
  for (const path of ['../e2e/presentation.spec.mjs', './presentation-evidence.test.mjs']) {
    assertImport(parse(read(path)), modules.presentation.path, ['answer', 'data', 'skillOutput']);
  }
  assertImport(parse(read('./presentation.test.mjs')), modules.presentation.path, modules.presentation.exports);
  assertImport(parse(read('./stale-history-observer.test.mjs')), modules.assets.path, modules.assets.exports);
  // This real local DOM callback is unrelated to the removed presentation export.
  assertNoRawObserver(parse(read('../e2e/display-view.spec.mjs')));
});
test('shared helper guards reject finite restored exports and retained declaration mutations', () => {
  for (const [family, module] of Object.entries(modules)) {
    const text = read(module.path);
    for (const snippet of ['export function observe() {}', 'export { observe };']) {
      assert.throws(() => assertSharedModule(parse(`${text}\n${snippet}`), family), /shared export/);
    }
    for (const name of Object.keys(module.pins)) {
      assert.throws(() => assertSharedModule(parse(text.replace(name, `${name}Changed`)), family), /retained shared/);
    }
  }
});
test('shared reference guard rejects finite retired names and actual aliased observe imports', () => {
  for (const name of retiredNames) for (const snippet of [`const value = ${name};`, `const value = '${name}';`]) {
    assert.throws(() => assertNoRawObserver(parse(snippet)), /retired shared observer or replay reference/);
  }
  for (const module of Object.values(modules)) {
    assert.throws(() => assertNoRawObserver(parse(`import { observe as local } from '${module.path}';`)), /retired shared observe import/);
  }
  for (const path of ['/assets/state.js', '/assets/view.js']) {
    assert.throws(() => assertNoRawObserver(parse(`const load = () => import('${path}');`)), /raw browser replay module/);
  }
});
test('shared raw observer guard rejects finite capture and global replacement source mutations', () => {
  const snippets = ['globalThis.fetch = replacement;', "window['fetch'] = replacement;", 'self.fetch = replacement;',
    'fetch = replacement;', 'Object.freeze = replacement;', "globalThis['Object']['freeze'] = replacement;",
    'context.addInitScript(() => {});', "page['evaluateOnNewDocument'](() => {});",
    "context.exposeBinding('capture', callback);", 'response.clone().text();'];
  for (const path of [...Object.values(modules).map(module => module.path), ...Object.keys(browserCases)]) {
    const text = read(path);
    for (const snippet of snippets) {
      assert.throws(() => assertNoRawObserver(parse(`${text}\nfunction hidden() { ${snippet} }`)), /raw shared/);
    }
  }
});
test('shared control guards reject finite filtering, title changes and weakened retained bodies', () => {
  for (const [path, expected] of Object.entries(controls)) {
    const text = read(path);
    for (const title of Object.keys(expected)) {
      for (const mode of ['skip', 'only']) {
        assert.throws(() => assertControls(parse(text.replace(`test('${title}'`, `test.${mode}('${title}'`)), expected), /retained control executes normally/);
      }
      assert.throws(() => assertControls(parse(text.replace(title, 'changed title')), expected), /retained unit titles only/);
    }
    assert.throws(() => assertControls(parse(text.replace('assert.', 'other.')), expected), /retained control AST bytes/);
  }
});
test('shared consumer guards reject finite missing imports, missing evaluation and empty browser cases', () => {
  for (const spec of assetSpecs) {
    const text = read(`../e2e/${spec}.spec.mjs`);
    assert.throws(() => assertAssetConsumer(parse(text.replace(modules.assets.path, '../test-support/other.mjs'))), /actual retained shared import/);
    assert.throws(() => assertAssetConsumer(parse(text.replace('page.evaluate(checkEmbeddedAssets', 'page.evaluate(otherAssets'))), /retained actual asset evaluation/);
  }
  for (const [path, title] of Object.entries(browserCases)) {
    const text = read(path);
    assert.throws(() => assertBrowserCase(parse(text.replace(`test('${title}'`, `test.skip('${title}'`)), title), /actual retained browser case/);
    assert.throws(() => assertBrowserCase(parse(`test('${title}', async () => {});`), title), /retained browser activity and cleanup/);
  }
  assert.throws(() => assertNoRawObserver(parse('const = ;')), /shared source must parse/);
});
test('shared guards allow ordinary frozen observations, retained modules and local DOM observe callbacks', () => {
  const snippets = ['const observe = value => Object.freeze(value); observe({ state: "recorded" });',
    'const observation = Object.isFrozen(command.body);', "const observation = Object['freeze']({ state: 'uncertain' });",
    "const load = () => import('../test-support/fixture.mjs');",
    "const forbiddenAssets = ['/assets/state.js', '/assets/view.js'];", '// observe; localRender; globalThis.fetch = replacement;'];
  for (const snippet of snippets) {
    for (const [family, module] of Object.entries(modules)) assertSharedModule(parse(`${read(module.path)}\n${snippet}`), family);
    for (const [path, title] of Object.entries(browserCases)) assertBrowserCase(parse(`${read(path)}\n${snippet}`), title);
  }
  assertNoRawObserver(parse(read('../e2e/display-view.spec.mjs')));
});
