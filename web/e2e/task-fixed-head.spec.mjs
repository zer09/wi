import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact, occurrences } from '../test-support/joined.mjs';
import { checkEmbeddedAssets } from '../test-support/stale-history.mjs';
import { installFixedHeadObserver } from '../test-support/fixed-head.mjs';

const TITLE = 'Fixed head 65';
const RENAMED = 'Fixed head renamed 雪 <em>inert</em>';
const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n';
const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
const ARGUMENTS = '{"a":17,\r\n "b":25}';
const OUTPUT = '{"sum":42}';
let executable;
test.beforeAll(async () => { test.setTimeout(150_000); executable = await discoverFixture(); });
test.use({ trace:'off', screenshot:'off', video:'off' });

test('fixed-head pages exclude interleaved writes and two independent browsers converge through real SSE', async ({ browser }) => {
  const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;
  let contextA;
  let contextB;
  let release;
  let failure;
  let stage = 'startup';
  let observed = null;
  let audit = null;
  let assetEvidence = null;
  const faults = { external:0, request:0, response:0, console:0, page:0, private:0 };
  const network = ['A','B'].map(() => ({ settings:0,list:0,manifest:0,history:0,events:0,rename:0,task:0,other:0 }));
  const cleanup = { a:false,b:false,fixture:false };
  let paused = false;
  let continued = false;
  try {
    fixture = await startFixture(executable, { transport:'websocket',recovered:false,mime:true,mutations:true,fixed_head:true });
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    contextA = await browser.newContext({ serviceWorkers:'block' });
    contextB = await browser.newContext({ serviceWorkers:'block' });
    const sid = fixture.sessionId;
    const path = `/v1/sessions/${sid}`;
    const privateMarkers = ['synthetic-replay-','synthetic-account-','private-operator-','private-project-','private-skill-',
      'private-native','private-data','private-skills','principal_digest','history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || privateMarkers.some(marker => text.includes(marker));
    const files = new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','client','sse','state','view'].map(name => [`/assets/${name}.js`,`dist/${name}.js`])]);
    const assetSets = [new Set(),new Set()];
    const hold = new Promise(resolve => { release = resolve; });
    for (const [index, context] of [contextA,contextB].entries()) {
      let routedPages = 0;
      await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin !== fixture.origin) { faults.external++; await route.abort(); return; }
        if (index === 0 && request.method() === 'GET' && url.pathname === `${path}/history` && ++routedPages === 2) {
          paused = true; await hold; continued = true;
        }
        // Only pause and forward the original request. No response is supplied by the test.
        await route.continue();
      });
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== fixture.origin) faults.external++;
        if (leaked(request.url())) faults.private++;
        if (!url.pathname.startsWith('/v1/')) return;
        const headers = request.headers();
        if (headers.authorization !== `Bearer ${fixture.owner}` || headers.cookie !== undefined
          || (headers.origin !== undefined && headers.origin !== fixture.origin)) faults.request++;
        const n = network[index];
        if (request.method() === 'GET') {
          if (url.pathname === '/v1/settings' && url.search === '') n.settings++;
          else if (url.pathname === '/v1/sessions' && url.search === '?limit=32') n.list++;
          else if (url.pathname === path && url.search === '') n.manifest++;
          else if (url.pathname === `${path}/history`) {
            const page = n.history++; const after = ['0','32','64'][page];
            if (page >= 3 || url.searchParams.get('limit') !== '32' || url.searchParams.get('after') !== `${sid}:${after}`
              || url.searchParams.get('through') !== (page === 0 ? null : '66') || url.searchParams.size !== (page === 0 ? 2 : 3)) faults.request++;
          } else if (url.pathname === `${path}/events`) {
            n.events++; if (url.searchParams.size !== 1 || url.searchParams.get('after') !== `${sid}:66`) faults.request++;
          } else n.other++;
        } else if (request.method() === 'POST') {
          let kind;
          if (url.pathname === `${path}/rename`) kind = 'rename';
          else if (url.pathname === `${path}/runs`) kind = 'task';
          else { n.other++; return; }
          n[kind]++;
          if (index !== 1 || url.search !== '' || n[kind] !== 1 || !paused || continued) faults.request++;
          try {
            const raw = request.postDataBuffer();
            if (raw === null || raw.byteLength > 4096) throw new Error();
            const body = JSON.parse(raw.toString('utf8'));
            const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
            if (!uuid(body.operation_id) || Object.keys(body).sort().join(',') !== (kind === 'task' ? 'operation_id,run_id,text' : 'operation_id,title')
              || (kind === 'task' ? !uuid(body.run_id) || body.text !== TASK : body.title !== RENAMED) || leaked(raw.toString('utf8'))) throw new Error();
          } catch { faults.request++; }
        } else n.other++;
      });
      context.on('response', response => {
        if (response.status() >= 300) faults.response++;
        const path = new URL(response.url()).pathname;
        if (files.has(path)) assetSets[index].add(path);
      });
      await context.addInitScript(installFixedHeadObserver, { session:sid,initialTitle:TITLE,renamedTitle:RENAMED,
        task:TASK,answer:ANSWER,argumentsText:ARGUMENTS,output:OUTPUT,owner:fixture.owner });
    }
    const pages = [await contextA.newPage(),await contextB.newPage()];
    for (const page of pages) {
      page.on('console', message => { faults.console++; if (leaked(message.text()) || leaked(message.location().url)) faults.private++; });
      page.on('pageerror', () => { faults.page++; });
    }
    const [a,b] = pages;
    const status = page => page.locator('.topbar [role="status"]');
    const cursor = page => page.locator('p.metadata').filter({ hasText:/^Applied cursor:/ });
    async function connect(page) {
      await page.goto(`${fixture.origin}/`);
      await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      await exact(status(page),'connected');
      expect(await page.getByLabel('Owner token',{exact:true}).inputValue() === '').toBe(true);
    }
    async function boundary(page, context) {
      const safe = await page.evaluate(async ({ owner,markers }) => {
        const texts = [document.documentElement.outerHTML,location.href,JSON.stringify(history.state),
          ...Array.from(document.querySelectorAll('input,textarea,select'),node => node.value)];
        return localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '' && (await indexedDB.databases()).length === 0
          && (await caches.keys()).length === 0 && (await navigator.serviceWorker.getRegistrations()).length === 0
          && texts.every(text => !text || (!text.includes(owner) && !/[0-9a-f]{64}/i.test(text) && !markers.some(marker => text.includes(marker))));
      }, {owner:fixture.owner,markers:privateMarkers});
      expect(safe && (await context.cookies()).length === 0).toBe(true);
      expect(await page.locator('.run em,.run img,.run script,.run a,img,iframe').count()).toBe(0);
    }
    async function finalTruth(page) {
      await exact(cursor(page),`Applied cursor: ${sid}:${audit.sequence_count}\nSnapshot head: 66`);
      await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),RENAMED);
      await expect(page.locator('.run')).toHaveCount(1);
      const run = page.locator('.run');
      await exact(run.locator('.user-text'),TASK);
      await exact(run.locator(':scope > p:not(.metadata)'),'Execution: completed. Final result recorded.');
      for (const text of [ANSWER,ARGUMENTS,OUTPUT]) await occurrences(run,text,1);
      await expect(run.locator('.entry')).toHaveCount(3);
      const tool = run.locator('.entry').filter({has:page.getByRole('heading',{name:'Tool: add_numbers',exact:true})});
      expect((await tool.textContent()).includes('finished (success)') && (await tool.textContent()).includes('Result: success')).toBe(true);
      expect((await run.textContent()).includes('Terminal outcome: completed') && (await run.textContent()).includes('Outcome: completed')).toBe(true);
      await exact(status(page),'connected; observation: streaming; run: completed; result recorded');
      expect(await page.locator('.command').count()).toBe(0);
    }
    async function summary() { return Promise.all(pages.map(page => page.evaluate(() => globalThis.fixedHeadCapture.summary()))); }
    async function quiet() {
      const {id:_id,...current} = await fixture.inspect();
      expect(JSON.stringify(current) === JSON.stringify(audit)).toBe(true);
      expect(network).toEqual([
        {settings:1,list:1,manifest:1,history:3,events:1,rename:0,task:0,other:0},
        {settings:1,list:1,manifest:2,history:3,events:1,rename:1,task:1,other:0},
      ]);
    }

    stage = 'initial private audit and B opens first';
    const initial = await fixture.inspect(); expect(initial.phase === 'initial' && initial.sequence_count === '66').toBe(true);
    await fixture.request({command:'select',session_id:sid});
    await connect(b); await b.getByRole('button',{name:TITLE,exact:true}).click();
    await exact(cursor(b),`Applied cursor: ${sid}:66\nSnapshot head: 66`);
    await exact(status(b),'connected; observation: streaming');
    await exact(b.getByRole('region',{name:'Canonical conversation',exact:true}),'No messages yet.');
    await connect(a); await a.getByRole('button',{name:TITLE,exact:true}).click();
    await expect.poll(() => paused).toBe(true);
    await exact(cursor(a),`Applied cursor: ${sid}:32\nSnapshot head: 66`);
    expect(network[0].history === 2 && network[0].events === 0 && !continued).toBe(true);

    stage = 'B commits rename and acceptance above H while A page two is paused';
    await b.getByLabel('Exact new title',{exact:true}).fill(RENAMED);
    await b.getByRole('button',{name:'Rename session',exact:true}).click();
    await exact(b.getByRole('heading',{name:'Canonical session title',exact:true}),RENAMED);
    await expect.poll(async () => (await b.evaluate(() => globalThis.fixedHeadCapture.summary())).renameReceipt).toBe(true);
    await b.getByLabel('Task',{exact:true}).fill(TASK);
    await b.getByRole('button',{name:'Send',exact:true}).click();
    await fixture.wait('model_paused',1);
    await expect.poll(async () => (await b.evaluate(() => globalThis.fixedHeadCapture.summary())).taskReceipt).toBe(true);
    const interleaved = await fixture.inspect();
    expect(interleaved.phase === 'interleaved' && interleaved.sequence_count === '72' && interleaved.requests === 1).toBe(true);
    await exact(cursor(a),`Applied cursor: ${sid}:32\nSnapshot head: 66`);
    await exact(a.getByRole('heading',{name:'Canonical session title',exact:true}),TITLE);
    expect(await a.locator('.run').count()).toBe(0);
    await boundary(a,contextA); await boundary(b,contextB);

    stage = 'A completes fixed-head pages and attaches actual SSE after 66';
    release();
    await exact(cursor(a),`Applied cursor: ${sid}:72\nSnapshot head: 66`);
    await exact(status(a),'connected; observation: streaming; run: running; result not recorded');
    await exact(a.getByRole('heading',{name:'Canonical session title',exact:true}),RENAMED);
    observed = await summary();
    stage = 'real tool completion';
    await fixture.request({command:'drive',gate:1}); await fixture.wait('model_paused',2);
    for (const page of pages) await occurrences(page.locator('.run'),OUTPUT,1);
    stage = 'real provisional response';
    await fixture.request({command:'drive',gate:2}); await fixture.wait('model_paused',3);
    for (const page of pages) await occurrences(page.locator('.run'),'42 雪',1);
    stage = 'real terminal response';
    await fixture.request({command:'drive',gate:3}); await fixture.wait('task_finished',1);
    observed = await summary();
    stage = 'final private audit';
    const {id:_finalId,...final} = await fixture.inspect(); audit = final;
    expect(audit.phase === 'completed' && audit.requests === 2 && audit.connections === 1 && audit.tools === 1).toBe(true);
    stage = 'final canonical DOM';
    for (const page of pages) await finalTruth(page);
    await expect.poll(async () => (await summary()).every(s => s.delivered.at(-1) === audit.sequence_count)).toBe(true);
    observed = await summary();
    const post = Array.from({length:Number(BigInt(audit.sequence_count)-66n)},(_,i) => String(i+67));
    for (const capture of observed) {
      expect(capture.pageRequests === 3 && capture.streams === 1 && capture.noEarly && capture.reduced && capture.checkpoint).toBe(true);
      expect(capture.pageCounts).toEqual(['32','32','2']); expect(capture.pageEnds).toEqual(['32','64','66']);
      expect(capture.applied).toEqual(['32','64','66',...post]); expect(capture.delivered).toEqual(post); expect(capture.failures).toEqual([]);
    }
    expect(observed[1].renameReceipt && observed[1].taskReceipt).toBe(true);
    stage = 'finite stable completion, assets and private boundary';
    await a.waitForTimeout(500); await quiet();
    for (const [index,page] of pages.entries()) {
      await finalTruth(page); await boundary(page,[contextA,contextB][index]);
      expect(assetSets[index].size).toBe(files.size);
    }
    assetEvidence = await a.evaluate(checkEmbeddedAssets, {secrets:privateMarkers,
      files:await Promise.all([...files].map(async ([path,file]) => [path,[...await readFile(new URL(`../${file}`,import.meta.url))]]))});
    expect(assetEvidence).toEqual({checked:8,failures:[]});
    stage = 'both Disconnect without cancellation and remain stable';
    for (const page of pages) {
      await page.getByRole('button',{name:'Disconnect',exact:true}).click(); await exact(status(page),'disconnected');
      await page.evaluate(() => globalThis.fixedHeadCapture.drain());
      expect(await page.evaluate(() => globalThis.fixedHeadCapture.cleared())).toBe(true);
      expect(await page.locator('.run,.command,.session-list li').count()).toBe(0);
      expect(await page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).every(node => node.value === ''))).toBe(true);
    }
    await a.waitForTimeout(500); await quiet();
    await boundary(a,contextA); await boundary(b,contextB);
    expect(await summary()).toEqual(observed);
    expect(Object.values(faults)).toEqual(Array(6).fill(0));
  } catch (cause) {
    const kind = ['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    failure = new Error(`Fixed head failed: ${stage}; kind=${kind}; capture=${JSON.stringify(observed)}; assets=${JSON.stringify(assetEvidence)}; faults=${JSON.stringify(faults)}; network=${JSON.stringify(network)}`);
  } finally {
    release?.();
    try { await contextA?.close(); cleanup.a = contextA !== undefined; } catch { failure ??= new Error('Fixed head browser cleanup failed'); }
    try { await contextB?.close(); cleanup.b = contextB !== undefined; } catch { failure ??= new Error('Fixed head browser cleanup failed'); }
    // Playwright can still inspect a context whose close failed. Keep the guard until both are gone.
    if (cleanup.a && cleanup.b) {
      if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
    }
    try { await fixture?.stop(); cleanup.fixture = fixture !== undefined; } catch { failure ??= new Error('Fixed head fixture cleanup failed'); }
  }
  console.log(`Fixed head cleanup: a=${cleanup.a} b=${cleanup.b} fixture=${cleanup.fixture}`);
  if (failure) throw failure;
  console.log(`Fixed head evidence: pages=3 counts=32,32,2 through=66 interleaved_head=72 final_head=86 clients=2 rename_posts=1 task_posts=1 provider_connections=1 provider_requests=2 tools=1 stable_ms=500 disconnect_ms=500`);
});
