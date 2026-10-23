import { test, expect } from '@playwright/test';
import { readFile, lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture, captureGate11, requireGate11, fixtureRootAbsent, evaluateSkillCleanup } from '../test-support/fixture.mjs';
import { data } from '../test-support/presentation.mjs';
import { decodeJson, validateCreateView, validateTaskCommand, validateUuid } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { expectedBlock, displayedBlock, normalizedDom, freshHandshake, readOnly } from '../test-support/rich-display-parity.mjs';
import { ownedSkill, executableBinding, completeProof, savedProof, nativeCompletion, unchangedNative, observerOrder, strictStop } from '../test-support/skill-source-fidelity.mjs';

async function exact(locator, value) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === value).toBe(true);
}
export function allowedRequest(method, url, sid, permission) {
  if (method === 'GET') {
    if (url.pathname === '/v1/settings') return url.search === '';
    if (url.pathname === '/v1/sessions') return true;
    if (!sid) return false;
    const base = `/v1/sessions/${sid}`;
    if (url.pathname === base) return url.search === '';
    const params = [...url.searchParams];
    if (url.pathname === `${base}/conversation/events`) return params.length === 1 && params[0][0] === 'after' && parseDisplayCursor(params[0][1], 'live', sid) !== null;
    if (url.pathname === `${base}/conversation`) {
      if (url.search === '') return true;
      if (params.length !== 1 || !['before','within'].includes(params[0][0])) return false;
      return parseDisplayCursor(params[0][1], params[0][0] === 'before' ? 'block' : 'activity', sid) !== null;
    }
    if (url.pathname === `${base}/conversation/content`) return params.length === 1 && params[0][0] === 'cursor' && parseDisplayCursor(params[0][1], 'content', sid) !== null;
    return false;
  }
  return method === 'POST' && url.search === '' && ((permission === 'create' && url.pathname === '/v1/sessions')
    || (['first','second'].includes(permission) && sid && url.pathname === `/v1/sessions/${sid}/runs`));
}
export function backwardRead(method, url, sid) {
  if (method !== 'GET' || !sid) return null;
  const base = `/v1/sessions/${sid}/conversation`, params = [...url.searchParams];
  if (url.pathname === `${base}/content`) return 'content';
  if (url.pathname !== base || url.search === '') return null;
  if (params.length === 1 && params[0][0] === 'before') return 'block';
  if (params.length === 1 && params[0][0] === 'within') return 'activity';
  return 'other';
}
export function intentFacts(r, faults) {
  const metric = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(n,1_000_000_000) : null;
  const count = n => Number.isSafeInteger(n) && n >= 0 ? Math.min(n,1_000_000) : null;
  return {available:r.prekey !== null,focused:r.prekey?.focused === true,top:metric(r.prekey?.top),
    height:metric(r.prekey?.height),viewport:metric(r.prekey?.viewport),intent:r.intent === true,newest:r.newest === true,
    setup_reads:count(r.setup_reads),backward_reads:count(r.older.length),
    routes:r.older.slice(0,4).map(q=>['block','activity','content','other'].includes(q.kind) ? q.kind : 'other'),
    collector_faults:count(faults.collector),request_faults:count(faults.request)};
}
async function publicRead(fixture, sid, query = { kind:'latest' }) {
  let search = '';
  if (query.kind === 'before') search = `?before=${encodeURIComponent(query.cursor)}`;
  // This independent typed HTTP proof is not the browser Fetch body or consumption proof.
  const reply = await fetch(`${fixture.origin}/v1/sessions/${sid}/conversation${search}`, {
    method:'GET', headers:{Authorization:`Bearer ${fixture.owner}`,Accept:'application/json'},
    credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000),
  });
  expect(reply.status === 200 && reply.headers.get('cache-control') === 'no-store').toBe(true);
  const bytes = await reply.arrayBuffer(); expect(bytes.byteLength <= 512*1024).toBe(true);
  return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),reply.headers.get('content-type'),v=>validateConversationPage(v,query,sid));
}
async function boundary(page, context, owner, markers) {
  const safe = await page.evaluate(async ({owner,markers}) => {
    const dom = document.documentElement.cloneNode(true);
    // Only public field identities are exempt from this detached privacy scan.
    for (const field of dom.querySelectorAll('[data-field]')) {
      const id = field.getAttribute('data-field'); if (!/^(text|[0-9a-f]{64})$/.test(id) || id === owner) return false;
      field.removeAttribute('data-field');
    }
    const values = [dom.outerHTML,location.href,JSON.stringify(history.state),...Array.from(document.querySelectorAll('input,textarea,select'),n=>n.value)];
    const content = document.querySelector('.layout');
    return globalThis.wiCanary === undefined && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''
      && (await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0 && (await navigator.serviceWorker.getRegistrations()).length === 0
      && values.every(v=>!v || (!v.includes(owner) && !/[0-9a-f]{64}/i.test(v) && !markers.some(m=>v.includes(m))))
      && content.querySelectorAll('script,img,a,iframe,object,embed,svg,math,link,style,audio,video,source').length === 0
      && Array.from(content.querySelectorAll('*')).every(n=>Array.from(n.attributes).every(a=>!/^on/i.test(a.name) && !['src','href','srcdoc'].includes(a.name)))
      && document.querySelectorAll('script').length === 1 && document.querySelector('script').getAttribute('src') === '/assets/app.js';
  },{owner,markers});
  expect(safe && (await context.cookies()).length === 0).toBe(true);
}

test.use({trace:'off',screenshot:'off',video:'off'});
test('saved main SKILL remains exact after owned source change and deletion without new work', async ({browser}) => {
  test.setTimeout(180_000);
  let fixture, guard, sid, workspace, failure, stage = 'startup', check = 'outside';
  const contexts = [], pages = [], commands = [], receipts = [], assetReads = [], saved = [], dom = [];
  const cleanup = { contexts:0, contexts_expected:0, handle_acquired:false, handle_closed:null, root:null,
    fixture:false, root_absent:false, pid_absent:false };
  const faults = {external:0,request:0,response:0,console:0,page:0,private:0,collector:0};
  const records = [0,1,2].map(()=>({requests:[],snapshots:[],streams:[],older:[],assets:new Set(),permission:null,events:[],newest:false,intent:false,prekey:null,setup_reads:null}));
  try {
    const executable = await discoverFixture(); expect(executable === process.env.WI_C3A_FIXTURE).toBe(true);
    const binding = await executableBinding(executable, process.env.WI_C3A_FIXTURE_SHA256);
    // Rehash immediately before the unchanged fixture spawns its owned child.
    expect(isDeepStrictEqual(await executableBinding(executable, binding.sha256), binding)).toBe(true);
    fixture = await startFixture(executable, { transport: 'websocket', recovered: false, mime: true, presentation: true }, { gate11Diagnostics: true });
    cleanup.root = await fixture.bindRoot();
    console.log(`Skill fidelity fixture: pid=${fixture.pid}; chromium=${browser.version()}; binding=${JSON.stringify(binding)}; linux_local=true`);
    const files = new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(n=>[`/assets/${n}.js`,`dist/${n}.js`])]);
    const markers = ['synthetic-replay-','synthetic-account-','private-operator-','private-project-','private-skill-','private-support-',
      'private-native','private-data','private-skills','private-config-canary','principal_digest','history_digest','encrypted_content','opaque_response','provider_session_id','prepared_request'];
    const leaked = text => text.includes(fixture.owner) || /[0-9a-f]{64}/i.test(text) || markers.some(m=>text.includes(m));
    async function observer(context,index) {
      const r = records[index];
      await context.route('**/*',async route=>{try {if(new URL(route.request().url()).origin!==fixture.origin){faults.external++;await route.abort();}else await route.continue();}catch{faults.collector++;}});
      context.on('request',request=>{
        try {
          const url=new URL(request.url()),method=request.method();r.requests.push({method,path:url.pathname,search:url.search});
          if(url.origin!==fixture.origin)faults.external++;if(leaked(request.url()))faults.private++;
          if(url.pathname.startsWith('/v1/')){
            const h=request.headers();
            if(h.authorization!==`Bearer ${fixture.owner}` || h.cookie!==undefined || (h.origin!==undefined&&h.origin!==fixture.origin)
              || !allowedRequest(method,url,sid,r.permission))faults.request++;
          }else if(method!=='GET'||!files.has(url.pathname)||url.search!=='')faults.request++;
          if(method==='GET'&&sid&&request.url()===`${fixture.origin}/v1/sessions/${sid}/conversation`){r.snapshots.push({request,index:r.requests.length-1,response:null});if(index)r.events.push('latest');}
          if(method==='GET'&&sid&&url.pathname===`/v1/sessions/${sid}/conversation/events`)r.streams.push({request,index:r.requests.length-1,response:r.snapshots.at(-1)?.response});
          const kind=backwardRead(method,url,sid);
          if(kind!==null){
            r.older.push({request,index:r.requests.length-1,kind});if(index){if(!r.newest||!r.intent||kind!=='block'||r.older.length!==1)faults.request++;r.events.push('older-request');}
          }
          if(method==='POST'&&url.pathname.endsWith('/runs')){
            if(index!==0||commands.length>1||r.permission!==['first','second'][commands.length])faults.request++;
            const c=validateTaskCommand(request.postDataJSON());if(c.text!==data.user)faults.request++;commands.push(c);
          }
          if(method==='POST'&&url.pathname==='/v1/sessions'){
            const c=request.postDataJSON();validateUuid(c.operation_id);
            if(index!==0||r.permission!=='create'||Object.keys(c).sort().join(',')!=='operation_id,title,workspace'||c.title!==data.title||c.workspace!==workspace)faults.request++;
          }
        }catch{faults.collector++;}
      });
      context.on('response',reply=>{
        try {
          const url=new URL(reply.url()),snapshot=r.snapshots.find(s=>s.request===reply.request());if(snapshot)snapshot.response=reply;
          if(reply.status()>=300)faults.response++;
          const file=files.get(url.pathname);if(file===undefined)return;
          assetReads.push((async()=>{const bytes=await reply.body();if(reply.status()!==200||!bytes.equals(await readFile(new URL(`../${file}`,import.meta.url))))faults.response++;
            if(leaked(bytes.toString('utf8')))faults.private++;r.assets.add(url.pathname);})().catch(()=>{faults.collector++;}));
        }catch{faults.collector++;}
      });
      const page=await context.newPage();page.on('console',message=>{faults.console++;if(leaked(message.text())||leaked(message.location().url))faults.private++;});page.on('pageerror',()=>{faults.page++;});return page;
    }
    const status=page=>page.locator('.topbar [role="status"]'),transcript=page=>page.getByRole('region',{name:'Canonical conversation',exact:true});
    const button=(page,name)=>page.getByRole('button',{name,exact:true}),run=(page,task)=>transcript(page).locator(`.run[data-run="${commands[task].run_id}"]`);
    async function connect(page){await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);await button(page,'Connect').click();await expect(page.getByLabel('Owner token',{exact:true})).toHaveValue('');}
    async function replyBody(reply,code,validate){expect(reply.status()).toBe(code);const bytes=await reply.body();expect(bytes.length<=512*1024).toBe(true);return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),reply.headers()['content-type'],validate);}
    async function ready(page,proof,task){await expect(run(page,task)).toHaveCount(1);await expect.poll(async()=>isDeepStrictEqual(await displayedBlock(run(page,task)),expectedBlock(proof))).toBe(true);await exact(status(page),'connected; observation: streaming');}
    const options=(native,task,query={kind:'latest'})=>({sid,head:native.sequence_count,command:commands[task],receipt:receipts[task],task,workspace,resultSequence:native.result_sequences[task],query});
    contexts.push(await browser.newContext({serviceWorkers:'block',viewport:{width:1000,height:700}}));pages.push(await observer(contexts[0],0));const a=pages[0];
    stage='create';await a.goto(`${fixture.origin}/`);await connect(a);await exact(status(a),'connected');
    workspace=await a.getByLabel(/^Workspace/).inputValue();await a.getByLabel('Title',{exact:true}).fill(data.title);records[0].permission='create';
    const [createdReply]=await Promise.all([a.waitForResponse(r=>r.url()===`${fixture.origin}/v1/sessions`&&r.request().method()==='POST'),button(a,'Create session').click()]);records[0].permission=null;
    const created=await replyBody(createdReply,201,validateCreateView);sid=validateUuid(created.session_id);
    await button(a,'Open receipt session').click();await exact(status(a),'connected; observation: streaming');await expect.poll(()=>records[0].streams.length).toBe(1);
    const empty=await publicRead(fixture,sid);expect(empty.snapshot_head==='1'&&empty.block===null).toBe(true);
    freshHandshake({origin:fixture.origin,sid,head:'1',value:empty,snapshots:records[0].snapshots,streams:records[0].streams,reply:records[0].snapshots[0].response});
    await fixture.request({command:'select',session_id:sid});expect((await fixture.inspect()).sequence_count).toBe('1');
    for(const task of [0,1]){
      stage=`task-${task+1}`;check='fill-task';await a.getByLabel('Task',{exact:true}).fill(data.user);records[0].permission=['first','second'][task];
      check='accepted-response';const [acceptedReply]=await Promise.all([a.waitForResponse(r=>r.url()===`${fixture.origin}/v1/sessions/${sid}/runs`&&r.request().method()==='POST'),button(a,'Send').click()]);records[0].permission=null;
      check='accepted-dto';const accepted=await replyBody(acceptedReply,202,v=>validateDisplayTaskAccepted(v,{...commands[task],session_id:sid}));
      expect(!accepted.duplicate&&accepted.warning_code===null&&accepted.notices.length===0).toBe(true);receipts.push(accepted.receipt);
      console.log(`Skill fidelity accepted: task=${task+1}; receipt=${JSON.stringify(accepted.receipt)}`);
      check=`paused-${task*6+1}`;await fixture.wait('model_paused',task*6+1);
      for(let gate=task*6+1;gate<=task*6+6;gate++){
        check=`drive-${gate}`;await fixture.request({command:'drive',gate});
        check=gate<task*6+6?`paused-${gate+1}`:`finished-${task+1}`;
        if(gate<task*6+6)await fixture.wait('model_paused',gate+1);else await fixture.wait('task_finished',task+1);
        if(gate===10){
          check='gate11-diagnostic';const report=await captureGate11(fixture);
          console.log(`Skill fidelity gate11 diagnostic: ${JSON.stringify(report)}`);requireGate11(report);
        }
      }
      check='provider-finished';if(task===1)await expect.poll(async()=>(await fixture.inspect()).provider_stage).toBe('finished');
      check='native';const held=nativeCompletion(await fixture.inspect(),commands,receipts);
      check='complete-dto';saved[task]=completeProof(await publicRead(fixture,sid),options(held,task));
      check='complete-dom';await ready(a,saved[task],task);dom[task]=await normalizedDom(run(a,task));
      if(task===1){savedProof(await displayedBlock(run(a,0)),expectedBlock(saved[0]));expect(await normalizedDom(run(a,0))).toBe(dom[0]);}
      console.log(`Skill fidelity task: task=${task+1}; native=${JSON.stringify(held)}; full_public=${JSON.stringify(saved[task])}`);
    }
    stage='fixed-boundary';const final=nativeCompletion(await fixture.inspect(),commands,receipts),head=final.sequence_count;
    const before={kind:'before',cursor:saved[1].previous_block};const finalA=completeProof(await publicRead(fixture,sid,before),options(final,0,before));
    savedProof(finalA.block,saved[0].block);savedProof(finalA.entries,saved[0].entries);saved[0]=finalA;
    check='ownership';guard=await ownedSkill({fixture,workspace,tmpdir:process.env.TMPDIR,executable,finished:final});
    cleanup.handle_acquired=true;cleanup.handle_closed=false;
    stage='change-source';const changed=await guard.change();console.log(`Skill fidelity changed: ${JSON.stringify(changed)}`);
    for(const index of [1,2]){
      if(index===2){stage='delete-source';await guard.observed();console.log(`Skill fidelity deleted: ${JSON.stringify(await guard.delete())}`);}
      stage=index===1?'changed-observer':'deleted-observer';const r=records[index];
      contexts.push(await browser.newContext({serviceWorkers:'block',viewport:{width:1000,height:700}}));pages.push(await observer(contexts[index],index));const page=pages[index];
      await page.goto(`${fixture.origin}/#session=${sid}`);await expect(page.getByLabel('Owner token',{exact:true})).toHaveValue('');await expect(page.getByLabel('Task',{exact:true})).toHaveValue('');
      await expect(page.locator('.run,.command')).toHaveCount(0);expect(r.requests.every(q=>!q.path.startsWith('/v1/'))).toBe(true);await boundary(page,contexts[index],fixture.owner,markers);
      const [freshReply]=await Promise.all([page.waitForResponse(q=>r.snapshots.some(s=>s.request===q.request())),connect(page)]);
      await exact(status(page),'connected; observation: streaming');await expect.poll(()=>r.streams.length).toBe(1);
      check='handshake';const newest=completeProof(await publicRead(fixture,sid),options(final,1));savedProof(newest,saved[1]);
      freshHandshake({origin:fixture.origin,sid,head,value:newest,snapshots:r.snapshots,streams:r.streams,reply:freshReply});
      expect(freshReply.headers()['cache-control']==='no-store'&&freshReply.headers()['content-type'].startsWith('application/json')).toBe(true);
      check='newest-dom';await ready(page,newest,1);expect(await normalizedDom(run(page,1))).toBe(dom[1]);await expect(transcript(page).locator('.run')).toHaveCount(1);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      expect(await transcript(page).evaluate(n=>n.scrollHeight>n.clientHeight)).toBe(true);expect(r.older.length).toBe(0);r.newest=true;r.events.push('newest-rendered');
      check='setup-top';expect(r.intent).toBe(false);
      // Positioning is setup, not permission to read history.
      await transcript(page).evaluate(n=>{n.scrollTop=0;});
      check='transcript-focus';await transcript(page).focus();
      check='layout-settled';await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      check='pre-key-sample';r.prekey=await transcript(page).evaluate(n=>({focused:document.activeElement===n,top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight}));
      check='pre-key-focus';expect(r.prekey.focused).toBe(true);
      check='pre-key-geometry';expect(Number.isFinite(r.prekey.top)&&r.prekey.top>=0&&r.prekey.top<=96&&r.prekey.height>r.prekey.viewport).toBe(true);
      check='setup-reads';expect(r.intent).toBe(false);r.setup_reads=r.older.length;expect(r.older.length).toBe(0);
      check='key-dispatch';r.events.push('upward-intent');r.intent=true;await page.keyboard.press('Home');
      check='older-request-wait';await expect.poll(()=>r.older.length).toBe(1);
      check='older-request-route';expect(r.older[0].kind).toBe('block');
      check='older-request-cursor';expect(r.older[0].request.url()).toBe(`${fixture.origin}/v1/sessions/${sid}/conversation?before=${encodeURIComponent(before.cursor)}`);
      check='older-dto';const older=completeProof(await publicRead(fixture,sid,before),options(final,0,before));savedProof(older,saved[0]);
      check='older-dom';await ready(page,older,0);savedProof(await displayedBlock(run(page,1)),expectedBlock(saved[1]));
      expect(await normalizedDom(run(page,0))).toBe(dom[0]);expect(await normalizedDom(run(page,1))).toBe(dom[1]);
      expect(await transcript(page).locator('.run').evaluateAll(ns=>ns.map(n=>n.dataset.run))).toEqual(commands.map(c=>c.run_id));
      r.events.push('older-rendered');observerOrder(r.events);expect(r.snapshots.length===1&&r.streams.length===1&&r.older.length===1&&readOnly(r.requests)).toBe(true);
      await expect(page.locator('.command')).toHaveCount(0);await expect(page.getByLabel('Task',{exact:true})).toHaveValue('');
      check='privacy';await boundary(page,contexts[index],fixture.owner,markers);check='native-unchanged';unchangedNative(await fixture.inspect(),final);
      for(const task of [0,1]){savedProof(await displayedBlock(run(a,task)),expectedBlock(saved[task]));expect(await normalizedDom(run(a,task))).toBe(dom[task]);}
      console.log(`Skill fidelity input: phase=${index===1?'changed':'deleted'}; facts=${JSON.stringify(intentFacts(r,faults))}`);
      console.log(`Skill fidelity observer: phase=${index===1?'changed':'deleted'}; head=${head}; original_latest_before_live=true; dto_dom_layout_exact=true; live_unchanged=true; mutations=0; native_unchanged=true; events=${JSON.stringify(r.events)}`);
    }
    check='assets';await Promise.all(assetReads);expect(records.every(r=>r.assets.size===files.size&&[...files.keys()].every(p=>r.assets.has(p)))).toBe(true);
    for(let i=0;i<pages.length;i++)await boundary(pages[i],contexts[i],fixture.owner,markers);
    expect(records[0].snapshots.length===1&&records[0].streams.length===1&&records[0].older.length===0).toBe(true);
    expect(records.map(r=>r.requests.filter(q=>q.method==='POST').length)).toEqual([3,0,0]);expect(Object.values(faults).every(n=>n===0)).toBe(true);
    unchangedNative(await fixture.inspect(),final);
    console.log(`Skill fidelity final: head=${head}; tasks=2; tools=6; terminals=2; results=2; original_handshakes=3; assets_per_context=${files.size}; faults=${JSON.stringify(faults)}; full_public_A_at_final_H=${JSON.stringify(saved[0])}`);
  }catch(error){
    const message=typeof error?.message==='string'?error.message:'';
    const facts=Object.freeze({stage,check,timeout:message.includes('Timeout')||message.includes('timed out'),fixture_failed:message.includes('fixture child failed'),body_protocol:message.includes('Protocol error')||message.includes('response body')});
    console.log(`Skill fidelity failure: stage=${facts.stage}; check=${facts.check}; timeout=${facts.timeout}; fixture_failed=${facts.fixture_failed}; body_protocol=${facts.body_protocol}`);
    failure=new Error(`Skill fidelity failed: stage=${stage}; check=${check}`);
    console.log(`Skill fidelity input failure: ${JSON.stringify(records.slice(1).map(r=>intentFacts(r,faults)))}`);
    try{if(fixture)console.log(`Skill fidelity gate11 diagnostic: ${JSON.stringify(await captureGate11(fixture,facts))}`);}catch{console.log('Skill fidelity diagnostic unavailable');}
  }
  finally{
    cleanup.contexts_expected=contexts.length;
    for(const context of contexts.reverse()){try{await context.close();cleanup.contexts++;}catch{failure??=new Error('Skill fidelity context cleanup failed');}}
    try{if(guard){await guard.close();cleanup.handle_closed=true;}}catch{failure??=new Error('Skill fidelity handle cleanup failed');}
    try{if(fixture){await fixture.stop();cleanup.fixture=true;}}catch{failure??=new Error('Skill fidelity fixture cleanup failed');}
    const evidence=fixture?.evidence();
    try{
      if(fixture){strictStop(evidence);try{await lstat(`/proc/${fixture.pid}`);}catch(e){if(e.code==='ENOENT')cleanup.pid_absent=true;else throw e;}
        cleanup.root_absent=await fixtureRootAbsent(cleanup.root);
        evaluateSkillCleanup({...cleanup,evidence});}
    }catch{failure??=new Error('Skill fidelity strict Stop rejected');}
    console.log(`Skill fidelity cleanup: ${JSON.stringify({...cleanup,evidence})}`);
  }
  if(failure)throw failure;
});
