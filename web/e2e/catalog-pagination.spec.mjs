import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { rustPageFixture } from '../test-support/display-dom.mjs';
import { executableBinding, linuxProcess } from '../test-support/skill-source-fidelity.mjs';
import { AS_OF, FIRST_PATH, MORE_PATH, catalogPipeline, rowsProof, requireFact, cleanupOwned,
  classifyCatalogRoute, classifyRequestError } from '../test-support/catalog-pagination.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const files = new Map([['/', 'index.html'], ['/assets/wi.css', 'style.css'],
  ...['api', 'app', 'display-api', 'display-client', 'display-store', 'display-view', 'sse'].map(n => [`/assets/${n}.js`, `dist/${n}.js`])]);
const privateMarkers = ['synthetic-replay-', 'private-operator-', 'private-project-', 'private-skill-',
  'private-support-', 'private-native', 'principal_digest', 'encrypted_content', 'prepared_request', 'provider_session_id'];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function boundary(page, context, owner) {
  const safe = await page.evaluate(async ({ owner, privateMarkers }) => {
    const values = [document.documentElement.outerHTML, location.href, JSON.stringify(history.state),
      ...Array.from(document.querySelectorAll('input,textarea,select'), n => n.value)];
    return values.every(v => !v || !v.includes(owner) && !privateMarkers.some(m => v.includes(m)))
      && location.hash === '' && document.querySelectorAll('.session-list [aria-current="true"],.run,.command').length === 0
      && document.querySelectorAll('.session-list em,.session-list a,.session-list img,.session-list script,.session-list svg,.session-list iframe').length === 0
      && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
      && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
      && (await navigator.serviceWorker.getRegistrations()).length === 0;
  }, { owner, privateMarkers });
  requireFact(safe && (await context.cookies()).length === 0, 'privacy');
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('active embedded catalog Load more sessions appends exact ID page and explicit Refresh list resets', async ({ browser }, info) => {
  const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  let stage = 'output', fixture, server, context, page, binding, nativeIdentity, original = null, outputOwned = false;
  const output = info.outputPath('c61'), pipeline = catalogPipeline(), calls = [], assetReads = [], assets = new Set();
  const faults = { traffic: 0, response: 0, asset: 0, console: 0, page: 0, privacy: 0, request: 0, server: 0 };
  const result = { body_success: false, success: false, first: null, observations: {},
    scope: 'B/C synthetic catalog DTO transport on actual Rust embedded app; separate prior H', native_work_counters: null,
    native_work_counter_limit: 'Reusable asset fixture exposes no provider/auth/tool counters', helper_http_reads: 0, api_body_reads: 0 };
  let observation = null, failedObservation = null;
  let eventSeq = 0, requestFailureTotal = 0;
  const requestFailures = [];
  const leaked = text => (fixture && text.includes(fixture.owner)) || privateMarkers.some(m => text.includes(m));
  function diagnosticSnapshot() {
    return Object.freeze({
      request_failures: Object.freeze({ total: requestFailureTotal, records: Object.freeze([...requestFailures]) }),
      api: Object.freeze({ settings: calls.filter(c => c.path === '/v1/settings').length,
        catalog: calls.filter(c => c.path.startsWith('/v1/sessions?')).length,
        total: calls.length, all_get: calls.every(c => c.request.method() === 'GET'), assets: assets.size,
        matched_responses: calls.filter(c => c.response).length, finished: calls.filter(c => c.finished).length,
        calls: Object.freeze(calls.map(c => {
          let terminal = 'pending';
          if (c.failed_seq !== null) terminal = 'failed';
          else if (c.finished) terminal = 'finished';
          return Object.freeze({ route: classifyCatalogRoute(c.path, files), terminal,
            request_seq: c.request_seq, response_seq: c.response_seq, finished_seq: c.finished_seq, failed_seq: c.failed_seq });
        })) }),
    });
  }
  function failurePacket(error) {
    return Object.freeze({ stage, code: /^C61:[a-z]+$/.test(error?.message ?? '') ? error.message.slice(4) : 'verification_failure',
      observation: failedObservation?.observation ?? null, check: failedObservation?.check ?? null,
      api_requests: calls.length, server_requests: pipeline.count(), faults: Object.freeze({ ...faults }), ...diagnosticSnapshot() });
  }
  async function checkFaults() {
    await Promise.all(assetReads);
    requireFact(Object.values(faults).every(n => n === 0), 'faults');
    requireFact(assets.size === files.size, 'assets');
  }
  async function observe(name, tail, count) {
    observation = { name, check: 'row_count' };
    try {
      const list = page.locator('.session-list li');
      await expect(list).toHaveCount(tail ? 33 : 32);
      observation.check = 'rows';
      // Poll only an equality boolean so framework diagnostics cannot include DOM payloads.
      await expect.poll(async () => {
        const rows = await list.evaluateAll(nodes => nodes.map(n => ({ title: n.querySelector('button').textContent,
          metadata: n.querySelector('.metadata').textContent, current: n.querySelector('button').getAttribute('aria-current') })));
        try { rowsProof(rows, tail); return true; } catch { return false; }
      }).toBe(true);
      observation.check = 'paginator';
      const more = page.getByRole('button', { name: 'Load more sessions', exact: true, includeHidden: true });
      if (tail) {
        observation.check = 'paginator_hidden';
        await expect(more).toBeHidden();
      } else {
        observation.check = 'paginator_visible';
        await expect(more).toBeVisible();
        observation.check = 'paginator_enabled';
        await expect(more).toBeEnabled();
      }
      observation.check = 'paginator_state';
      const paginatorHidden = await more.isHidden();
      observation.check = 'as_of';
      await expect.poll(async () => await page.getByLabel('Sessions', { exact: true }).getByText(AS_OF, { exact: true }).count() === 1).toBe(true);
      observation.check = 'frames';
      await frames(page);
      observation.check = 'traffic';
      requireFact(calls.length === count && pipeline.count() === count, 'traffic');
      observation.check = 'content';
      const content = await list.evaluateAll(nodes => nodes.map(n => n.textContent));
      result.observations[name] = { rows: content.length, exact_titles_metadata_order: true, dom_sha256: hash(JSON.stringify(content)),
        paginator_hidden: paginatorHidden, as_of_label: true, api_requests: count };
      observation.check = 'privacy';
      await boundary(page, context, fixture.owner);
      observation.check = 'faults';
      await checkFaults();
    } catch (error) {
      // Keep the detecting check, not a claim about the physical cause of an asynchronous fault.
      failedObservation ??= Object.freeze({ observation: observation.name, check: observation.check });
      throw error;
    } finally { observation = null; }
  }
  try {
    await mkdir(output, { mode: 0o700 }); outputOwned = true;
    await writeFile(join(output, 'CASE.once'), 'C61 fresh case\n', { flag: 'wx', mode: 0o600 });
    stage = 'binding';
    const executable = process.env.WI_C3A_FIXTURE;
    requireFact(typeof executable === 'string' && executable.length > 0, 'binding');
    binding = await executableBinding(executable, process.env.WI_C3A_FIXTURE_SHA256);
    result.binding = binding;
    stage = 'native'; fixture = await rustPageFixture(executable);
    result.native_pid = fixture.pid;
    if (process.platform === 'linux') { nativeIdentity = await linuxProcess(fixture.pid); result.native_identity = nativeIdentity; }
    stage = 'transport';
    server = createServer((req, res) => {
      try {
        requireFact(req.headers.authorization === `Bearer ${fixture.owner}` && !req.headers.cookie
          && req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined, 'privacy');
        const value = pipeline.reply(req.method, req.url);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
      } catch {
        faults.server++;
        if (!res.destroyed) { res.writeHead(500); res.end(); }
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    stage = 'context'; context = await browser.newContext({ serviceWorkers: 'block' });
    result.chromium = browser.version();
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        requireFact(url.origin === fixture.origin && !leaked(request.url()), 'traffic');
        if (url.pathname.startsWith('/v1/')) {
          requireFact(request.method() === 'GET' && ['/v1/settings', FIRST_PATH, MORE_PATH].includes(url.pathname + url.search), 'traffic');
          // Rewrite only the destination, not native fetch or the application's JSON reader.
          await route.continue({ url: origin + url.pathname + url.search });
        } else {
          requireFact(files.has(url.pathname) && url.search === '' && request.method() === 'GET', 'assets');
          await route.continue();
        }
      } catch { faults.traffic++; await route.abort().catch(() => { faults.request++; }); }
    });
    context.on('request', request => {
      const seq = ++eventSeq;
      try {
        const url = new URL(request.url());
        if (url.origin !== fixture.origin || leaked(request.url()) || request.method() !== 'GET') faults.traffic++;
        if (url.pathname.startsWith('/v1/')) calls.push({ request, path: url.pathname + url.search, response: null, finished: false,
          request_seq: seq, response_seq: null, finished_seq: null, failed_seq: null });
      } catch { faults.traffic++; }
    });
    context.on('response', reply => {
      const seq = ++eventSeq;
      try {
        const url = new URL(reply.url()), record = calls.find(c => c.request === reply.request()), file = files.get(url.pathname);
        if (reply.status() !== 200) faults.response++;
        if (record) {
          if (record.response || reply.headers()['content-type'] !== 'application/json' || reply.headers()['cache-control'] !== 'no-store') faults.response++;
          record.response = reply; record.response_seq ??= seq;
        } else if (file) assetReads.push((async () => {
          const bytes = await reply.body();
          if (!bytes.equals(await readFile(new URL(`../${file}`, import.meta.url))) || leaked(bytes.toString())) faults.asset++;
          if (assets.has(url.pathname)) faults.asset++;
          assets.add(url.pathname);
        })().catch(() => { faults.asset++; }));
        else faults.response++;
      } catch { faults.response++; }
    });
    context.on('requestfinished', request => {
      const seq = ++eventSeq;
      const record = calls.find(c => c.request === request);
      if (record) { record.finished = true; record.finished_seq ??= seq; }
    });
    context.on('requestfailed', request => {
      const seq = ++eventSeq;
      faults.request++;
      requestFailureTotal++;
      const record = calls.find(c => c.request === request);
      if (record) record.failed_seq ??= seq;
      // Freeze event-time facts. Later cleanup callbacks must not rewrite the first packet.
      if (requestFailures.length < 8) {
        const url = new URL(request.url());
        requestFailures.push(Object.freeze({ route: classifyCatalogRoute(url.pathname + url.search, files),
          error: classifyRequestError(request.failure()?.errorText), response_seen: record ? record.response !== null : null,
          finished_seen: record ? record.finished : null, stage, observation: observation?.name ?? null,
          check: observation?.check ?? null, seq }));
      }
    });
    page = await context.newPage();
    page.on('console', message => { faults.console++; if (leaked(message.text())) faults.privacy++; });
    page.on('pageerror', () => { faults.page++; });
    stage = 'empty'; await page.goto(fixture.origin + '/');
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await expect(page.locator('.session-list li')).toHaveCount(0);
    requireFact(calls.length === 0 && new URL(page.url()).hash === '', 'traffic');
    stage = 'connect';
    await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    await observe('initial', false, 2);
    const first = await page.locator('.session-list li').elementHandles();
    stage = 'more';
    await page.getByRole('button', { name: 'Load more sessions', exact: true }).click();
    await observe('append', true, 3);
    for (const [i, node] of first.entries()) requireFact(await node.evaluate((n, i) => n === document.querySelectorAll('.session-list li')[i], i), 'identity');
    result.observations.append.retained_first32_identity = true;
    stage = 'refresh';
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await observe('refresh', false, 4);
    for (const [i, node] of first.entries()) {
      requireFact(await node.evaluate((n, i) => n === document.querySelectorAll('.session-list li')[i], i), 'identity'); await node.dispose();
    }
    result.observations.refresh.retained_first32_identity = true;
    requireFact(result.observations.initial.dom_sha256 === result.observations.refresh.dom_sha256, 'dom');
    pipeline.complete();
    requireFact(JSON.stringify(calls.map(c => c.path)) === JSON.stringify(['/v1/settings', FIRST_PATH, MORE_PATH, FIRST_PATH]), 'traffic');
    await expect.poll(() => calls.every(c => c.response !== null && c.finished)).toBe(true);
    requireFact(new Set(calls.map(c => c.request)).size === 4, 'identity');
    result.original_request_response_identity = true; result.exact_after_id = true;
    await checkFaults(); await boundary(page, context, fixture.owner);
    requireFact(JSON.stringify(await executableBinding(executable, binding.sha256)) === JSON.stringify(binding), 'binding');
    result.body_success = true;
  } catch (error) {
    original = error;
    result.first = failurePacket(error);
    if (outputOwned) await writeFile(join(output, 'FAILURE.json'), JSON.stringify(result.first), { flag: 'wx', mode: 0o600 });
  } finally {
    const cleanup = await cleanupOwned([
      ['context', async () => { if (context) await context.close(); }],
      ['transport', async () => { if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } }],
      ['native', async () => { if (fixture) await fixture.stop(); }],
      ['retirement', async () => {
        if (nativeIdentity) {
          let retired = false;
          try { retired = (await linuxProcess(nativeIdentity.pid)).start !== nativeIdentity.start; }
          catch (error) { if (error.code === 'ENOENT') retired = true; else throw error; }
          requireFact(retired, 'retirement'); result.native_identity_retired = true;
          let absent = false;
          try { await lstat(nativeIdentity.cwd); } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
          requireFact(absent, 'retirement'); result.owned_sandbox_absent = true;
        }
      }],
      ['faults', checkFaults],
    ], original);
    try {
      result.cleanup = cleanup.facts; result.faults = { ...faults };
      result.stop = fixture?.evidence() ?? null;
      if (cleanup.error && !result.first) {
        result.first = failurePacket(cleanup.error);
        if (outputOwned) await writeFile(join(output, 'FAILURE.json'), JSON.stringify(result.first), { flag: 'wx', mode: 0o600 });
      }
      Object.assign(result, diagnosticSnapshot());
      const stop = result.stop?.stop;
      const normal = stop?.attempted && stop.clean_acknowledgment && stop.reap_complete && stop.sandbox_removed
        && stop.exit_zero && stop.stderr_empty && !stop.sigterm && !stop.sigkill && !stop.error_latched;
      result.success = result.body_success && !cleanup.error && Boolean(normal);
      if (outputOwned) await writeFile(join(output, 'RESULT.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT; else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous;
    }
    if (!result.success) throw new Error('C61:failed; scalar evidence saved');
  }
});
