import { expect, test } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startFixture, fixtureRootAbsent } from '../test-support/fixture.mjs';
import { linuxProcess, executableBinding, strictStop } from '../test-support/skill-source-fidelity.mjs';
import { expectedBlock, displayedBlock, normalizedDom } from '../test-support/rich-display-parity.mjs';
import { decodeJson, validateCreateView, validateSessionListView, validateRenameCommand, validateTaskCommand } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { TITLE, RENAMED, TASK, requireProof, equalProof, withoutId, pageProof, proveActiveRename,
  proveSavedHistory, ownedWorkspace, runOwned, handshakeProof } from '../test-support/saved-history-active-rename.mjs';

const DIGEST = process.env.WI_C3A_FIXTURE_SHA256;
const markers = ['synthetic-replay-', 'private-operator-', 'private-project-', 'private-skill-', 'private-support-',
  'private-native', 'private-data', 'private-skills', 'private-config-canary', 'principal_digest', 'encrypted_content',
  'opaque_response', 'provider_session_id', 'prepared_request'];
const hash = value => createHash('sha256').update(value).digest('hex');
async function exact(locator, text) { await expect.poll(async () => await locator.textContent() === text).toBe(true); }
async function typed(reply, validate) {
  const bytes = await reply.body();
  requireProof(bytes.length <= 512 * 1024, 'page');
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), reply.headers()['content-type'], validate);
}
async function independent(fixture, path, validate) {
  const r = await fetch(fixture.origin + path, { headers: { Authorization: `Bearer ${fixture.owner}`, Accept: 'application/json' },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  requireProof(r.status === 200 && r.headers.get('cache-control') === 'no-store', 'page');
  const bytes = await r.arrayBuffer(); requireProof(bytes.byteLength <= 512 * 1024, 'page');
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), r.headers.get('content-type'), validate);
}
async function catalogDom(page) {
  return page.locator('.session-list li').evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector('button').textContent,
    current: node.querySelector('button').getAttribute('aria-current'), metadata: node.querySelector('.metadata').textContent })));
}
async function boundary(page, context, owner) {
  const safe = await page.evaluate(async ({ owner, markers }) => {
    const clone = document.documentElement.cloneNode(true);
    for (const field of clone.querySelectorAll('[data-field]')) {
      if (!/^(text|[0-9a-f]{64})$/.test(field.dataset.field) || field.dataset.field === owner) return false;
      field.removeAttribute('data-field');
    }
    const values = [clone.outerHTML, location.href, JSON.stringify(history.state),
      ...Array.from(document.querySelectorAll('input,textarea,select'), n => n.value)];
    return values.every(v => !v || (!v.includes(owner) && !markers.some(m => v.includes(m))))
      && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
      && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0
      && (await navigator.serviceWorker.getRegistrations()).length === 0
      && document.querySelectorAll('.layout em,.layout script,.layout img,.layout a,.layout iframe,.layout svg,.layout object,.layout embed').length === 0;
  }, {owner,markers});
  requireProof(safe && (await context.cookies()).length === 0, 'privacy');
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('saved populated history survives absent recorded workspace after Rename during active execution', async ({ browser }, info) => {
  const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  let stage = 'acquire', fixture, sid, workspace, command, receipt, completed, owner, root, nativeIdentity;
  const result = { body_success: false, first: null, cleanup: null, facts: {}, helper_reads: 0 };
  const records = [], assets = [], faults = { traffic: 0, response: 0, console: 0, page: 0, privacy: 0, asset: 0 };
  const files = new Map([['/', 'index.html'], ['/assets/wi.css','style.css'],
    ...['api','app','display-api','display-client','display-store','display-view','sse'].map(n => [`/assets/${n}.js`,`dist/${n}.js`])]);
  const output = info.outputPath('c57');
  await mkdir(output, {mode:0o700});
  await writeFile(join(output,'CASE.once'), 'C57 fresh case\n', {flag:'wx',mode:0o600});
  const executable = process.env.WI_C3A_FIXTURE;
  async function checkFaults() {
    await Promise.all(assets);
    requireProof(Object.values(faults).every(v => v === 0), 'privacy');
    for (const record of records) requireProof(record.assets.size === files.size, 'assets');
  }
  async function readPage() {
    result.helper_reads++;
    return independent(fixture, `/v1/sessions/${sid}/conversation`, v => validateConversationPage(v,{kind:'latest'},sid));
  }
  async function makeContext(own, observer) {
    const context = await browser.newContext({serviceWorkers:'block'});
    const close = own(observer ? 'fresh-context' : 'original-context', async () => {
      record.closing = true;
      try { if (record.page) await boundary(record.page, context, fixture.owner); }
      finally { await context.close(); }
    });
    const record = {requests:[],snapshots:[],streams:[],assets:new Set(),closing:false,page:null};
    records.push(record);
    const leaked = text => text.includes(fixture.owner) || markers.some(m => text.includes(m));
    await context.route('**/*', async route => {
      try { if (new URL(route.request().url()).origin !== fixture.origin) {faults.traffic++;await route.abort();} else await route.continue(); }
      catch { if (!record.closing) faults.traffic++; }
    });
    context.on('request', request => {
      try {
        const url = new URL(request.url()), method = request.method(), base = `/v1/sessions/${sid}`;
        if (leaked(request.url())) faults.privacy++;
        const allowedGet = method === 'GET' && (files.has(url.pathname) || url.pathname === '/v1/settings'
          || (url.pathname === '/v1/sessions' && url.search === '?limit=32')
          || (sid && ((url.pathname === base || url.pathname === base+'/conversation') && url.search === ''
            || url.pathname === base+'/conversation/events' && url.searchParams.size === 1 && url.searchParams.has('after'))));
        const allowedPost = !observer && method === 'POST' && url.search === ''
          && (url.pathname === '/v1/sessions' || (sid && [base+'/runs',base+'/rename'].includes(url.pathname)));
        if (url.origin !== fixture.origin || (!allowedGet && !allowedPost)) faults.traffic++;
        record.requests.push({method,path:url.pathname});
        if (url.pathname.endsWith('/conversation/events')) record.streams.push({request,index:record.requests.length,response:null});
      } catch {faults.traffic++;}
    });
    context.on('response', reply => {
      try {
        const path = new URL(reply.url()).pathname;
        if (reply.status() >= 300) faults.response++;
        if (path.endsWith('/conversation')) record.snapshots.push({request:reply.request(),response:reply,index:record.requests.length});
        const stream = record.streams.find(s => s.request === reply.request()); if (stream) stream.response = reply;
        const file = files.get(path);
        if (file) assets.push((async () => {
          const bytes = await reply.body();
          if (leaked(bytes.toString()) || !bytes.equals(await readFile(new URL(`../${file}`,import.meta.url)))) faults.asset++;
          record.assets.add(path);
        })().catch(()=>{faults.asset++;}));
      } catch {faults.response++;}
    });
    const page = await context.newPage(); record.page = page;
    page.on('console', message => { if (leaked(message.text())) faults.privacy++; if (message.type() === 'error') faults.console++; });
    page.on('pageerror', () => {faults.page++;});
    return {context,page,record,close};
  }
  try {
    await runOwned(async own => {
      try {
        requireProof(typeof DIGEST === 'string' && DIGEST.length === 64 && /^[0-9a-f]{64}$/.test(DIGEST), 'acquire');
        await executableBinding(executable,DIGEST);
        fixture = await startFixture(executable,{transport:'websocket',recovered:false,mime:true,mutations:true});
        own('fixture', async () => {
          let faultsFailed = false;
          try { await checkFaults(); } catch { faultsFailed = true; }
          try { await fixture.stop(); } finally { result.facts.stop = fixture.evidence(); }
          strictStop(fixture.evidence());
          if (root) {
            await fixtureRootAbsent(root);
            let retired = false;
            try { const current = await linuxProcess(root.pid); retired = current.start !== root.start; }
            catch (error) { if (error.code === 'ENOENT') retired = true; else throw error; }
            requireProof(retired,'cleanup'); result.facts.native_retired = true;
          }
          requireProof(!faultsFailed, 'privacy');
        });
        const original = await makeContext(own,false), {page} = original;
        stage = 'connect-create';
        await page.goto(fixture.origin+'/');
        await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
        await page.getByRole('button',{name:'Connect',exact:true}).click();
        await expect(page.getByLabel('Owner token',{exact:true})).toHaveValue('');
        await exact(page.locator('.topbar [role="status"]'),'connected');
        const options = await page.getByLabel(/^Workspace/).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));
        workspace = options.find(p=>p.endsWith('/workspace'));
        requireProof(typeof workspace === 'string' && options.length === 2,'ownership');
        await page.getByLabel(/^Workspace/).selectOption(workspace);
        await page.getByLabel('Title',{exact:true}).fill(TITLE);
        const [createdReply] = await Promise.all([
          page.waitForResponse(r=>r.url() === fixture.origin+'/v1/sessions' && r.request().method() === 'POST'),
          page.getByRole('button',{name:'Create session',exact:true}).click(),
        ]);
        requireProof(createdReply.status() === 201,'acquire');
        const created = await typed(createdReply,validateCreateView); sid = created.session_id;
        await exact(page.locator('.command h3'),'create: accepted');
        await page.getByRole('button',{name:'Open receipt session',exact:true}).click();
        await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),TITLE);
        await exact(page.locator('.conversation > div > .metadata').first(),'Observation: streaming');
        await fixture.request({command:'select',session_id:sid});
        const base = `/v1/sessions/${sid}`, run = page.locator('.run');
        const readCatalog = async () => {result.helper_reads++;return independent(fixture,'/v1/sessions?limit=32',validateSessionListView);};
        const taskArticle = page.locator('.command').filter({has:page.getByRole('heading',{name:/^task:/})});
        const io = {
          async refreshCatalog() {
            stage = 'catalog';
            const [reply] = await Promise.all([page.waitForResponse(r=>r.url() === fixture.origin+'/v1/sessions?limit=32' && r.request().method() === 'GET'),
              page.getByRole('button',{name:'Refresh list',exact:true}).click()]);
            requireProof(reply.status() === 200,'catalog');
            const value = await readCatalog();
            await expect.poll(async()=>await page.locator('.session-list button').allTextContents()).toEqual(value.entries.map(e=>e.title));
            await expect(page.getByText('Catalog as of its last refresh. ID order, not activity order.',{exact:true})).toBeVisible();
            return {value,dom:await catalogDom(page)};
          },
          async catalogDom() {return catalogDom(page);},
          async startTask() {
            stage = 'task';
            await page.getByLabel('Task',{exact:true}).fill(TASK);
            const [reply] = await Promise.all([page.waitForResponse(r=>r.url() === fixture.origin+base+'/runs' && r.request().method() === 'POST'),
              page.getByRole('button',{name:'Send',exact:true}).click()]);
            requireProof(reply.status() === 202,'native'); command = validateTaskCommand(reply.request().postDataJSON());
            receipt = (await typed(reply,v=>validateDisplayTaskAccepted(v,{...command,session_id:sid}))).receipt;
            await exact(taskArticle.locator('h3'),'task: accepted');
            await fixture.wait('model_paused',1);await fixture.request({command:'drive',gate:1});
            await fixture.wait('model_paused',2);await fixture.request({command:'drive',gate:2});
            await fixture.wait('model_paused',3);
            return {command,receipt};
          },
          async capture(done,title) {
            stage = done ? 'completed' : title === TITLE ? 'held' : 'renamed';
            const native = await fixture.inspect(), value = await readPage();
            pageProof(value,{sid,workspace,title,native,command,receipt,completed:done});
            await expect(run).toHaveCount(1);
            await expect.poll(async()=>await displayedBlock(run)).toEqual(expectedBlock(value));
            await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),title);
            await exact(page.locator('.conversation > .metadata'),`Workspace: ${workspace}\nSession: ${sid}`);
            await boundary(page,original.context,fixture.owner);await checkFaults();
            result.facts[stage] = {head:value.snapshot_head,gate:native.gate,requests:native.requests,completed:native.completed,
              entries:value.entries.length+1, accepted:native.accepted.length, receipts:native.receipts.length,
              work:Object.fromEntries(['connections','auth_loads','auth_prepares','prepared_exact','fresh_parents','continuations',
                'tool_results','terminals','results','provider_stage'].map(k=>[k,native[k]])),
              response_finishes:native.response_finishes, page_sha256:hash(JSON.stringify(value)),dom_sha256:hash(await normalizedDom(run))};
            return {native,page:value,dom:await normalizedDom(run)};
          },
          async rename() {
            stage = 'rename';
            await page.getByLabel('Exact new title',{exact:true}).fill(RENAMED);
            const [reply] = await Promise.all([page.waitForResponse(r=>r.url() === fixture.origin+base+'/rename' && r.request().method() === 'POST'),
              page.getByRole('button',{name:'Rename session',exact:true}).click()]);
            const value = await typed(reply,v=>v), command = validateRenameCommand(reply.request().postDataJSON());
            const article=page.locator('.command').filter({has:page.getByRole('heading',{name:/^rename:/})});
            await exact(article.locator('h3'),'rename: accepted');
            await expect(article.locator(':scope > pre')).toContainText('Independent catalog refresh: updated');
            return {status:reply.status(),value,command};
          },
          async finish() {stage='finish';await fixture.request({command:'drive',gate:3});await fixture.wait('task_finished',1);},
          async inspect() {return fixture.inspect();},
        };
        completed = await proveActiveRename(io,{sid,workspace});
        result.facts.catalog = { ids: completed.catalogIds, renamed_head: completed.renameReceipt.last_sequence,
          catalog_refresh: 'updated', cardinality: completed.catalogIds.length };
        handshakeProof({origin:fixture.origin,sid,page:{snapshot_head:'1',live_after:`g11l.${Buffer.from(JSON.stringify([1,sid,'1','3','',''])).toString('base64url')}`},
          snapshots:original.record.snapshots,streams:original.record.streams});
        equalProof(original.record.requests.filter(r=>r.method==='POST').map(r=>r.path),['/v1/sessions',base+'/runs',base+'/rename'],'traffic');
        stage='workspace-bind';root=await fixture.bindRoot();nativeIdentity=await linuxProcess(fixture.pid);
        owner=await ownedWorkspace({fixture,root,workspace,executable,completed:completed.final.native,tmpdir:tmpdir()});
        result.facts.ownership=owner.facts;
        await proveSavedHistory({
          async move() {stage='workspace-move';await owner.move();result.facts.moved_once=true;},
          async absent() {await owner.absent();result.facts.original_absent=true;},
          async closeOriginal() {stage='close-original';await original.close();},
          async fresh() {
            stage='fresh-connect';
            const fresh=await makeContext(own,true),p=fresh.page;
            await p.goto(`${fixture.origin}/#session=${sid}`);
            await expect(p.getByLabel('Owner token',{exact:true})).toHaveValue('');
            await expect(p.locator('.run')).toHaveCount(0);
            const responses = Promise.all([
              p.waitForResponse(r=>r.url() === fixture.origin+base+'/conversation' && r.request().method() === 'GET'),
              p.waitForResponse(r=>new URL(r.url()).pathname === base+'/conversation/events' && r.request().method() === 'GET'),
            ]);
            await p.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
            await p.getByRole('button',{name:'Connect',exact:true}).click();
            const [latest, stream] = await responses;
            requireProof(latest.status() === 200 && stream.status() === 200, 'handshake');
            await expect(p.getByLabel('Owner token',{exact:true})).toHaveValue('');
            await exact(p.locator('.conversation > div > .metadata').first(),'Observation: streaming');
            const value=await readPage();
            handshakeProof({origin:fixture.origin,sid,page:value,snapshots:fresh.record.snapshots,streams:fresh.record.streams});
            const native=await fixture.inspect();pageProof(value,{sid,workspace,title:RENAMED,native,command,receipt,completed:true});
            await expect(p.locator('.run')).toHaveCount(1);
            await expect.poll(async()=>await displayedBlock(p.locator('.run'))).toEqual(expectedBlock(value));
            await exact(p.getByRole('heading',{name:'Canonical session title',exact:true}),RENAMED);
            await exact(p.locator('.conversation > .metadata'),`Workspace: ${workspace}\nSession: ${sid}`);
            await boundary(p,fresh.context,fixture.owner);await checkFaults();
            equalProof(await linuxProcess(fixture.pid),nativeIdentity,'ownership');
            result.facts.fresh={head:value.snapshot_head,latest:1,sse:1,posts:fresh.record.requests.filter(r=>r.method==='POST').length,
              dom_sha256:hash(await normalizedDom(p.locator('.run')))};
            return {native,page:value,dom:await normalizedDom(p.locator('.run')),posts:result.facts.fresh.posts};
          },
        },completed);
        await checkFaults();equalProof(withoutId(await fixture.inspect()),withoutId(completed.final.native),'native');
        result.body_success=true;
      } catch (error) {
        let code = 'verification_failure';
        if (/^C57:[a-z]+$/.test(error?.message ?? '')) code = error.message.slice(4);
        result.first = { stage, code };
        throw new Error(`C57:${code}`);
      }
    },async packet=>{
      result.cleanup=packet.cleanup;result.body_failed=packet.body_failed;result.success=packet.success;
      result.faults={...faults};result.traffic=records.map(r=>({requests:r.requests,assets:r.assets.size,latest:r.snapshots.length,sse:r.streams.length}));
      if(fixture)result.stop=fixture.evidence();
      await executableBinding(executable,DIGEST);
      await writeFile(join(output,'RESULT.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
    });
  } finally {
    if(previous===undefined)delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;else process.env.PLAYWRIGHT_NO_COPY_PROMPT=previous;
  }
});
