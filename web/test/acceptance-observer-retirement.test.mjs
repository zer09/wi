import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const titles = {
  unknown:'one Send keeps an acceptance commit unknown before COMMIT uncertain without retry',
  warning:'one Send accepts a committed cleanup warning without provider work or false completion',
};
const retiredNames = ['installAcceptanceUnknownObserver','installAcceptanceWarningObserver',
  'acceptanceUnknownCapture','acceptanceWarningCapture'];
const parse = text => ts.createSourceFile('acceptance.js',text,ts.ScriptTarget.Latest,true);

function assertRetired(url) {
  assert.equal(existsSync(url),false,'exclusive raw acceptance observer file must stay retired');
}
function assertNoObserverReference(source) {
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      assert.equal(/(?:^|\/)acceptance-(?:unknown|warning)(?:-observer\.test)?\.mjs(?:[?#].*)?$/.test(node.text),false,'retired acceptance module reference');
    }
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      assert.equal(retiredNames.includes(node.text),false,'retired acceptance observer or capture reference');
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
}
function assertNoRawInstrumentation(source,family,title) {
  assert.equal(source.parseDiagnostics.length,0,'acceptance browser source must parse');
  const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ['test','test.skip','test.only','test.fixme'].includes(node.expression.expression.getText(source)));
  assert.equal(cases.length,1,'guard the actual retained acceptance browser case');
  const call = cases[0].expression;
  assert.equal(call.expression.getText(source),'test','guard the actual retained acceptance browser case');
  assert.equal(call.arguments[0]?.text,title,'guard the retained acceptance browser title');
  const callback = call.arguments[1];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    && callback.body && ts.isBlock(callback.body),'acceptance browser callback');
  let starts = 0, navigations = 0, inspections = 0, replies = 0, arms = 0;
  function activity(node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (name === 'startFixture') starts++;
      if (name === 'page.goto') navigations++;
      if (name === 'fixture.inspect') inspections++;
      if (name === 'response.body') replies++;
      if (name === 'fixture.request' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        if (node.arguments[0].properties.some(property => ts.isPropertyAssignment(property)
          && property.name.getText(source) === 'command' && ts.isStringLiteralLike(property.initializer)
          && property.initializer.text === `arm_acceptance_${family}`)) arms++;
      }
    }
    ts.forEachChild(node,activity);
  }
  activity(callback.body);
  assert.ok(callback.body.statements.some(node => ts.isTryStatement(node) && node.finallyBlock)
    && starts === 1 && navigations === 1 && inspections > 0 && replies > 0 && arms === 1,'retained acceptance callback activity');
  function visit(node) {
    if (ts.isCallExpression(node)) {
      assert.equal(['addInitScript','evaluateOnNewDocument','newCDPSession','newBrowserCDPSession','connectOverCDP'].includes(propertyName(node.expression)),false,'raw browser instrumentation');
    }
    if (ts.isStringLiteralLike(node)) {
      assert.equal(/^(?:Network|Fetch|IO)\./.test(node.text),false,'raw CDP instrumentation');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left, name = propertyName(target);
      const object = target.expression;
      const global = object && ts.isIdentifier(object) && ['globalThis','window','self'].includes(object.text);
      const globalObject = object && (ts.isPropertyAccessExpression(object) || ts.isElementAccessExpression(object))
        && ts.isIdentifier(object.expression) && ['globalThis','window','self'].includes(object.expression.text)
        && propertyName(object) === 'Object';
      // Frozen observations are valid. Replacing globals would restore the retired observer.
      assert.equal((ts.isIdentifier(target) && target.text === 'fetch') || (global && name === 'fetch')
        || (name === 'freeze' && ((object && ts.isIdentifier(object) && object.text === 'Object') || globalObject)),false,'raw global replacement');
    }
    ts.forEachChild(node,visit);
  }
  // Check module helpers too, not only the retained callback.
  visit(source);
}

for (const [family,title] of Object.entries(titles)) {
  const text = readFileSync(new URL(`../e2e/task-acceptance-${family}.spec.mjs`,import.meta.url),'utf8');
  const source = parse(text);
  test(`exclusive raw acceptance-${family} observer files stay retired`,() => {
    assertRetired(new URL(`../test-support/acceptance-${family}.mjs`,import.meta.url));
    assertRetired(new URL(`./acceptance-${family}-observer.test.mjs`,import.meta.url));
  });
  test(`${family} browser source cannot reference retired acceptance observers or their modules`,() => {
    assertNoObserverReference(source);
  });
  test(`actual acceptance-${family} case and module stay free of raw global instrumentation`,() => {
    assertNoRawInstrumentation(source,family,title);
  });
  test(`${family} reference guard rejects finite retired names and module spellings`,() => {
    for (const name of retiredNames) {
      for (const snippet of [`const value = ${name};`,`const value = '${name}';`]) {
        assert.throws(() => assertNoObserverReference(parse(`${text}\n${snippet}`)),/retired acceptance observer or capture reference/);
      }
    }
    for (const retired of ['unknown','warning']) {
      for (const module of [`../test-support/acceptance-${retired}.mjs`,`./acceptance-${retired}-observer.test.mjs?guard=1`]) {
        for (const snippet of [`import '${module}';`,`const load = () => import('${module}');`]) {
          assert.throws(() => assertNoObserverReference(parse(`${text}\n${snippet}`)),/retired acceptance module reference/);
        }
      }
    }
  });
  test(`${family} instrumentation guard rejects finite callback and module mutations`,() => {
    const instrumentation = [
      'globalThis.fetch = replacement;', 'window.fetch = replacement;', 'self.fetch = replacement;',
      "globalThis['fetch'] = replacement;", "window['fetch'] = replacement;", "self['fetch'] = replacement;",
      'fetch = replacement;', 'Object.freeze = replacement;', "Object['freeze'] = replacement;",
      'globalThis.Object.freeze = replacement;', "window['Object']['freeze'] = replacement;",
      'page.addInitScript(() => {});', "page['addInitScript'](() => {});",
      'page.evaluateOnNewDocument(() => {});', 'context.newCDPSession(page);', "context['newCDPSession'](page);",
      'browser.newBrowserCDPSession();', 'chromium.connectOverCDP(endpoint);',
      "session.send('Network.enable');", "session.send('Fetch.enable');", "session.send('IO.read');",
    ];
    for (const snippet of instrumentation) {
      for (const changed of [text.replace('  try {',`  ${snippet}\n  try {`),`${text}\nfunction hidden() { ${snippet} }`]) {
        assert.throws(() => assertNoRawInstrumentation(parse(changed),family,title),/raw (?:browser instrumentation|CDP instrumentation|global replacement)/);
      }
    }
    for (const mode of ['skip','only','fixme']) {
      assert.throws(() => assertNoRawInstrumentation(parse(text.replace(`test('${title}'`,`test.${mode}('${title}'`)),family,title),/actual retained acceptance browser case/);
    }
    assert.throws(() => assertNoRawInstrumentation(parse(text.replace(title,'changed title')),family,title),/retained acceptance browser title/);
    assert.throws(() => assertNoRawInstrumentation(parse(`test('${title}',null);`),family,title),/acceptance browser callback/);
    assert.throws(() => assertNoRawInstrumentation(parse(`test('${title}',async () => {});`),family,title),/retained acceptance callback activity/);
    assert.throws(() => assertNoRawInstrumentation(parse(text.replace('startFixture(executable','otherFixture(executable')),family,title),/retained acceptance callback activity/);
    assert.throws(() => assertNoRawInstrumentation(parse(`${text}\ntest('${title}',async () => {});`),family,title),/actual retained acceptance browser case/);
    assert.throws(() => assertNoRawInstrumentation(parse(`${text}\nconst = ;`),family,title),/acceptance browser source must parse/);
  });
  test(`${family} guards permit ordinary frozen observations and retained modules`,() => {
    for (const snippet of [
      'const observed = Object.freeze({ state: "accepted" });',
      'const observed = Object.isFrozen(command.body);',
      "const observed = Object['freeze']({ state: 'uncertain' });",
      "const load = () => import('../test-support/fixture.mjs');",
      '// globalThis.fetch = replacement; installAcceptanceUnknownObserver',
    ]) {
      const changed = parse(`${text}\n${snippet}`);
      assertNoObserverReference(changed);
      assertNoRawInstrumentation(changed,family,title);
    }
  });
}
test('retired path guard rejects an existing actual file without restoring any retired path',() => {
  assert.throws(() => assertRetired(new URL(import.meta.url)),/exclusive raw acceptance observer file must stay retired/);
});
