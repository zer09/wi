import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const families = [
  ['account-mismatch','account mismatch is an accepted execution failure without sending history on the second WebSocket'],
  ['incomplete-history','a second Send rejects incomplete stored history without changing the accepted warning or starting provider work'],
  ['unbound-history','completed legacy history stays readable but one explicit Send rejects unbound replay without any new work'],
];
const retiredNames = ['installAccountMismatchObserver','installIncompleteHistoryObserver','installUnboundHistoryObserver',
  'accountMismatchCapture','incompleteHistoryCapture','unboundHistoryCapture'];

function assertRetired(url) {
  assert.equal(existsSync(url),false,'exclusive raw history observer file must stay retired');
}
function assertNoObserverReference(source) {
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      assert.equal(/(?:^|\/)(?:account-mismatch|incomplete-history|unbound-history)(?:-observer\.test)?\.mjs(?:[?#].*)?$/.test(node.text),false,'retired history module reference');
    }
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      assert.equal(retiredNames.includes(node.text),false,'retired history observer or capture reference');
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}
function assertNoRawInstrumentation(source,title) {
  assert.equal(source.parseDiagnostics.length,0,'history browser source must parse');
  const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'test');
  assert.equal(cases.length,1,'guard the actual migrated history browser case');
  assert.equal(cases[0].expression.arguments[0]?.text,title,'guard the retained history browser title');
  const callback = cases[0].expression.arguments[1];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.body,'history browser callback');
  function visit(node) {
    if (ts.isCallExpression(node)) {
      assert.equal(['addInitScript','newCDPSession'].includes(propertyName(node.expression)),false,'raw browser instrumentation');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left, name = propertyName(target);
      // The retired observers replaced browser globals to watch raw reducer state.
      if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && ts.isIdentifier(target.expression)) {
        const object = target.expression.text;
        assert.equal((object === 'Object' && name === 'freeze') || (['globalThis','window','self'].includes(object) && name === 'fetch'),false,'raw global replacement');
      }
    }
    ts.forEachChild(node,visit);
  }
  // Check module helpers too, so moving instrumentation outside the callback cannot hide it.
  visit(source);
}

for (const [name,title] of families) {
  const source = ts.createSourceFile(`${name}.js`,readFileSync(new URL(`../e2e/task-${name}.spec.mjs`,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  test(`exclusive raw ${name} observer files stay retired`,() => {
    assertRetired(new URL(`../test-support/${name}.mjs`,import.meta.url));
    assertRetired(new URL(`./${name}-observer.test.mjs`,import.meta.url));
  });
  test(`${name} browser source cannot reference retired history observers or their modules`,() => {
    assertNoObserverReference(source);
  });
  test(`actual ${name} browser case stays free of raw global instrumentation`,() => {
    assertNoRawInstrumentation(source,title);
  });
}
