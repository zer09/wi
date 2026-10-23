import { test, expect } from '@playwright/test';
import { readFile, lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { discoverFixture, startFixture, fixtureRootAbsent, evaluateSkillCleanup } from '../test-support/fixture.mjs';
import { decodeJson, validateCreateView, validateTaskCommand } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { exact } from '../test-support/joined.mjs';
import { expectedBlock, displayedBlock, normalizedDom } from '../test-support/rich-display-parity.mjs';
import { executableBinding, ownedSkill, strictStop } from '../test-support/skill-source-fidelity.mjs';
import { replayData, replayEvidence, replayPage, replayUnchanged, replayRead } from '../test-support/skill-history-replay.mjs';

test.use({ trace:'off', screenshot:'off', video:'off' });
test('main SKILL changed before explicit B replays exact original result without another loader dispatch', async ({ browser }) => {
  let fixture, context, guard, root, failure, stage='startup', sid, workspace;
  const commands=[], receipts=[], assets=new Set(), assetReads=[], streams=[];
  let retiringStream=null;
  const traffic={ posts:0, latest:0, streams:0, faults:0, external:0, console:0, page:0 };
  const cleanup={contexts:0,contexts_expected:0,handle_acquired:false,handle_closed:null,fixture:false,root_absent:false,pid_absent:false};
  let permission=null, closing=false;
  try {
    const executable=await discoverFixture();
    expect(executable===process.env.WI_C3A_FIXTURE).toBe(true);
    const binding=await executableBinding(executable,process.env.WI_C3A_FIXTURE_SHA256);
    expect(isDeepStrictEqual(await executableBinding(executable,binding.sha256),binding)).toBe(true);
    fixture=await startFixture(executable,{transport:'websocket',recovered:false,mime:true,skill_replay:true});
    root=await fixture.bindRoot();cleanup.root=root;
    context=await browser.newContext({serviceWorkers:'block'});cleanup.contexts_expected=1;
    const privateMarkers=[fixture.owner,'private-project-browser','private-skill-browser','private-native','private-data','private-skills',
      'synthetic-replay-token-','synthetic-replay-account','private-operator-instructions','principal_digest','prepared_request','encrypted_content'];
    const leaked=text=>privateMarkers.some(marker=>text.includes(marker));
    const files=new Map([['/','index.html'],['/assets/wi.css','style.css'],
      ...['api','app','display-api','display-client','display-store','display-view','sse'].map(n=>[`/assets/${n}.js`,`dist/${n}.js`])]);
    await context.route('**/*',async route=>{
      if(new URL(route.request().url()).origin!==fixture.origin){traffic.external++;await route.abort();}else await route.continue();
    });
    context.on('request',request=>{
      try {
        const url=new URL(request.url()), method=request.method();
        if(url.origin!==fixture.origin||leaked(request.url()))traffic.faults++;
        if(url.pathname.startsWith('/v1/')){
          const headers=request.headers();
          if(headers.authorization!==`Bearer ${fixture.owner}`||headers.cookie!==undefined
            ||(headers.origin!==undefined&&headers.origin!==fixture.origin))traffic.faults++;
          const base=`/v1/sessions/${sid}`;
          if(method==='GET'){
            if(!replayRead(url,sid))traffic.faults++;
            if(url.pathname===`${base}/conversation`&&url.search==='')traffic.latest++;
            if(url.pathname===`${base}/conversation/events`){traffic.streams++;streams.push(request);}
          }else if(method==='POST'){
            traffic.posts++;
            if(url.search!=='')traffic.faults++;
            if(permission==='create'&&url.pathname==='/v1/sessions'){
              const c=request.postDataJSON();
              if(c.title!==replayData.title||c.workspace!==workspace||Object.keys(c).sort().join(',')!=='operation_id,title,workspace')traffic.faults++;
            }else if(permission===commands.length&&url.pathname===`${base}/runs`){
              const c=validateTaskCommand(request.postDataJSON());
              if(c.text!==replayData.tasks[commands.length])traffic.faults++;
              commands.push(c);
            }else traffic.faults++;
          }else traffic.faults++;
        }else if(method!=='GET'||!files.has(url.pathname)||url.search!=='')traffic.faults++;
      }catch{traffic.faults++;}
    });
    context.on('response',reply=>{
      if(reply.status()>=300)traffic.faults++;
      const file=files.get(new URL(reply.url()).pathname);
      if(file)assetReads.push((async()=>{
        const bytes=await reply.body();
        if(!bytes.equals(await readFile(new URL(`../${file}`,import.meta.url)))||leaked(bytes.toString('utf8')))traffic.faults++;
        assets.add(file);
      })().catch(()=>{traffic.faults++;}));
    });
    context.on('requestfailed',request=>{if(!closing&&request!==retiringStream)traffic.faults++;});
    const page=await context.newPage();
    page.on('console',()=>{traffic.console++;});page.on('pageerror',()=>{traffic.page++;});
    const button=name=>page.getByRole('button',{name,exact:true});
    const status=page.locator('.topbar [role="status"]');
    const transcript=page.getByRole('region',{name:'Canonical conversation',exact:true});
    const run=task=>transcript.locator(`.run[data-run="${commands[task].run_id}"]`);
    async function replyBody(reply,code,validate){
      expect(reply.status()).toBe(code);expect(reply.headers()['cache-control']).toBe('no-store');
      const bytes=await reply.body();expect(bytes.length<=512*1024).toBe(true);
      return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),reply.headers()['content-type'],validate);
    }
    async function read(query={kind:'latest'}){
      const search=query.kind==='latest'?'':`?before=${encodeURIComponent(query.cursor)}`;
      const reply=await fetch(`${fixture.origin}/v1/sessions/${sid}/conversation${search}`,{headers:{Authorization:`Bearer ${fixture.owner}`},
        credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000)});
      expect(reply.status===200&&reply.headers.get('cache-control')==='no-store').toBe(true);
      return decodeJson(await reply.text(),reply.headers.get('content-type'),v=>validateConversationPage(v,query,sid));
    }
    async function ready(task,proof){
      await expect(run(task)).toHaveCount(1);
      await expect.poll(async()=>isDeepStrictEqual(await displayedBlock(run(task)),expectedBlock(proof))).toBe(true);
      await exact(status,'connected; observation: streaming');
    }
    stage='create';await page.goto(fixture.origin+'/');
    await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);await button('Connect').click();
    await expect(page.getByLabel('Owner token',{exact:true})).toHaveValue('');await exact(status,'connected');
    workspace=await page.getByLabel(/^Workspace/).inputValue();await page.getByLabel('Title',{exact:true}).fill(replayData.title);
    permission='create';
    const [createdReply]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===fixture.origin+'/v1/sessions'),button('Create session').click()]);permission=null;
    sid=(await replyBody(createdReply,201,validateCreateView)).session_id;
    await button('Open receipt session').click();await exact(status,'connected; observation: streaming');
    await fixture.request({command:'select',session_id:sid});
    const saved=[], dom=[];
    let first, final;
    for(const task of [0,1]){
      if(task===1){
        stage='mutate-before-B';
        first=replayEvidence(await fixture.request({command:'inspect_skill_replay'}),commands,receipts);
        expect(first.state.completed===1&&first.state.accepted.length===1&&first.state.requests===2).toBe(true);
        guard=await ownedSkill({fixture,workspace,tmpdir:process.env.TMPDIR,executable,finished:first.state,beforeNextTask:true});
        cleanup.handle_acquired=true;cleanup.handle_closed=false;
        expect((await guard.change()).readback_exact).toBe(true);
        replayUnchanged(await fixture.request({command:'inspect_skill_replay'}),first);
        expect(commands.length===1&&traffic.posts===2).toBe(true);
        expect(isDeepStrictEqual(await displayedBlock(run(0)),expectedBlock(saved[0]))).toBe(true);
        console.log('Skill history replay: A committed; owned ORIGINAL file changed/readback exact; B not submitted; canonical prefix unchanged');
      }
      stage=`explicit-task-${task+1}`;await page.getByLabel('Task',{exact:true}).fill(replayData.tasks[task]);permission=task;
      const [reply]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===`${fixture.origin}/v1/sessions/${sid}/runs`),button('Send').click()]);permission=null;
      const accepted=await replyBody(reply,202,v=>validateDisplayTaskAccepted(v,{...commands[task],session_id:sid}));
      expect(!accepted.duplicate&&accepted.warning_code===null&&accepted.notices.length===0).toBe(true);receipts.push(accepted.receipt);
      for(let gate=task*2+1;gate<=task*2+2;gate++){
        stage=`gate-${gate}`;await fixture.wait('model_paused',gate);await fixture.request({command:'drive',gate});
      }
      await fixture.wait('task_finished',task+1);
      if(task===1)await expect.poll(async()=>(await fixture.inspect()).provider_stage).toBe('finished');
      final=replayEvidence(await fixture.request({command:'inspect_skill_replay'}),commands,receipts);
      saved[task]=replayPage(await read(),{sid,workspace,task,command:commands[task],receipt:receipts[task],state:final.state});
      await ready(task,saved[task]);dom[task]=await normalizedDom(run(task));
      console.log(`Skill history replay completed: task=${task+1}; run=${commands[task].run_id}; receipt=${JSON.stringify(receipts[task])}; requests=${final.state.requests}; loader_dispatches=${final.loader_dispatches}; historical_request_exact=${final.history_exact}`);
    }
    stage='saved-A-live-B';
    const query={kind:'before',cursor:saved[1].previous_block};
    const historical=replayPage(await read(query),{sid,workspace,task:0,command:commands[0],receipt:receipts[0],state:final.state,query});
    expect(isDeepStrictEqual(historical.block,saved[0].block)&&isDeepStrictEqual(historical.entries,saved[0].entries)).toBe(true);
    expect(await normalizedDom(run(0))).toBe(dom[0]);await ready(0,historical);await ready(1,saved[1]);
    expect(await transcript.locator('.run').evaluateAll(nodes=>nodes.map(n=>n.dataset.run))).toEqual(commands.map(c=>c.run_id));
    replayUnchanged(await fixture.request({command:'inspect_skill_replay'}),final);
    stage='read-only-rebase';const posts=traffic.posts;
    retiringStream=streams[0];await button('Reconnect latest').click();await exact(status,'connected; observation: streaming');
    await expect.poll(()=>traffic.latest).toBe(2);await expect.poll(()=>traffic.streams).toBe(2);
    await ready(1,saved[1]);
    await transcript.evaluate(node=>{node.scrollTop=0;});await transcript.focus();await page.keyboard.press('Home');
    await ready(0,historical);await ready(1,saved[1]);
    for(const task of [0,1])expect(await normalizedDom(run(task))).toBe(dom[task]);
    expect(await transcript.locator('.run').evaluateAll(nodes=>nodes.map(n=>n.dataset.run))).toEqual(commands.map(c=>c.run_id));
    expect(traffic.posts===posts&&posts===3).toBe(true);
    replayUnchanged(await fixture.request({command:'inspect_skill_replay'}),final);
    await guard.observed();
    await Promise.all(assetReads);expect(assets.size).toBe(files.size);
    const privateBoundary=await page.evaluate(async markers=>{
      const values=[document.documentElement.outerHTML,location.href,JSON.stringify(history.state),...Array.from(document.querySelectorAll('input,textarea'),n=>n.value)];
      return values.every(value=>!markers.some(marker=>value?.includes(marker)))&&localStorage.length===0&&sessionStorage.length===0&&document.cookie===''
        &&(await indexedDB.databases()).length===0&&(await caches.keys()).length===0&&(await navigator.serviceWorker.getRegistrations()).length===0
        &&document.querySelectorAll('.layout script,.layout img,.layout iframe,.layout a').length===0;
    },privateMarkers);
    expect(privateBoundary&&(await context.cookies()).length===0).toBe(true);
    expect([traffic.faults,traffic.external,traffic.console,traffic.page]).toEqual([0,0,0,0]);
    console.log(`Skill history replay final: ${JSON.stringify(final)}; reads_and_rebase_no_work=true; assets=${assets.size}; traffic=${JSON.stringify(traffic)}`);
  }catch(error){
    const line=/skill-history-replay(?:\.spec)?\.mjs:(\d+)/.exec(error?.stack??'')?.[1]??null;
    failure=new Error(`Skill history replay failed: ${stage}`);
    console.log(`Skill history replay failure: stage=${stage}; source_line=${line}; fixture_failed=${error?.message==='fixture child failed'}; traffic=${JSON.stringify(traffic)}`);
  }
  finally{
    closing=true;
    try{if(context){await context.close();cleanup.contexts++;}}catch{failure??=new Error('Skill history replay context cleanup failed');}
    try{if(guard){await guard.close();cleanup.handle_closed=true;}}catch{failure??=new Error('Skill history replay file cleanup failed');}
    try{if(fixture){await fixture.stop();cleanup.fixture=true;}}catch{failure??=new Error('Skill history replay Stop failed');}
    try{
      if(fixture){strictStop(fixture.evidence());try{await lstat(`/proc/${fixture.pid}`);}catch(error){if(error.code==='ENOENT')cleanup.pid_absent=true;else throw error;}
        cleanup.root_absent=await fixtureRootAbsent(root);evaluateSkillCleanup({...cleanup,evidence:fixture.evidence()});}
    }catch{failure??=new Error('Skill history replay strict cleanup failed');}
    console.log(`Skill history replay cleanup: ${JSON.stringify({...cleanup,evidence:fixture?.evidence()})}`);
  }
  if(failure)throw failure;
});
