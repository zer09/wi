import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { discoverFixture } from '../test-support/fixture.mjs';
import { data } from '../test-support/presentation.mjs';
import { decodeJson, validateCreateView, validateUuid } from '../dist/api.js';
import { validateDisplayTaskAccepted } from '../dist/display-api.js';
import { displayedBlock, normalizedDom } from '../test-support/rich-display-parity.mjs';
import { nativeBinding, createRestartRoot, startRestartProcess, removeRestartRoot, runningProof,
  stableProof, entryProof, receiptProof, publicJson, handshakeProof } from '../test-support/restart-display.mjs';
import { boundary, publicPrivacy, displayProof, interruptedSnapshot, sameDom, collector, newRecord, newFaults,
  responseHeaders, recoveryOrder, observerWork, browserRequests, cleanupProof, shutdownHead } from '../test-support/interrupted-display-parity.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function exact(locator, text) {
  await expect(locator).toHaveCount(1);
  await expect.poll(async () => (await locator.textContent()) === text).toBe(true);
}
async function readReply(response, code, validate) {
  const headers = responseHeaders(response, 'application/json', code), bytes = await response.body();
  expect(bytes.length <= 512 * 1024).toBe(true);
  return decodeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), headers['content-type'], validate);
}
const stages = ['binding','produce','connect-a','create','task','partial','close-a','kill','observe','connect-observer','parity','close-observers','drain','cleanup'];
const checks = ['identity','reply','work','fields','handshake','privacy','assets','requests','cleanup'];
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('two independently fresh browsers retain exact same-H24 interrupted rich display after owned SIGKILL', async ({ browser }) => {
  let fixture, producer, observer, sid, command, receipt, failure;
  let stage = 'binding', check = 'identity', permission = 'none', rootRemoved = false;
  const contexts = [], pages = [], closed = [false,false,false], records = [newRecord(),newRecord(),newRecord()];
  const faults = newFaults(), assetReads = [], order = recoveryOrder(), saved = [], dom = [], helperRequests = [];
  try {
    const binding = await nativeBinding(await discoverFixture());
    console.log(`Interrupted parity binding: ${JSON.stringify(binding)}`);
    fixture = await createRestartRoot(); stage = 'produce'; producer = await startRestartProcess(binding, fixture, 'produce');
    async function pageFor(context, process, index) {
      const c = collector({ origin: process.origin, owner: fixture.owner, index, record: records[index], faults, assetReads,
        session: () => sid, permission: () => permission, command: () => command, acceptCommand: value => { command = value; } });
      await context.route('**/*', c.route); context.on('request', c.request); context.on('response', c.response);
      const page = await context.newPage();
      page.on('console', () => { faults.console++; }); page.on('pageerror', () => { faults.page++; });
      return page;
    }
    const status = page => page.locator('.topbar [role="status"]');
    const transcript = page => page.getByRole('region', { name: 'Canonical conversation', exact: true });
    const button = (page, name) => page.getByRole('button', { name, exact: true });
    async function connect(page) {
      await page.getByLabel('Owner token', { exact: true }).fill(fixture.owner); await button(page, 'Connect').click();
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue('');
    }
    async function display(page, proof) {
      const run = transcript(page).locator('.run'); await expect(run).toHaveCount(1);
      await expect.poll(async () => { try { return displayProof(await displayedBlock(run), proof); } catch { return false; } }).toBe(true);
      await exact(page.getByRole('heading', { name: 'Canonical session title', exact: true }), data.title);
      return normalizedDom(run);
    }
    async function proofRead(process, suffix, validate, body) {
      const action = async () => {
        helperRequests.push({ phase: process === observer ? 'observe' : 'produce', method: body === undefined ? 'GET' : 'POST',
          kind: suffix.endsWith('/reconcile') ? 'receipt' : suffix.includes('/entries/') ? 'entry' : 'latest' });
        const value = await publicJson(process, fixture.owner, suffix, validate, body); publicPrivacy(value, fixture.owner); return value;
      };
      if (process === observer) return order.read(action);
      return action();
    }
    async function addressed(process, proof) {
      for (const entry of [proof.block.human, ...proof.entries]) await proofRead(process,
        `/v1/sessions/${sid}/conversation/entries/${command.run_id}/${encodeURIComponent(entry.entry_id)}`, value => entryProof(value, proof, entry));
    }
    async function reconciliation(process, proof) {
      await proofRead(process, `/v1/sessions/${sid}/runs/reconcile`, value => receiptProof(value, proof, command, receipt), command);
      await proofRead(process, `/v1/sessions/${sid}/conversation`, value => stableProof(value, proof));
    }
    contexts[0] = await browser.newContext({ serviceWorkers: 'block' }); const a = pages[0] = await pageFor(contexts[0], producer, 0);
    stage = 'connect-a'; await a.goto(`${producer.origin}/`); await connect(a); await exact(status(a), 'connected');
    check = 'privacy'; await boundary(a, contexts[0], fixture.owner);
    stage = 'create'; permission = 'create'; await a.getByLabel('Title', { exact: true }).fill(data.title);
    check = 'reply'; const [createdReply] = await Promise.all([
      a.waitForResponse(response => response.url() === `${producer.origin}/v1/sessions` && response.request().method() === 'POST'), button(a, 'Create session').click(),
    ]);
    const created = await readReply(createdReply, 201, validateCreateView); publicPrivacy(created, fixture.owner);
    sid = validateUuid(created.session_id); permission = 'none';
    const [aLatest] = await Promise.all([
      a.waitForResponse(response => records[0].snapshots.some(item => item.request === response.request())), button(a, 'Open receipt session').click(),
    ]);
    await exact(status(a), 'connected; observation: streaming');
    await expect.poll(() => records[0].streams.length === 1 && records[0].streams[0].reply !== null).toBe(true);
    const empty = await proofRead(producer, `/v1/sessions/${sid}/conversation`, value => {
      expect(value.snapshot_head === '1' && value.block === null && value.entries.length === 0).toBe(true); return value;
    });
    handshakeProof({ origin: producer.origin, sid, head: '1', value: empty, snapshots: records[0].snapshots, streams: records[0].streams, reply: aLatest });
    check = 'identity'; await producer.request({ command: 'select', session_id: sid });
    stage = 'task'; permission = 'task'; await a.getByLabel('Task', { exact: true }).fill(data.user);
    check = 'reply'; const [acceptedReply] = await Promise.all([
      a.waitForResponse(response => response.url() === `${producer.origin}/v1/sessions/${sid}/runs` && response.request().method() === 'POST'), button(a, 'Send').click(),
    ]);
    const accepted = await readReply(acceptedReply, 202, value => validateDisplayTaskAccepted(value, { ...command, session_id: sid }));
    expect(!accepted.duplicate && accepted.warning_code === null && accepted.notices.length === 0).toBe(true);
    publicPrivacy(accepted, fixture.owner); receipt = accepted.receipt; permission = 'none'; await producer.wait(1);
    stage = 'partial'; await producer.request({ command: 'drive', gate: 1 }); await producer.wait(2);
    check = 'work'; await producer.sample();
    check = 'fields'; const before = await proofRead(producer, `/v1/sessions/${sid}/conversation`,
      value => runningProof(value, sid, command, receipt, fixture.workspace));
    await addressed(producer, before); await reconciliation(producer, before);
    const liveDom = await display(a, before); await expect(button(a, 'Cancel current run')).toBeEnabled();
    check = 'privacy'; await boundary(a, contexts[0], fixture.owner);
    stage = 'close-a'; await contexts[0].close(); closed[0] = true;
    check = 'work'; await producer.sample();
    check = 'fields'; await proofRead(producer, `/v1/sessions/${sid}/conversation`, value => stableProof(value, before));
    stage = 'kill'; check = 'cleanup'; await producer.killProducer();
    console.log(`Interrupted parity partial: head=${before.snapshot_head}; receipt=${hash(JSON.stringify(receipt))}; dom=${hash(liveDom)}; tasks=1; sigkill=true`);
    stage = 'observe'; check = 'identity'; observer = await startRestartProcess(binding, fixture, 'observe');
    expect(observer.pid !== producer.pid).toBe(true);
    await observer.request({ command: 'select', session_id: sid }); await observer.sample(); order.selected();
    for (const index of [1,2]) {
      stage = 'connect-observer'; check = 'identity'; contexts[index] = await browser.newContext({ serviceWorkers: 'block' });
      const page = pages[index] = await pageFor(contexts[index], observer, index); await page.goto(`${observer.origin}/#session=${sid}`);
      await expect(page.getByLabel('Owner token', { exact: true })).toHaveValue(''); await expect(transcript(page).locator('.run')).toHaveCount(0);
      expect(records[index].requests.every(request => !request.path.startsWith('/v1/'))).toBe(true);
      await boundary(page, contexts[index], fixture.owner); await observer.sample();
      check = 'reply'; const [originalLatest] = await Promise.all([
        page.waitForResponse(response => records[index].snapshots.some(item => item.request === response.request())), connect(page),
      ]);
      await exact(status(page), 'connected; observation: streaming');
      await expect.poll(() => records[index].streams.length === 1 && records[index].streams[0].reply !== null).toBe(true);
      await exact(transcript(page).locator('.run > .metadata'), 'Execution: interrupted. Final result not recorded.');
      order.displayed(index, records[index], originalLatest, await transcript(page).locator('.run > .metadata').textContent());
      check = 'fields'; saved[index-1] = await proofRead(observer, `/v1/sessions/${sid}/conversation`,
        value => interruptedSnapshot(value, before, saved[0]));
      check = 'handshake'; order.handshake(index, { origin: observer.origin, sid, head: saved[index-1].snapshot_head, value: saved[index-1],
        snapshots: records[index].snapshots, streams: records[index].streams, reply: originalLatest });
      check = 'fields'; dom[index-1] = await display(page, saved[index-1]); await addressed(observer, saved[index-1]); await reconciliation(observer, saved[index-1]);
      await expect(button(page, 'Cancel current run')).toBeDisabled(); await expect(page.locator('.command')).toHaveCount(0);
      await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
      check = 'privacy'; await boundary(page, contexts[index], fixture.owner); check = 'work'; await observer.sample();
    }
    stage = 'parity'; check = 'fields'; interruptedSnapshot(saved[1], before, saved[0]); sameDom(dom[0], dom[1]);
    // B stays connected throughout C's separate Connect and the final same-H observation.
    await exact(status(pages[1]), 'connected; observation: streaming'); await exact(status(pages[2]), 'connected; observation: streaming');
    sameDom(await display(pages[1], saved[0]), await display(pages[2], saved[1]));
    await proofRead(observer, `/v1/sessions/${sid}/conversation`, value => stableProof(value, saved[0]));
    const sequence = order.finish(); check = 'privacy';
    for (const index of [1,2]) await boundary(pages[index], contexts[index], fixture.owner);
    check = 'assets'; await Promise.all(assetReads);
    stage = 'close-observers'; await contexts[2].close(); closed[2] = true; await contexts[1].close(); closed[1] = true;
    check = 'work'; await observer.sample();
    await proofRead(observer, `/v1/sessions/${sid}/conversation`, value => stableProof(value, saved[0]));
    check = 'requests'; browserRequests(records, faults);
    stage = 'drain'; check = 'cleanup'; await observer.stopObserver(); observerWork(observer.samples);
    await shutdownHead(fixture, sid);
    stage = 'cleanup'; rootRemoved = await removeRestartRoot(fixture, [producer, observer]);
    cleanupProof({ closed, rootRemoved, producer: producer.evidence(), observer: observer.evidence() });
    console.log(`Interrupted parity proof: ${JSON.stringify({ head:'24',pre_head:'23',entries:2,fields:12,post_counts:records.map(r=>r.requests.filter(q=>q.method==='POST').length),latest:records.map(r=>r.snapshots.length),streams:records.map(r=>r.streams.length),assets:records.map(r=>r.assets.size),dom:dom.map(hash),dto:saved.map(p=>hash(JSON.stringify(p))),sequence,helper_requests:helperRequests,work_samples:observer.samples.length,shutdown_head:'24',faults })}`);
  } catch {
    failure = new Error(`Interrupted parity failed: stage=${stages.includes(stage) ? stage : 'unknown'}; check=${checks.includes(check) ? check : 'unknown'}`);
  } finally {
    for (const index of [2,1,0]) if (contexts[index] && !closed[index]) {
      try { await contexts[index].close(); closed[index] = true; } catch { failure ??= new Error('Interrupted parity context cleanup failed'); }
    }
    if (failure) {
      for (const process of [producer,observer]) if (process) { try { await process.fallback(); } catch { failure = new Error('Interrupted parity reap failed'); } }
      // Failure-only removal follows owned child reaping. It never supplies a successful cleanup proof.
      if (fixture && !rootRemoved && [producer,observer].filter(Boolean).every(process => process.evidence().reaped)) {
        try { await rm(fixture.root, { recursive: true, force: true }); rootRemoved = true; } catch { failure = new Error('Interrupted parity root cleanup failed'); }
      }
    }
    console.log(`Interrupted parity cleanup: ${JSON.stringify({ closed,rootRemoved,failed:!!failure,producer:producer?.evidence(),observer:observer?.evidence() })}`);
    if (!failure) { try { cleanupProof({ closed,rootRemoved,producer:producer.evidence(),observer:observer.evidence() }); } catch { failure = new Error('Interrupted parity strict cleanup rejected'); } }
  }
  if (failure) throw failure;
});
