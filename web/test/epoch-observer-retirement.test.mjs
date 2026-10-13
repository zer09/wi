import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const titles = {
  selection:'selection epoch: held real A acceptance resolves after B selection without retargeting work or state',
  disconnect:'Disconnect epoch: accepted native work survives Disconnect; explicit Connect reads completed durable A',
  reload:'full reload epoch: accepted native work survives two documents; explicit Connect reads durable display A',
};
const retiredNames = ['installSelectionEpochObserver','installDisconnectEpochObserver','installReloadEpochObserver',
  'selectionEpochCapture','disconnectEpochCapture','reloadEpochCapture'];

function assertRetired(url) {
  assert.equal(existsSync(url),false,'exclusive raw epoch observer file must stay retired');
}
function assertNoObserverReference(source) {
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      assert.equal(/(?:^|\/)(?:selection|disconnect|reload)-epoch(?:-observer\.test)?\.mjs(?:[?#].*)?$/.test(node.text),false,'retired epoch module reference');
    }
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      assert.equal(retiredNames.includes(node.text),false,'retired epoch observer or capture reference');
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
  assert.equal(source.parseDiagnostics.length,0,'epoch browser source must parse');
  const cases = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ['test','test.skip','test.only','test.fixme'].includes(node.expression.expression.getText(source)));
  assert.equal(cases.length,1,'guard the actual retained epoch browser case');
  const call = cases[0].expression;
  assert.equal(call.expression.getText(source),'test','guard the actual retained epoch browser case');
  assert.equal(call.arguments[0]?.text,title,'guard the retained epoch browser title');
  const callback = call.arguments[1];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    && callback.body && ts.isBlock(callback.body),'epoch browser callback');
  let starts = 0, navigations = 0, replies = 0, sessions = 0;
  function activity(node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (name === 'startFixture') starts++;
      if (name === 'page.goto') navigations++;
      if (name === 'readReply') replies++;
    }
    ts.forEachChild(node,activity);
  }
  activity(callback.body);
  assert.ok(callback.body.statements.some(ts.isTryStatement) && starts === 1 && navigations > 0 && replies > 0,'retained epoch callback activity');
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = propertyName(node.expression);
      assert.equal(['addInitScript','evaluateOnNewDocument','newBrowserCDPSession','connectOverCDP'].includes(name),false,'raw browser instrumentation');
      if (name === 'newCDPSession') {
        // Selection already has one approved native reply delay, not a raw-state observer.
        const delay = node.parent.parent;
        assert.ok(family === 'selection' && node.getStart(source) >= callback.body.getStart(source) && node.end <= callback.body.end
          && ts.isAwaitExpression(node.parent) && ts.isCallExpression(delay)
          && delay.getText(source) === 'armReplyLoss(await context.newCDPSession(page),`${fixture.origin}/v1/sessions/${a}/runs`,202)', 'raw CDP instrumentation');
        sessions++;
      }
    }
    if (ts.isStringLiteralLike(node)) {
      assert.equal(/^(?:Network|Fetch|IO)\./.test(node.text),false,'raw CDP instrumentation');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left, name = propertyName(target);
      // Observing a frozen value is valid; replacing the browser global is not.
      if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && ts.isIdentifier(target.expression)) {
        const object = target.expression.text;
        assert.equal((object === 'Object' && name === 'freeze') || (['globalThis','window','self'].includes(object) && name === 'fetch'),false,'raw global replacement');
      }
    }
    ts.forEachChild(node,visit);
  }
  // Module helpers must not hide instrumentation outside the retained callback.
  visit(source);
  assert.equal(sessions,family === 'selection' ? 1 : 0,'raw CDP instrumentation');
}

for (const [family,title] of Object.entries(titles)) {
  const source = ts.createSourceFile(`${family}-epoch.js`,readFileSync(new URL(`../e2e/task-${family}-epoch.spec.mjs`,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  test(`exclusive raw ${family} epoch observer files stay retired`,() => {
    assertRetired(new URL(`../test-support/${family}-epoch.mjs`,import.meta.url));
    assertRetired(new URL(`./${family}-epoch-observer.test.mjs`,import.meta.url));
  });
  test(`${family} browser source cannot reference retired epoch observers or their modules`,() => {
    assertNoObserverReference(source);
  });
  test(`actual ${family} epoch case and module stay free of raw global instrumentation`,() => {
    assertNoRawInstrumentation(source,family,title);
  });
}
