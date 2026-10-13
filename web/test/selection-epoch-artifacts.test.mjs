import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const installed = dirname(require.resolve('playwright/package.json'));
assert.equal(JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version,'1.58.2');
const source = ts.createSourceFile('playwright.js',readFileSync(join(installed,'lib/index.js'),'utf8'),ts.ScriptTarget.Latest,true);
const names = ['SnapshotRecorder','ArtifactsRecorder','normalizeScreenshotMode','kTracingStarted'];
const declarations = source.statements.filter(node => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text))));
assert.equal(declarations.length,names.length);
const recorderSource = `${declarations.map(node => node.getText(source)).join('\n')}\nArtifactsRecorder`;
const specUrl = new URL('../e2e/task-selection-epoch.spec.mjs',import.meta.url);
const spec = ts.createSourceFile('selection.js',readFileSync(specUrl,'utf8'),ts.ScriptTarget.Latest,true);
const cases = spec.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(spec) === 'test');
assert.equal(cases.length,1);
const callbackSource = `(${cases[0].expression.arguments[1].getText(spec)})`.replaceAll('import.meta.url',JSON.stringify(specUrl.href));
const key = 'PLAYWRIGHT_NO_COPY_PROMPT';
const secret = 'synthetic-private-snapshot-not-for-artifacts';

async function recorder(env) {
  const files = new Map(); let snapshots = 0;
  const Recorder = runInNewContext(recorderSource,{process:{env},
    import_fs:{default:{promises:{writeFile:async (path,text) => {files.set(path,text);}}}},
  },{timeout:1000});
  const page = {_wrapApiCall:callback => callback(),_snapshotForAI:async () => {snapshots++; return {full:secret};}};
  const context = {open:true,tracing:{},pages:() => [page],_wrapApiCall:callback => callback()};
  const instance = new Recorder({_allContexts:() => context.open ? [context] : [],
    _allPages:() => context.open ? [page] : [],request:{_contexts:new Set()}},'unused','off');
  const info = {errors:[new Error('synthetic timeout')],attachments:[],_tracing:{traceOptions:() => undefined},
    outputPath:name => name,_attach:attachment => {info.attachments.push(attachment);}};
  await instance.willStartTest(info);
  return {instance,context,files,info,snapshots:() => snapshots};
}

test('selection installed recorder positive control captures unguarded synthetic DOM', async () => {
  const proof = await recorder({});
  await proof.instance.willCloseBrowserContext(proof.context); proof.context.open=false;
  await proof.instance.didFinishTest();
  assert.equal(proof.snapshots(),1); assert.ok(proof.files.size > 0); assert.ok(proof.info.attachments.length > 0);
});

for (const failClose of [false,true]) {
  test(`selection spec scopes installed-recorder guard before creation through close; close failure=${failClose}`, async () => {
    for (const prior of [undefined,'','0','1','  prior value  ']) {
      const env = prior === undefined ? {} : {[key]:prior};
      const proof = await recorder(env); const closeGuards=[]; const createGuards=[]; const output=[];
      let stopGuard;
      proof.context.route=async () => {throw new Error(secret);};
      proof.context.close=async () => {
        closeGuards.push(env[key]); await proof.instance.willCloseBrowserContext(proof.context);
        if (failClose && closeGuards.length === 1) throw new Error(secret);
        proof.context.open=false;
      };
      const callback=runInNewContext(callbackSource,{process:{env},executable:'synthetic-executable',
        startFixture:async () => ({owner:'synthetic-owner',stop:async () => {stopGuard=env[key];}}),
        console:{log:message => {output.push(message);}},
      },{timeout:1000});
      await assert.rejects(callback({browser:{newContext:async options => {
        createGuards.push(env[key]); assert.equal(JSON.stringify(options),JSON.stringify({serviceWorkers:'block'}));
        return proof.context;
      }}}),error => {output.push(error.message); return error.message.startsWith('Selection epoch failed: startup;');});
      await proof.instance.didFinishTest();
      if (failClose) await proof.context.close();
      assert.deepEqual(createGuards,['1']); assert.deepEqual(closeGuards,failClose ? ['1','1'] : ['1']);
      const expected=failClose ? '1' : prior;
      assert.equal(env[key],expected); assert.equal(stopGuard,expected); assert.equal(Object.hasOwn(env,key),expected !== undefined);
      assert.equal(proof.snapshots(),0); assert.equal(proof.files.size,0); assert.equal(proof.info.attachments.length,0);
      assert.ok(output.join('\n').length < 4096); assert.equal(output.join('\n').includes(secret),false);
    }
  });
}

function selectionGuard(text) {
  const tree=ts.createSourceFile('selection.js',text,ts.ScriptTarget.Latest,true);
  assert.equal(tree.parseDiagnostics.length,0);
  const nodes=[];
  function visit(node) { nodes.push(node); ts.forEachChild(node,visit); }
  visit(tree);
  const uses=tree.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(tree) === 'test.use');
  assert.equal(uses.length,1);
  assert.equal(uses[0].expression.arguments.length,1);
  const options=runInNewContext(`(${uses[0].expression.arguments[0].getText(tree)})`,{},{timeout:1000});
  assert.equal(JSON.stringify(options),JSON.stringify({trace:'off',screenshot:'off',video:'off'}));
  for (const forbidden of ['route.fulfill','recordHar','recordVideo','.screenshot(','tracing.start']) assert.equal(text.includes(forbidden),false);

  const imports=tree.statements.filter(node => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text === '../test-support/mutations.mjs');
  assert.equal(imports.length,1);
  const clause=imports[0].importClause;
  assert.ok(clause && clause.name === undefined && clause.isTypeOnly === false);
  assert.ok(clause?.namedBindings && ts.isNamedImports(clause.namedBindings));
  assert.equal(clause.namedBindings.elements.length,1);
  const binding=clause.namedBindings.elements[0];
  assert.equal(binding.name.text,'armReplyLoss'); assert.ok(binding.propertyName === undefined);
  assert.equal(nodes.filter(node => ts.isStringLiteral(node) && node.text === '../test-support/mutations.mjs').length,1);
  const helpers=nodes.filter(node => ts.isIdentifier(node) && node.text === 'armReplyLoss');
  assert.equal(helpers.length,2); // One import and one direct call, never an alias or rebinding.
  const call=helpers.find(node => ts.isCallExpression(node.parent) && node.parent.expression === node)?.parent;
  assert.ok(call && !call.questionDotToken); assert.equal(call.arguments.length,3);
  assert.ok(ts.isAwaitExpression(call.parent));
  const assignment=call.parent.parent;
  assert.ok(ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(assignment.left) && assignment.left.text === 'hold' && assignment.right === call.parent
    && ts.isExpressionStatement(assignment.parent));
  const first=call.arguments[0]; assert.ok(ts.isAwaitExpression(first));
  const session=first.expression; assert.ok(ts.isCallExpression(session) && !session.questionDotToken);
  const method=session.expression;
  assert.ok(ts.isPropertyAccessExpression(method) && !method.questionDotToken
    && ts.isIdentifier(method.expression) && method.expression.text === 'context' && method.name.text === 'newCDPSession');
  assert.equal(session.arguments.length,1);
  assert.ok(ts.isIdentifier(session.arguments[0]) && session.arguments[0].text === 'page');
  assert.equal(nodes.filter(node => ts.isIdentifier(node) && node.text === 'newCDPSession').length,1);
  const url=call.arguments[1]; assert.ok(ts.isTemplateExpression(url));
  assert.equal(url.head.text,''); assert.equal(url.templateSpans.length,2);
  const [origin,run]=url.templateSpans;
  assert.ok(ts.isPropertyAccessExpression(origin.expression) && !origin.expression.questionDotToken
    && ts.isIdentifier(origin.expression.expression) && origin.expression.expression.text === 'fixture'
    && origin.expression.name.text === 'origin');
  assert.equal(origin.literal.text,'/v1/sessions/');
  assert.ok(ts.isIdentifier(run.expression) && run.expression.text === 'a'); assert.equal(run.literal.text,'/runs');
  assert.ok(ts.isNumericLiteral(call.arguments[2]) && call.arguments[2].getText(tree) === '202');

  // Keep browser ownership and the held reply local; aliases can hide extra sessions or drop calls.
  const members={context:['newCDPSession','route','on','newPage','cookies','close'],browser:['newContext'],
    page:['on','locator','getByRole','getByLabel','evaluate','goto','url','waitForResponse','waitForTimeout'],hold:['wait','stop']};
  for (const node of nodes.filter(node => ts.isIdentifier(node) && Object.hasOwn(members,node.text))) {
    const parent=node.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) continue;
    if (ts.isVariableDeclaration(parent) && parent.name === node && !parent.initializer) continue;
    if (ts.isBindingElement(parent) && parent.name === node && node.text === 'browser') continue;
    if (node === session.arguments[0]) continue;
    if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) continue;
    if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && ts.isIdentifier(parent.right) && parent.right.text === 'undefined') continue;
    assert.ok(ts.isPropertyAccessExpression(parent) && parent.expression === node
      && members[node.text].includes(parent.name.text) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
  }
  const banned=['recordHar','recordVideo','screenshot','tracing','fulfill','fetch','Response','drop','send',
    'newBrowserCDPSession','connectOverCDP','Network','Fetch','IO','getResponseBody','takeResponseBodyAsStream',
    'getReader','ReadableStream','ReadableStreamDefaultReader','ReadableStreamBYOBReader','addInitScript',
    'evaluateOnNewDocument','exposeFunction','exposeBinding','freeze','defineProperty','defineProperties',
    'setPrototypeOf','prototype','globalThis','window','self','Reflect','Proxy','eval','Function',
    'installSelectionEpochObserver','selectionEpochCapture','installReadReconnectObserver','readReconnectCapture'];
  for (const node of nodes) {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      // The already checked off-options contain a screenshot key, not a capture call.
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node
        && node.parent.parent === uses[0].expression.arguments[0]) continue;
      assert.equal(banned.includes(node.text),false,`forbidden executable name: ${node.text}`);
      if (ts.isStringLiteralLike(node)) {
        assert.equal(['armReplyLoss','newCDPSession'].includes(node.text),false);
        assert.equal(/^(Network|Fetch|IO)\.|Window ?B|read-reconnect|selection-epoch\.mjs/.test(node.text),false);
      }
    }
  }
}

test('selection spec disables trace screenshot and video and pins only the approved native response delay', () => {
  assert.doesNotThrow(() => selectionGuard(spec.getFullText()));
});

const pinned='hold = await armReplyLoss(await context.newCDPSession(page),`${fixture.origin}/v1/sessions/${a}/runs`,202);';
const helperImport="import { armReplyLoss } from '../test-support/mutations.mjs';";
const mutations=[
  ['extra direct session',pinned,`${pinned} await context.newCDPSession(page);`],
  ['extra browser session',pinned,`${pinned} await browser.newBrowserCDPSession();`],
  ['computed browser session',pinned,`${pinned} await browser['newBrowser'+'CDPSession']();`],
  ['aliased browser session',pinned,`${pinned} const b=browser; await b['newBrowser'+'CDPSession']();`],
  ['extra indirect page session',pinned,`${pinned} await page.context()['new'+'CDPSession'](page);`],
  ['computed session',pinned,pinned.replace('context.newCDPSession',"context['newCDPSession']")],
  ['computed split session',pinned,pinned.replace('context.newCDPSession',"context['new'+'CDPSession']")],
  ['aliased context',pinned,`const ctx=context; ${pinned.replace('context.newCDPSession','ctx.newCDPSession')}`],
  ['aliased session method',pinned,`const create=context.newCDPSession; ${pinned.replace('context.newCDPSession','create')}`],
  ['indirect session result',pinned,`const session=await context.newCDPSession(page); ${pinned.replace('await context.newCDPSession(page)','session')}`],
  ['wrapped session result',pinned,pinned.replace('await context.newCDPSession(page)','await wrap(await context.newCDPSession(page))')],
  ['unawaited session',pinned,pinned.replace('await context.newCDPSession(page)','context.newCDPSession(page)')],
  ['wrong session receiver',pinned,pinned.replace('context.newCDPSession','other.newCDPSession')],
  ['wrong session page',pinned,pinned.replace('newCDPSession(page)','newCDPSession(otherPage)')],
  ['extra session argument',pinned,pinned.replace('newCDPSession(page)','newCDPSession(page,otherPage)')],
  ['optional session',pinned,pinned.replace('context.newCDPSession','context?.newCDPSession')],
  ['aliased helper use',pinned,`const arm=armReplyLoss; ${pinned.replace('armReplyLoss(','arm(')}`],
  ['computed helper use',pinned,pinned.replace('armReplyLoss(',"helpers['armReplyLoss'](")],
  ['extra helper use',pinned,`${pinned} void armReplyLoss;`],
  ['helper rebinding',pinned,`armReplyLoss=other; ${pinned}`],
  ['unawaited helper',pinned,pinned.replace('hold = await armReplyLoss','hold = armReplyLoss')],
  ['wrapped helper',pinned,pinned.replace('await armReplyLoss(', 'await wrap(armReplyLoss(').replace(',202);',',202));')],
  ['aliased helper import',helperImport,"import { armReplyLoss as arm } from '../test-support/mutations.mjs';"],
  ['explicit same-name import alias',helperImport,"import { armReplyLoss as armReplyLoss } from '../test-support/mutations.mjs';"],
  ['default helper import',helperImport,"import armReplyLoss from '../test-support/mutations.mjs';"],
  ['namespace helper import',helperImport,"import * as armReplyLoss from '../test-support/mutations.mjs';"],
  ['extra helper import',helperImport,"import { armReplyLoss, other } from '../test-support/mutations.mjs';"],
  ['wrong helper module',helperImport,helperImport.replace('mutations.mjs','other.mjs')],
  ['helper re-export',helperImport,`${helperImport} export * from '../test-support/mutations.mjs';`],
  ['wrong A URL',pinned,pinned.replace('${a}/runs','${b}/runs')],
  ['wrong origin',pinned,pinned.replace('${fixture.origin}','${other.origin}')],
  ['wrong endpoint',pinned,pinned.replace('/runs`','/runs/reconcile`')],
  ['indirect URL',pinned,pinned.replace('`${fixture.origin}/v1/sessions/${a}/runs`','url')],
  ['wrong status',pinned,pinned.replace(',202)',',201)')],
  ['string status',pinned,pinned.replace(',202)',",'202')")],
  ['extra helper argument',pinned,pinned.replace(',202)',',202,other)')],
  ['comment-only pin',pinned,`// ${pinned}`],
  ['comment-only helper import',helperImport,`// ${helperImport}`],
  ['drop call',pinned,`${pinned} await hold.drop();`],
  ['drop alias',pinned,`${pinned} const discard=hold.drop;`],
  ['computed drop alias',pinned,`${pinned} const discard=hold['drop'];`],
  ['split computed drop',pinned,`${pinned} await hold['dr'+'op']();`],
  ['aliased hold',pinned,`${pinned} const reply=hold; await reply['dr'+'op']();`],
  ['aliased page instrumentation',pinned,`${pinned} const p=page; await p['add'+'InitScript'](observer);`],
  ['HAR',"serviceWorkers:'block'","serviceWorkers:'block',recordHar:{path:'synthetic.har'}"],
  ['video',"serviceWorkers:'block'","serviceWorkers:'block',recordVideo:{dir:'synthetic'}"],
  ['screenshot',pinned,`${pinned} await page.screenshot();`],
  ['tracing',pinned,`${pinned} await context.tracing.start();`],
  ['trace option',"trace:'off'","trace:'on'"],
  ['screenshot option',"screenshot:'off'","screenshot:'on'"],
  ['video option',"video:'off'","video:'on'"],
  ['route fetch',pinned,`${pinned} await route.fetch();`],
  ['route fulfill',pinned,`${pinned} await route.fulfill({body:'synthetic'});`],
  ['Response fabrication',pinned,`${pinned} const fake=new Response('synthetic');`],
  ['CDP fulfill',pinned,`${pinned} await session.send('Fetch.fulfillRequest',{});`],
  ['direct CDP send',pinned,`${pinned} await session.send(method,{});`],
  ['aliased CDP send',pinned,`${pinned} const send=session.send;`],
  ['Network body capture',pinned,`${pinned} const method='Network.getResponseBody';`],
  ['Fetch stream capture',pinned,`${pinned} const method='Fetch.takeResponseBodyAsStream';`],
  ['Network dataReceived',pinned,`${pinned} session.on('Network.dataReceived',listener);`],
  ['Network loadingFailed',pinned,`${pinned} session.on('Network.loadingFailed',listener);`],
  ['global fetch monkeypatch',pinned,`${pinned} await page.evaluate(() => { globalThis.fetch=other; });`],
  ['Object.freeze monkeypatch',pinned,`${pinned} await page.evaluate(() => { Object.freeze=other; });`],
  ['stream reader monkeypatch',pinned,`${pinned} await page.evaluate(() => { ReadableStream.prototype.getReader=other; });`],
  ['extra init script',pinned,`${pinned} await page.addInitScript(observer);`],
  ['equivalent global instrumentation',pinned,`${pinned} await page.evaluate(() => Object.defineProperty(Object,'freeze',{value:other}));`],
  ['Window B helper import',helperImport,`${helperImport} import { observer } from '../test-support/read-reconnect.mjs';`],
  ['retired selection observer',pinned,`${pinned} await page.evaluate(installSelectionEpochObserver);`],
];
for (const [name,before,after] of mutations) {
  test(`selection delay guard rejects ${name}`, () => {
    const original=spec.getFullText();
    assert.equal(original.split(before).length,2);
    const mutated=original.replace(before,after);
    assert.notEqual(mutated,original);
    assert.throws(() => selectionGuard(mutated),assert.AssertionError);
  });
}

test('selection delay pin ignores comments and retains ordinary HTTP body and DOM reads', () => {
  const text=spec.getFullText();
  assert.ok(text.includes('await response.body()') && text.includes('await page.evaluate('));
  assert.doesNotThrow(() => selectionGuard(`${text}\n// armReplyLoss newCDPSession Network.getResponseBody Object.freeze\n`));
});
