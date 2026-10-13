import { test, expect } from '@playwright/test';
import { lstat, rm } from 'node:fs/promises';
import { discoverFixture } from '../test-support/fixture.mjs';
import { nativeBinding, createRestartRoot, startRestartProcess, publicJson, rootProof, terminalProof, processIdentity } from '../test-support/restart-display.mjs';
import { displayedBlock, normalizedDom } from '../test-support/rich-display-parity.mjs';
import { sid, head, title, facts, previous, digest, seedLegacy, snapshot, legacyProof, upgradedProof, catalogProof, pageProof, entryProof,
  domProof, sameDom, newRecord, newFaults, collector, observationOrder, observerWork, requestProof, handleFacts, cleanupProof, removeUpgradeRoot,
  boundary, publicPrivacy, connectDiagnostics, reportUpgradeFailure } from '../test-support/upgrade-display-parity.mjs';

async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('genuine legacy schema2 first browser upgrade and distinct-process same-H warm reopen preserve exact A/B display', async ({ browser }) => {
  let fixture, seed, held, failure, connect, rootRemoved = false, stage = 'binding', check = 'binding';
  const processes = [], contexts = [], records = [newRecord(),newRecord()], closed = [false,false];
  const faults = newFaults(), assetReads = [], helperRequests = [], dom = [], proofs = [], orders = [], preOpen = [], geometry = [];
  try {
    const binding = await nativeBinding(await discoverFixture());
    console.log(`Upgrade parity binding: ${JSON.stringify(binding)}`);
    fixture = await createRestartRoot(); stage = 'seed'; check = 'legacy'; seed = await seedLegacy(fixture);
    console.log(`Upgrade parity seed: ${JSON.stringify({ version:seed.before.version, schema:seed.before.schema, head, canonical:digest(JSON.stringify(seed.canonical)),
      definitions:digest(JSON.stringify(seed.definitions)), fixture_hashes:seed.fixture_hashes, runs:2, tools:2, actual_executions:0, missing_catalog_retained:true, handles:handleFacts() })}`);
    for (const index of [0,1]) {
      connect=undefined;
      stage = index === 0 ? 'upgrade' : 'reopen'; check = 'pre-spawn';
      expect(await nativeBinding(binding.executable)).toEqual(binding);
      const process = await startRestartProcess(binding,fixture,'observe'); processes.push(process);
      await process.request({ command:'select', session_id:sid });
      const order = observationOrder(); order.selected(); orders.push(order);
      await process.sample();
      if (index === 0) legacyProof(snapshot(fixture),seed); else upgradedProof(snapshot(fixture),seed,held);
      const r = records[index], c = collector({ origin:process.origin, owner:fixture.owner, record:r, faults, assetReads });
      const context = await browser.newContext({ serviceWorkers:'block', viewport:{ width:1000,height:700 } }); contexts.push(context);
      await context.route('**/*', async route => {
        // This read-only check runs before the original Latest is released, never before a helper Latest.
        if (route.request().url() === `${process.origin}/v1/sessions/${sid}/conversation`) {
          try {
            const before = snapshot(fixture);
            if (index === 0) legacyProof(before,seed); else upgradedProof(before,seed,held);
            preOpen.push({ index,version:before.version,head:String(before.canonical.manifest[0][7]),projection_tables:before.names.length,handles:handleFacts() });
          } catch { faults.collector++; }
        }
        await c.route(route);
      });
      context.on('request',c.request); context.on('response',c.response);
      const page = await context.newPage(); page.on('console',()=>{faults.console++;}); page.on('pageerror',()=>{faults.page++;});
      const transcript = page.getByRole('region',{ name:'Canonical conversation',exact:true });
      const status = page.locator('.topbar [role="status"]');
      const run = task => transcript.locator(`.run[data-run="${facts[task].run}"]`);
      async function display(task) {
        await expect(run(task)).toHaveCount(1);
        await expect.poll(async()=>{try{return domProof(await displayedBlock(run(task)),task);}catch{return false;}}).toBe(true);
        return normalizedDom(run(task));
      }
      async function read(suffix, validate, kind) {
        return order.read(async()=>{
          helperRequests.push({index,method:'GET',kind});
          const value=await publicJson(process,fixture.owner,suffix,validate);publicPrivacy(value,fixture.owner);return value;
        });
      }
      check='fresh';await page.goto(`${process.origin}/#session=${sid}`);
      await expect(page.getByLabel('Owner token',{exact:true})).toHaveValue(''); await expect(page.getByLabel('Task',{exact:true})).toHaveValue('');
      await expect(page.locator('.run,.command')).toHaveCount(0);expect(r.requests.every(q=>!q.path.startsWith('/v1/'))).toBe(true);
      await boundary(page,context,fixture.owner);
      check='connect';connect=connectDiagnostics(index,r,faults);
      const [reply] = await Promise.all([connect.operation('latest_response',()=>page.waitForResponse(q=>r.snapshots.some(s=>s.request===q.request()))),(async()=>{
        await connect.operation('token_fill',()=>page.getByLabel('Owner token',{exact:true}).fill(fixture.owner));
        await connect.operation('connect_click',()=>page.getByRole('button',{name:'Connect',exact:true}).click());
      })()]);
      await connect.operation('token_cleared',()=>expect(page.getByLabel('Owner token',{exact:true})).toHaveValue(''));
      await connect.operation('streaming_status',()=>exact(status,'connected; observation: streaming'));
      await connect.operation('sse_200',()=>expect.poll(()=>r.streams[0]?.reply?.status()).toBe(200));
      check='original-b';const newestDom=await display(1);await expect(transcript.locator('.run')).toHaveCount(1);
      await exact(page.getByRole('heading',{name:'Canonical session title',exact:true}),title);
      order.displayed(r,reply);r.newest=true;r.events.push('newest-rendered');
      check='upgraded';const upgraded=snapshot(fixture);upgradedProof(upgraded,seed,held);catalogProof(fixture);
      if(index===0)held=upgraded;
      await process.sample();
      check='independent-dto';
      const latest=await read(`/v1/sessions/${sid}/conversation`,v=>pageProof(v,1),'latest');
      order.handshake(r,reply,latest,process.origin);
      expect(latest.previous_block).toBe(previous);
      for(const entry of [latest.block.human,...latest.entries]) await read(`/v1/sessions/${sid}/conversation/entries/${facts[1].run}/${encodeURIComponent(entry.entry_id)}`,v=>entryProof(v,1,entry),'entry-b');
      check='overflow';await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expect(await transcript.evaluate(n=>n.scrollHeight>n.clientHeight)).toBe(true);expect(r.older.length).toBe(0);
      // Near-top positioning is setup. Only the genuine Home key grants upward intent.
      check='setup';await transcript.evaluate(n=>{n.scrollTop=0;});await transcript.focus();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      r.prekey=await transcript.evaluate(n=>({focused:document.activeElement===n,top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight}));
      r.setup_reads=r.older.length;expect(r.setup_reads).toBe(0);expect(r.prekey.focused&&r.prekey.top>=0&&r.prekey.top<=96&&r.prekey.height>r.prekey.viewport).toBe(true);
      geometry.push({...r.prekey,setup_reads:r.setup_reads});
      check='upward';r.events.push('upward-intent');r.intent=true;await page.keyboard.press('Home');
      await expect.poll(()=>r.older.length).toBe(1);await expect.poll(()=>r.older[0]?.response?.status()).toBe(200);
      expect(r.older[0].request.url()).toBe(`${process.origin}/v1/sessions/${sid}/conversation?before=${encodeURIComponent(latest.previous_block)}`);
      check='older';const older=await read(`/v1/sessions/${sid}/conversation?before=${encodeURIComponent(latest.previous_block)}`,v=>pageProof(v,0),'older-a');
      const olderDom=await display(0);domProof(await displayedBlock(run(1)),1);sameDom(await normalizedDom(run(1)),newestDom);
      expect(await transcript.locator('.run').evaluateAll(ns=>ns.map(n=>n.dataset.run))).toEqual(facts.map(f=>f.run));
      for(const entry of [older.block.human,...older.entries]) await read(`/v1/sessions/${sid}/conversation/entries/${facts[0].run}/${encodeURIComponent(entry.entry_id)}`,v=>entryProof(v,0,entry),'entry-a');
      r.events.push('older-rendered');
      if(index===0){dom.push(olderDom,newestDom);proofs.push(older,latest);}else{sameDom(olderDom,dom[0]);sameDom(newestDom,dom[1]);expect(older).toEqual(proofs[0]);expect(latest).toEqual(proofs[1]);}
      check='privacy';await expect(page.locator('.command')).toHaveCount(0);await expect(page.getByLabel('Task',{exact:true})).toHaveValue('');await boundary(page,context,fixture.owner);
      await Promise.all(assetReads);requestProof(r);orders[index]=order.finish(r);expect(Object.values(faults).every(n=>n===0)).toBe(true);
      upgradedProof(snapshot(fixture),seed,held);await process.sample();
      check='close';await context.close();closed[index]=true;await process.sample();
      check='stop';await process.stopObserver();terminalProof(process.evidence(),false);observerWork(process.evidence().samples);
      const current=await processIdentity(process.pid);expect(!current||current.start_ticks!==process.evidence().identity.start_ticks).toBe(true);
      upgradedProof(snapshot(fixture),seed,held);catalogProof(fixture);expect(handleFacts().active).toBe(0);
    }
    check='final';expect(preOpen.map(p=>[p.version,p.head,p.projection_tables])).toEqual([[2,head,0],[3,head,5]]);
    expect(processes[0].pid!==processes[1].pid).toBe(true);
    console.log(`Upgrade parity proof: ${JSON.stringify({ head,preOpen,canonical:digest(JSON.stringify(held.canonical)),projection:digest(JSON.stringify(held.projection)),
      dto:proofs.map(p=>digest(JSON.stringify(p))),dom:dom.map(digest),geometry,orders,helpers:helperRequests,work:processes.map(p=>p.evidence().samples),
      latest:records.map(r=>r.snapshots.length),streams:records.map(r=>r.streams.length),older:records.map(r=>r.older.length),mutations:records.map(r=>r.requests.filter(q=>q.method!=='GET').length),
      assets:records.map(r=>r.assets.size),faults,preparing_label:'final streaming status observed; transient Preparing timing not claimed',original_body_read:false,
      stable_warm_rows:true,sql_trace_no_backfill:false,actual_tool_executions:0,chromium:browser.version() })}`);
    stage='cleanup';rootRemoved=await removeUpgradeRoot(fixture,processes,closed);
    cleanupProof({closed,rootRemoved,processes:processes.map(p=>p.evidence()),handles:handleFacts()});
  } catch(error) {
    failure=reportUpgradeFailure(error,stage,check,connect);
  } finally {
    for(const [index,context] of contexts.entries()) if(!closed[index]) { try{await context.close();closed[index]=true;}catch{failure??=new Error('Upgrade context cleanup failed');} }
    for(const process of processes) if(!process.evidence().closed) { try{await process.fallback();}catch{failure??=new Error('Upgrade process cleanup failed');} }
    if(fixture&&!rootRemoved) {
      try{await rootProof(fixture,'observe');if(handleFacts().active!==0||processes.some(p=>!p.evidence().reaped))throw new Error('Upgrade failure cleanup rejected');
        await rm(fixture.root,{recursive:true});try{await lstat(fixture.root);}catch(e){if(e.code==='ENOENT')rootRemoved=true;}}
      catch{failure??=new Error('Upgrade root cleanup failed');}
    }
    const cleanup={closed,rootRemoved,processes:processes.map(p=>p.evidence()),handles:handleFacts(),failed:failure!==undefined};
    if(!failure){try{cleanupProof(cleanup);}catch{failure=new Error('Upgrade cleanup rejected');cleanup.failed=true;}}
    console.log(`Upgrade parity cleanup: ${JSON.stringify(cleanup)}`);
  }
  if(failure)throw failure;
});
