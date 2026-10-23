import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = ts.createSourceFile('fixed-head.js',readFileSync(new URL('../e2e/task-fixed-head.spec.mjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);

function assertRetired(url) {
  assert.equal(existsSync(url),false,'exclusive raw fixed-head observer file must stay retired');
}
function assertNoObserverReference(source) {
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      assert.equal(/(?:^|\/)(?:fixed-head|fixed-head-observer\.test)\.mjs(?:[?#].*)?$/.test(node.text),false,'retired fixed-head module reference');
    }
    if (ts.isIdentifier(node)) assert.notEqual(node.text,'installFixedHeadObserver','retired fixed-head observer reference');
    ts.forEachChild(node,visit);
  }
  visit(source);
}
function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}
function assertNoRawInstrumentation(source) {
  assert.equal(source.parseDiagnostics.length,0,'fixed-head browser source must parse');
  const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'test');
  assert.equal(cases.length,1,'guard the actual fixed-head browser case');
  const callback = cases[0].expression.arguments[1];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.body,'fixed-head browser callback');
  function visit(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) assert.notEqual(node.text,'fixedHeadCapture','retired raw capture');
    if (ts.isCallExpression(node)) {
      assert.equal(['addInitScript','newCDPSession'].includes(propertyName(node.expression)),false,'raw browser instrumentation');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left, name = propertyName(target);
      // The retired observer replaced browser globals to watch raw reducer state.
      if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && ts.isIdentifier(target.expression)) {
        const object = target.expression.text;
        assert.equal((object === 'Object' && name === 'freeze') || (['globalThis','window','self'].includes(object) && name === 'fetch'),false,'raw global replacement');
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(callback.body);
}

test('exclusive raw fixed-head observer files stay retired',() => {
  assertRetired(new URL('../test-support/fixed-head.mjs',import.meta.url));
  assertRetired(new URL('./fixed-head-observer.test.mjs',import.meta.url));
});
test('fixed-head browser source cannot reference the retired observer or its modules',() => {
  assertNoObserverReference(source);
});
test('actual fixed-head browser callback stays free of raw capture and global instrumentation',() => {
  assertNoRawInstrumentation(source);
});
