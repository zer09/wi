import { chromium, expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverFixture, startFixture } from '../test-support/fixture.mjs';
import { exact } from '../test-support/joined.mjs';
import { installReadReconnectObserver } from '../test-support/read-reconnect.mjs';
import { reconnectNetwork } from '../test-support/read-reconnect-network.mjs';
import { reconnectPrivacy } from '../test-support/read-reconnect-privacy.mjs';

const data=JSON.parse(await readFile(new URL('../test-support/read-reconnect.json',import.meta.url),'utf8'));
const source=await readFile(new URL('../dist/client.js',import.meta.url),'utf8');
let executable;
test.beforeAll(async () => {test.setTimeout(150_000);executable=await discoverFixture();});
test.use({trace:'off',screenshot:'off',video:'off'});

test('joined read reconnect: mid-frame and network-received before consumption prototype',async ({},testInfo) => {
  const previous=process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  let fixture;let browser;let context;let page;let network;let failure;let observed;let debug;let gateEvidence;let version;let stage='startup';let blocked=false;
  const cleanup={browser:false,fixture:false,network:false,observer:false};const faults={external:0,request:0,console:0,page:0};
  const posts={create:0,task:0,other:0};const windows=[];
  try {
    reconnectPrivacy(chromium,testInfo.project.use);
    process.env.PLAYWRIGHT_NO_COPY_PROMPT='1';
    stage='browser launch';browser=await chromium.launch({headless:true,tracesDir:undefined});version=browser.version();stage='startup';
    fixture=await startFixture(executable,{transport:'websocket',recovered:false,mime:true,read_reconnect:true});
    context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',async route => {
      if(new URL(route.request().url()).origin !== fixture.origin){faults.external++;await route.abort();}
      else await route.continue();
    });
    context.on('request',request => {
      const url=new URL(request.url());
      if(url.origin !== fixture.origin)faults.external++;
      if(url.pathname.startsWith('/v1/')) {
        const h=request.headers();if(h.authorization !== `Bearer ${fixture.owner}` || h.cookie !== undefined
          || (h.origin !== undefined && h.origin !== fixture.origin))faults.request++;
      }
      if(request.method() === 'POST') {
        if(url.pathname === '/v1/sessions')posts.create++;
        else if(url.pathname.endsWith('/runs'))posts.task++;
        else posts.other++;
      }
    });
    await context.addInitScript(installReadReconnectObserver,{fixture:data,owner:fixture.owner});
    page=await context.newPage();
    page.on('console',message => {
      // A body error is the intentional network fault, not a page exception.
      if(message.type() !== 'error' || message.text() !== 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING')faults.console++;
    });
    page.on('pageerror',() => {faults.page++;});
    const status=page.locator('.topbar [role="status"]');
    stage='real UI acceptance';
    await page.goto(`${fixture.origin}/`);await page.getByLabel('Owner token',{exact:true}).fill(fixture.owner);
    await page.getByRole('button',{name:'Connect',exact:true}).click();await exact(status,'connected');
    await page.getByLabel('Title',{exact:true}).fill(data.title);await page.getByRole('button',{name:'Create session',exact:true}).click();
    await page.getByRole('button',{name:'Open receipt session',exact:true}).click();
    await exact(status,'connected; observation: streaming');
    const sid=new URL(page.url()).hash.slice('#session='.length);await fixture.request({command:'select',session_id:sid});
    await page.getByLabel('Task',{exact:true}).fill(data.task);await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(() => page.evaluate(() => globalThis.readReconnectCapture.identity() !== null)).toBe(true);
    const identity=await page.evaluate(() => globalThis.readReconnectCapture.identity());
    const control=(step,window,subscription=window) => fixture.request({command:'read_reconnect',step,window,subscription,...identity});
    async function snapshot(n,observation='streaming') {
      await expect.poll(async () => {
        observed=await page.evaluate(() => globalThis.readReconnectCapture.summary());
        return page.evaluate(({n,observation}) => globalThis.readReconnectCapture.verify(n,observation),{n,observation});
      }).toBe(true);
      await exact(status,`connected; observation: ${observation}; run: running; result not recorded`);
      expect(await page.locator('.run').count()).toBe(1);await exact(page.locator('.user-text'),data.task);
      expect(await page.locator('.run .entry').count()).toBe(0);
    }
    await control('pending',0,1);await snapshot(6);
    stage='A partial frame';
    await control('arm',1);await page.evaluate(() => globalThis.readReconnectCapture.armPartial());
    stage='A commit';await control('commit',1);
    stage='A hook hit';const a=await control('hit',1);
    stage='A decoder proof';
    await expect.poll(async () => {observed=await page.evaluate(() => globalThis.readReconnectCapture.summary());return observed.partial.bytes;}).toBe(a.yielded_bytes);
    const partial=await page.evaluate(() => globalThis.readReconnectCapture.endPartial());
    expect(partial.calls > 0 && partial.bytes > 0 && partial.selected && partial.parser && !partial.delimiter).toBe(true);
    stage='A release';await control('release',1);await snapshot(6,'disconnected');
    // The count remains fixed through a timer turn before any visible reconnect action.
    await page.waitForTimeout(300);expect((await page.evaluate(() => globalThis.readReconnectCapture.summary())).streams).toBe(1);
    windows.push({window:1,frame:a.frame_bytes,yielded:a.yielded_bytes,head:6,subscription:1});
    stage='B asynchronous pre-native-read gate';
    const served=await page.evaluate(async () => (await fetch('/assets/client.js')).text());expect(served === source).toBe(true);
    reconnectPrivacy(chromium,testInfo.project.use);
    network=await reconnectNetwork(context,page,fixture.origin,sid,fixture.owner);
    const generation=await page.evaluate(() => globalThis.readReconnectCapture.armGate());
    await page.getByRole('button',{name:'Reconnect observation',exact:true}).click();
    await expect.poll(() => page.evaluate(() => globalThis.readReconnectCapture.gate()?.phase)).toBe('held');
    await snapshot(7);await control('reconnected',1,2);
    expect(await page.evaluate(audit => globalThis.readReconnectCapture.matches(audit),a)).toBe(true);
    stage='B CDP baseline';await network.begin(generation,a,data.titles[0],data.titles[1]);
    stage='B network receipt and error while held';
    await control('arm',2);await control('commit',2);const b=await control('hit',2);
    windows.push({window:2,frame:b.frame_bytes,yielded:b.yielded_bytes,head:7,subscription:2});
    stage='B Network.dataReceived while held';await network.received(b);await snapshot(7);
    stage='B Network.loadingFailed while held';await control('release',2);await network.failed();debug=network.summary();
    expect(debug.failedWhileHeld && debug.bytes === b.frame_bytes && debug.chunks > 0).toBe(true);
    await page.evaluate(token => globalThis.readReconnectCapture.releaseGate(token),generation);
    stage='B production applied cursor after native read';
    await expect.poll(async () => {
      observed=await page.evaluate(() => globalThis.readReconnectCapture.summary());return observed.observation;
    }).toBe('disconnected');
    if(observed.head === 8){blocked=true;throw new Error('read reconnect prototype B applied');}
    await snapshot(7,'disconnected');
    expect((await page.evaluate(() => globalThis.readReconnectCapture.gate())).nativeRejected).toBe(true);
    await network.close();network=undefined;cleanup.network=true;
    await page.waitForTimeout(300);expect((await page.evaluate(() => globalThis.readReconnectCapture.summary())).streams).toBe(2);
    await page.getByRole('button',{name:'Reconnect observation',exact:true}).click();
    await snapshot(8);await control('reconnected',2,3);
    expect(await page.evaluate(audit => globalThis.readReconnectCapture.matches(audit),b)).toBe(true);
    windows.push({window:2,frame:b.frame_bytes,yielded:b.yielded_bytes,head:7,subscription:2});
    stage='prototype disconnect';
    await page.getByRole('button',{name:'Disconnect',exact:true}).click();await exact(status,'disconnected');
    await page.evaluate(() => globalThis.readReconnectCapture.drain());expect(await page.evaluate(() => globalThis.readReconnectCapture.cleared())).toBe(true);
    expect(posts).toEqual({create:1,task:1,other:0});expect(Object.values(faults)).toEqual([0,0,0,0]);
  } catch(cause) {
    if(network) {
      debug=network.summary();
      try {gateEvidence=await page.evaluate(() => globalThis.readReconnectCapture.gate());}catch{ /* Teardown still settles the held read. */ }
    }
    const kind=['Error','TypeError','SyntaxError','TimeoutError','ProtocolError'].includes(cause?.name) ? cause.name : 'other';
    let category=['fixture protocol rejected','read reconnect protocol rejected','fixture child failed','fixture control timed out'].includes(cause?.message) ? cause.message : 'assertion';
    if(['environment','debug','options','capture','logger'].includes(cause?.privacy))category=`privacy:${cause.privacy}`;
    failure=new Error(`Read reconnect failed: ${stage}; category=${category}; blocked_b_applied=${blocked}; kind=${kind}; observer=${JSON.stringify(observed)}; network=${JSON.stringify(debug)}; gate=${JSON.stringify(gateEvidence)}; chromium=${/^\d+(?:\.\d+){3}$/.test(version ?? '') ? version : 'unknown'}; windows=${JSON.stringify(windows)}; faults=${JSON.stringify(faults)}; posts=${JSON.stringify(posts)}`);
  } finally {
    try {if(network){await network.close();cleanup.network=true;}}catch{failure ??= new Error('Read reconnect network cleanup failed');}
    try {if(page){await page.evaluate(() => globalThis.readReconnectCapture?.dispose());cleanup.observer=true;}}catch{failure ??= new Error('Read reconnect observer cleanup failed');}
    let contextClosed=!context;let browserClosed=!browser;
    try {await context?.close();contextClosed=true;}catch{failure ??= new Error('Read reconnect context cleanup failed');}
    try {await browser?.close();browserClosed=true;cleanup.browser=!!browser;}catch{failure ??= new Error('Read reconnect browser cleanup failed');}
    if(contextClosed && browserClosed){if(previous === undefined)delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;else process.env.PLAYWRIGHT_NO_COPY_PROMPT=previous;}
    try {await fixture?.stop();cleanup.fixture=fixture !== undefined;}catch{failure ??= new Error('Read reconnect fixture cleanup failed');}
  }
  console.log(`Read reconnect cleanup: ${JSON.stringify(cleanup)}`);
  if(failure)throw failure;
  console.log(`Read reconnect prototype: ${JSON.stringify(windows)}; received=Chromium-network-before-JS-consumption; parser/reducer=synchronous`);
});
