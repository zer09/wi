import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverFixture } from '../test-support/fixture.mjs';
import { nativeBinding, createRestartRoot, rootProof, terminalProof } from '../test-support/restart-display.mjs';
import { sid, head, title, seedLegacy, snapshot, legacyProof, catalogProof, observerWork, handleFacts, boundary, ownedFilesProof, newFaults } from '../test-support/upgrade-display-parity.mjs';
import { identity, retirement, resources, acquireResource, acquireObserver } from '../test-support/display-measurements.mjs';
import { contentFacts, totalBytes, contentCursor, customProjection, partialDom, partialDomProof, resolveFixture, reserveOutput,
  contentCollector, contentWork, contentDiagnostics, browserTree, retireTree, removable, sourceGuard } from '../test-support/content-measurements.mjs';

async function settled(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
const safeNative = value => {
  if (!value) return null;
  const names=['pid','identity','closed','reaped','code','signal','stderr_bytes','stdout_bytes','error','fallback','drained','input_ended','same_start_alive','cleanup_errors','samples'];
  return Object.fromEntries(names.map(k=>[k,value[k]]));
};
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('one genuine Load older content prepend with original public transport metadata', async ({}, testInfo) => {
  let firstFailure=null, evidenceRoot, fixture, observer, server, browser, context, network, seed, held, binding;
  let bodySucceeded=false, finalDiscovery=false;
  let browserIdentity, nativeIdentity, initial, after, geometry, projection, browserVersion;
  let rootRemoved=false, fallback=false, nativeRetired=[], browserRetired=[], browserMembers=[], treeFacts=[];
  const faults=newFaults(), publicationFailures=[],preparationFailures=[],artifactFailures=[];
  const diagnostic=contentDiagnostics(()=>network?.facts(),faults), operation=diagnostic.operation;
  const freeze=()=>diagnostic.freeze('outside_path');
  const owned=resources(()=>{ firstFailure??=freeze(); });
  function collectorProof() {
    if(!network)throw new Error('Collector unavailable');
    if(bodySucceeded)network.proof();else network.cleanupProof();
    if(Object.values(faults).some(n=>n!==0))throw new Error('Collector rejected');
  }
  async function save(name,value) {
    if (!evidenceRoot) return;
    let bytes;
    try { bytes=`${JSON.stringify(value,null,2)}\n`; }
    catch(error) { publicationFailures.push(name);artifactFailures.push({artifact:name,phase:'serialization'});throw error; }
    try { await writeFile(join(evidenceRoot,name),bytes,{flag:'wx',mode:0o600}); }
    catch(error) { publicationFailures.push(name);artifactFailures.push({artifact:name,phase:'write'});throw error; }
  }
  async function discoverOwned() {
    const tree=await browserTree(browserIdentity);treeFacts.push({ members:tree.members.length, errors:tree.errors });
    if(Object.values(tree.errors).some(n=>n!==0))throw new Error('Browser discovery rejected');
    for(const i of tree.members)if(!browserMembers.some(n=>n.pid===i.pid&&n.start_ticks===i.start_ticks))browserMembers.push(i);
  }
  try {
    evidenceRoot=await reserveOutput(testInfo);
    sourceGuard(await readFile(new URL(import.meta.url),'utf8'),await readFile(new URL('../test-support/content-measurements.mjs',import.meta.url),'utf8'));
    binding=await resolveFixture(process.env, discoverFixture);
    fixture=await acquireResource(owned,'root',90,createRestartRoot,async value=>{
      await rootProof(value,'observe');
      if(!removable(owned.cleanupFailed(),fallback,handleFacts(),nativeRetired,browserRetired))throw new Error('Root retained');
      if(!finalDiscovery)throw new Error('Root retained');collectorProof();
      if(held){customProjection(snapshot(value),seed,held);catalogProof(value);await ownedFilesProof(value);}
      expect(await nativeBinding(binding.executable)).toEqual(binding);
      // File and binding awaits can admit late faults. Check again at deletion admission.
      await network.drain();collectorProof();
      await rm(value.root,{recursive:true});
      try { await lstat(value.root); } catch(error) { if(error.code==='ENOENT')rootRemoved=true; }
      expect(rootRemoved).toBe(true);
    });
    seed=await seedLegacy(fixture,contentFacts());legacyProof(snapshot(fixture),seed);catalogProof(fixture);
    await save('SEED.json',{schema:2,head:Number(head),total_bytes:totalBytes,projection_tables:0,handles:handleFacts(),exported_facts_unchanged:true});
    expect(await nativeBinding(binding.executable)).toEqual(binding);
    observer=await acquireResource(owned,'native-stop',60,()=>acquireObserver(binding,fixture),value=>value.stop());
    owned.register('native-emergency',65,async()=>{
      if(!observer.evidence().closed||!observer.evidence().input_ended) {
        try { await observer.emergency(); } finally { fallback||=observer.evidence().fallback; }
      }
    });
    owned.register('native-retirement',70,async()=>{
      const known=nativeIdentity??observer.evidence().identity;
      if(!known){nativeRetired=[{pid:observer.pid,retirement:'unknown'}];throw new Error('Native ownership unknown');}
      nativeRetired=[await retirement(known)];expect(['absent','reused']).toContain(nativeRetired[0].retirement);
      const native=observer.evidence();terminalProof(native,false);
      if(!native.input_ended || native.cleanup_errors.length)throw new Error('Native cleanup rejected');
      if(bodySucceeded)observerWork(native.samples);else contentWork(native.samples);
    });
    nativeIdentity=await observer.initialize();legacyProof(snapshot(fixture),seed);
    server=await acquireResource(owned,'browser-server-close',40,()=>chromium.launchServer({ host: '127.0.0.1', headless:true }),value=>value.close());
    owned.register('browser-final-discovery',10,async()=>{await discoverOwned();finalDiscovery=true;});
    owned.register('browser-emergency',41,async()=>{
      if(!browserIdentity || browserIdentity.state!=='present')return;
      const current=await retirement(browserIdentity);
      if(current.retirement==='alive'){fallback=true;await server.kill();}
    });
    owned.register('browser-retirement',50,async()=>{
      if(!browserMembers.length)throw new Error('Browser ownership unknown');
      await expect.poll(async()=>{try{browserRetired=await retireTree(browserMembers);return true;}catch{return false;}}).toBe(true);
    });
    const candidate=await identity(server.process().pid);
    expect(candidate.state).toBe('present');expect(candidate.ppid).toBe(process.pid);browserIdentity=candidate;await discoverOwned();
    browser=await acquireResource(owned,'browser-connection-close',30,() => chromium.connect(server.wsEndpoint()),value=>value.close());
    browserVersion=browser.version();expect(browserVersion).toBe('145.0.7632.6');
    context=await acquireResource(owned,'context-close',20,
      ()=>browser.newContext({serviceWorkers:'block',viewport:{width:1000,height:700}}),value=>{
        // Discovery is still observation. Only this close invocation admits SSE cancellation.
        network?.closing();return value.close();
      });
    context.setDefaultTimeout(10_000);context.setDefaultNavigationTimeout(10_000);
    network=contentCollector({origin:observer.origin,owner:fixture.owner,faults});
    owned.register('collector-drain',55,async()=>{await network.drain();collectorProof();});
    await context.route('**/*',network.route);
    context.on('request',network.request);context.on('response',network.response);
    context.on('requestfinished',network.finished);context.on('requestfailed', network.failed);
    const page=await context.newPage();page.on('console',()=>faults.console++);page.on('pageerror',()=>faults.page++);
    const transcript=page.getByRole('region',{name:'Canonical conversation',exact:true});
    const run=transcript.locator(`.run[data-run="${contentFacts()[1].run}"]`);
    await operation('fresh_goto',()=>page.goto(`${observer.origin}/#session=${sid}`));
    await operation('fresh_token_empty',()=>expect(page.getByLabel('Owner token',{exact:true})).toHaveValue(''));
    await operation('fresh_task_empty',()=>expect(page.getByLabel('Task',{exact:true})).toHaveValue(''));
    await operation('fresh_rows_empty',()=>expect(page.locator('.run,.command')).toHaveCount(0));
    await operation('fresh_boundary',()=>boundary(page,context,fixture.owner));
    await operation('token_fill',()=>page.getByLabel('Owner token',{exact:true}).fill(fixture.owner));
    await operation('connect_click',()=>page.getByRole('button',{name:'Connect',exact:true}).click());
    await operation('token_cleared',()=>expect(page.getByLabel('Owner token',{exact:true})).toHaveValue(''));
    await operation('latest_sse_ready',()=>expect.poll(()=>network.ready('latest')&&network.ready('sse')).toBe(true));
    await operation('session_title',()=>expect(page.getByRole('heading',{name:'Canonical session title',exact:true})).toHaveText(title,{useInnerText:false}));
    await operation('streaming_status',()=>expect(page.locator('.topbar [role="status"]')).toHaveText('connected; observation: streaming'));
    await operation('run_count',()=>expect(transcript.locator('.run')).toHaveCount(1));await operation('run_identity',()=>expect(run).toHaveCount(1));
    await operation('partial_dom_poll',()=>expect.poll(async()=>{try{partialDomProof(await partialDom(run));return true;}catch{return false;}}).toBe(true));
    await operation('initial_settled',()=>settled(page));initial=await operation('initial_dom',async()=>partialDomProof(await partialDom(run)));
    geometry=await operation('geometry_read',()=>transcript.evaluate(n=>({height:n.scrollHeight,viewport:n.clientHeight,top:n.scrollTop})));
    await operation('viewport_filled',()=>expect(geometry.height>geometry.viewport).toBe(true));
    held=await operation('initial_snapshot',()=>snapshot(fixture));projection=await operation('initial_projection',()=>customProjection(held,seed));
    await operation('initial_catalog',()=>catalogProof(fixture));await operation('initial_files',()=>ownedFilesProof(fixture));await operation('initial_sample',()=>observer.sample());
    await operation('no_content',()=>expect(network.facts().counts.content).toBe(0));await operation('no_setup_content',()=>expect(network.facts().counts.setup_content).toBe(0));
    await operation('no_other_older',()=>expect(network.facts().counts.before+network.facts().counts.within+network.facts().counts.entry).toBe(0));
    // Build the exact cursor from the fixture and verified DOM boundary before the real action.
    const expectedCursor=await operation('content_cursor',()=>contentCursor(initial.from_byte));await operation('content_arm',()=>network.arm(expectedCursor));
    await operation('content_click',()=>page.getByRole('button',{ name: 'Load older', exact: true }).click());
    await operation('content_ready',()=>expect.poll(()=>network.ready('content')).toBe(true));
    await operation('prepend_dom_poll',()=>expect.poll(async()=>{try{partialDomProof(await partialDom(run),initial);return true;}catch{return false;}}).toBe(true));
    await operation('prepend_settled',()=>settled(page));after=await operation('prepend_dom',async()=>partialDomProof(await partialDom(run),initial));
    await operation('retained_settled',()=>settled(page));await operation('retained_dom',async()=>expect(partialDomProof(await partialDom(run),initial)).toEqual(after));
    await operation('retained_projection',()=>customProjection(snapshot(fixture),seed,held));await operation('retained_catalog',()=>catalogProof(fixture));
    await operation('content_sample',()=>observer.sample());await operation('content_discovery',()=>discoverOwned());
    await operation('privacy_boundary',()=>boundary(page,context,fixture.owner));await operation('commands_empty',()=>expect(page.locator('.command')).toHaveCount(0));
    await operation('task_empty',()=>expect(page.getByLabel('Task',{exact:true})).toHaveValue(''));await operation('content_drain',()=>network.drain());
    await operation('content_proof',()=>expect(network.proof().assets).toBe(9));await operation('zero_faults',()=>expect(Object.values(faults).every(n=>n===0)).toBe(true));
    bodySucceeded=true;
  } catch(error) {
    firstFailure??=freeze();owned.fail(error);
    try { await save('FAILURE_BEFORE_CLEANUP.json',firstFailure); } catch(publication) { owned.fail(publication); }
  } finally {
    const cleanup=await owned.cleanup();let bindingAfter=null,bindingUnchanged=false;
    if(network){try{await network.drain();collectorProof();}catch(error){cleanup.error??=error;cleanup.steps.push({name:'final-collector',ok:false});firstFailure??=freeze();}}
    try {
      bindingAfter=binding?await nativeBinding(binding.executable).catch(()=>null):null;
      bindingUnchanged=JSON.stringify(bindingAfter)===JSON.stringify(binding);
      if(!bindingUnchanged)throw new Error('Binding changed');
    } catch(error) { cleanup.error??=error;firstFailure??=freeze(); }
    // Late evidence faults cannot undo a root removal that already passed cleanup checks.
    const cleanupSafe=cleanup.steps.every(step=>step.ok)&&rootRemoved&&!fallback&&bindingUnchanged;
    const cleanupFacts={pass:cleanupSafe,body_success:bodySucceeded,steps:cleanup.steps,root_removed:rootRemoved,final_discovery:finalDiscovery,
      retained_root:fixture&&!rootRemoved?fixture.root:null,fallback,native:null,native_retirement:nativeRetired,
      browser_retirement:browserRetired,browser_discovery:treeFacts,handles:null,binding_unchanged:bindingUnchanged,first_failure:firstFailure,
      availability:{native:observer?'unavailable':'not_acquired',handles:'unavailable'},preparation_failures:preparationFailures};
    function prepare(name,field,read) {
      try { return read(); }
      catch(error) { preparationFailures.push({artifact:name,field});cleanup.error??=error;firstFailure??=freeze();return null; }
    }
    for(const [name,build] of [
      ['CLEANUP.json',()=>{
        if(observer){cleanupFacts.native=prepare('CLEANUP.json','native',()=>safeNative(observer.evidence()));
          if(cleanupFacts.native!==null)cleanupFacts.availability.native='available';}
        cleanupFacts.handles=prepare('CLEANUP.json','handles',()=>handleFacts());
        if(cleanupFacts.handles!==null)cleanupFacts.availability.handles='available';
        cleanupFacts.first_failure=firstFailure;return cleanupFacts;
      }],
      ['MEASUREMENTS.json',()=>{
        const measured=bodySucceeded?prepare('MEASUREMENTS.json','network',()=>structuredClone(network.facts())):null;
        let networkAvailability='not_claimed';if(bodySucceeded)networkAvailability=measured===null?'unavailable':'available';
        return {body_success:bodySucceeded,network:measured,availability:{network:networkAvailability},
          initial:bodySucceeded?initial:null,after:bodySucceeded?after:null,geometry:bodySucceeded?geometry:null,projection:bodySucceeded?projection:null,
          original_api_body_read:false,helper_http_reads:0,compact_fragment_cap:32768,entry_page_cap:524288,
          observation:bodySucceeded?'One instrumented original content transport sample. Response includes repeated compact block/human and addressed entry, not just appended text.':'Body failed; no content or projection proof claimed.',
          limits:['Not SQL or server CPU time.','Not ordinary latency, SLA or statistics.','No anchor certification, complete traversal or memory measurement.']};
      }],
      ['BROWSER_RESULT.json',()=>{
        const counts=network?prepare('BROWSER_RESULT.json','counts',()=>structuredClone(network.facts().counts)):null;
        let countsAvailability='not_acquired';if(network)countsAvailability=counts===null?'unavailable':'available';
        return {status:bodySucceeded&&!cleanup.error&&cleanupSafe&&!preparationFailures.length&&!publicationFailures.length?'PASS':'FAILED',fresh_cases:1,chromium:browserVersion??null,
          counts,availability:{counts:countsAvailability},first_failure:firstFailure,cleanup:cleanupSafe,
          preparation_failures:preparationFailures,publication_failures:publicationFailures,artifact_failures:artifactFailures,
          binding:binding??null,binding_after:bindingAfter,no_retry:true,ordinary_testinfo_output:true};
      }]
    ]) {
      try{await save(name,build());}catch(error){cleanup.error??=error;firstFailure??=freeze();}
    }
    if(cleanup.error)throw cleanup.error;
    if(!bodySucceeded||!cleanupSafe||preparationFailures.length||publicationFailures.length)throw new Error('C53 content case failed; sanitized evidence saved');
  }
});
