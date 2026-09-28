import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { commandControls, errorText, nearBottom, parseSessionHash, receiptText, runStatus, sessionHash, supportedOrigin } from '../dist/view.js';

const sid = '12345678-abcd-abcd-abcd-123456789abc';

test('session hashes accept only an exact lowercase non-nil UUID or empty fragment', () => {
  assert.deepEqual(parseSessionHash(''), { kind: 'empty' });
  assert.equal(sessionHash(sid), `#session=${sid}`);
  assert.deepEqual(parseSessionHash(sessionHash(sid)), { kind: 'session', session_id: sid });
  for (const hash of ['#', `session=${sid}`, `#session=${sid.toUpperCase()}`, `#session=${sid}\n`,
    `#session=${sid}&extra=1`, `#session=${sid}?extra=1`, `#session=${sid}#`, `#session=%31${sid.slice(1)}`,
    `#session=${sid}&session=${sid}`, `#session= ${sid}`, '#session=00000000-0000-0000-0000-000000000000', '#token=private-canary']) {
    assert.deepEqual(parseSessionHash(hash), { kind: 'invalid' });
  }
  assert.throws(() => sessionHash('not-a-session'));
});

test('connect origin guard permits HTTPS and literal loopback HTTP only', () => {
  for (const host of ['127.0.0.1', '127.255.255.255', '[::1]']) assert.equal(supportedOrigin('http:', host), true);
  for (const host of ['localhost', '127.0.0.256', '127.00.0.1', '127.0.0', '128.0.0.1', '[::2]', '127.0.0.1.example', '']) {
    assert.equal(supportedOrigin('http:', host), false);
  }
  assert.equal(supportedOrigin('https:', 'wi.example.test'), true);
  assert.equal(supportedOrigin('file:', ''), false);
});

test('error formatting uses safe categories and validated code stage certainty, not raw exceptions', () => {
  assert.equal(errorText(null), '');
  for (const category of ['authentication', 'invalid_token', 'network', 'aborted', 'unsupported_client',
    'not_connected', 'invalid_action', 'workspace_forbidden', 'conflict']) {
    const text = errorText({ category, message: 'private-canary', stack: 'private-canary' });
    assert.ok(text.length > 0);
    assert.ok(!text.includes('private-canary'));
  }
  assert.match(errorText({ category: 'protocol', detail: 'invalid_cursor' }), /last valid prefix/);
  assert.equal(errorText({ category: 'http', status: 409, server: { code: 'storage.active_run_exists', stage: 'acceptance', certainty: 'not_committed' } }),
    'HTTP 409\nCode: storage.active_run_exists\nStage: acceptance\nCertainty: not_committed');
});

test('receipt formatting keeps decimal strings exact and labels acceptance, never completion', () => {
  const text = receiptText({ operation_id: sid, session_id: sid, run_id: null,
    first_sequence: '9007199254740993', last_sequence: '9223372036854775807' });
  assert.match(text, /Accepted receipt \(not completion\)/);
  assert.match(text, /9007199254740993 to 9223372036854775807/);
  assert.match(text, /Run: none/);
});

test('command controls separate identical retries from canonical read-only recovery', () => {
  function pending(kind, phase, canonical_sequence = null) { return { command: { kind }, phase, canonical_sequence }; }
  for (const phase of ['sending', 'reconciling']) {
    assert.deepEqual(commandControls(pending('task', phase)), { retry: false, reconcile: false, discard: false });
  }
  for (const phase of ['uncertain', 'rejected']) {
    assert.deepEqual(commandControls(pending('task', phase)), { retry: true, reconcile: true, discard: true });
    assert.deepEqual(commandControls(pending('create', phase)), { retry: true, reconcile: false, discard: true });
  }
  assert.deepEqual(commandControls(pending('task', 'conflict')), { retry: false, reconcile: false, discard: true });
  assert.deepEqual(commandControls(pending('task', 'accepted', '3'), true), { retry: false, reconcile: true, discard: false });
  assert.equal(commandControls(pending('task', 'uncertain', '3')).retry, false);
  assert.equal(commandControls(pending('task', 'accepted')).retry, false);
});

test('scroll following uses the pre-update distance, without forcing a scrolled-away reader', () => {
  assert.equal(nearBottom(500, 400, 900), true);
  assert.equal(nearBottom(436, 400, 900), true);
  assert.equal(nearBottom(435, 400, 900), false);
  assert.equal(nearBottom(0, 400, 100), true);
});

test('run presentation separates execution from final recording', () => {
  assert.equal(runStatus({ execution: 'accepted', result_recorded: false }), 'Execution: accepted. Final result not recorded.');
  assert.equal(runStatus({ execution: 'completed', result_recorded: false }), 'Execution: completed. Final result not recorded.');
  assert.equal(runStatus({ execution: 'failed', result_recorded: true }), 'Execution: failed. Final result recorded.');
  assert.match(runStatus({ execution: 'interrupted', result_recorded: false }), /interrupted/);
});

test('production modules contain no executable markup, storage, logging or automatic-resource sinks', () => {
  const forbidden = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'DOMParser', 'eval', 'Function',
    'localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'console', 'EventSource', 'serviceWorker',
    'pushState', 'replaceState', 'sendBeacon', 'write', 'writeln']);
  for (const path of readdirSync(new URL('../src/', import.meta.url))) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
    function visit(node) {
      if (ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text), `Forbidden identifier in ${path}: ${node.text}`);
      if (ts.isPropertyAccessExpression(node)) assert.ok(!['href', 'src', 'style'].includes(node.name.text));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute') {
        const name = node.arguments[0];
        assert.ok(ts.isStringLiteral(name), 'Attribute names are static');
        assert.ok(['role', 'aria-live', 'aria-label', 'aria-current', 'autocapitalize'].includes(name.text));
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});

test('app routes and unload handlers only select/read or dispose; cancellation is an explicit button', () => {
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /sendTask|retryCommand|createSession|renameSession|cancelCurrentRun|setInterval|setTimeout/);
  assert.match(app, /addEventListener\('pagehide', \(\) => client\.disconnect\(\)\)/);
  assert.match(app, /addEventListener\('beforeunload', \(\) => client\.disconnect\(\)\)/);
  const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');
  assert.equal(view.match(/client\.cancelCurrentRun\(/g).length, 1);
  assert.match(view, /button\('Cancel current run', \(\) => \{ void client\.cancelCurrentRun\(\); \}\)/);
  assert.match(view, /token\.type = 'password'/);
  assert.match(view, /client\.connect\(token\.value\); \} finally \{ token\.value = ''; \}/);
  assert.doesNotMatch(view, /\.focus\(/);
});

test('page and styles use no external resources and provide wrapping, visible focus and mobile layout', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<img|<iframe|\son\w+\s*=|https?:\/\//i);
  assert.doesNotMatch(css, /url\(|@import|@font-face/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /white-space: pre-wrap/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 48rem\)/);
});
