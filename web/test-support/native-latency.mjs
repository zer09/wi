// Browser-free client for the parent-owned, single C49 latency observation.
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { startFixture, captureGate11, captureLatency, latencyEvidence, requireGate11, fixtureRootAbsent } from './fixture.mjs';
import { data } from './presentation.mjs';
import { nativeCompletion, completeProof, strictStop } from './skill-source-fidelity.mjs';
import { decodeJson, requireMediaType, validateSettingsView, validateCreateView } from '../dist/api.js';
import { validateConversationPage, validateDisplayTaskAccepted, parseDisplayCursor } from '../dist/display-api.js';
import { WiConversationSseParser } from '../dist/sse.js';

const reject = () => { throw new Error('Native latency rejected'); };
const equal = (a,b) => { if (!isDeepStrictEqual(a,b)) reject(); };
function headers(reply, media, status) {
  if (reply.status !== status || reply.headers.get('cache-control') !== 'no-store'
    || reply.headers.get('x-content-type-options') !== 'nosniff') reject();
  requireMediaType(reply.headers.get('content-type'),media);
}
export async function jsonRequest(fixture, path, status, validate, body, fetchImpl = fetch) {
  const reply = await fetchImpl(fixture.origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization:`Bearer ${fixture.owner}`,Accept:'application/json',...(body === undefined ? {} : {'Content-Type':'application/json'})},
    credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  });
  headers(reply,'application/json',status);
  const bytes = await reply.arrayBuffer();
  if (bytes.byteLength > 512 * 1024) reject();
  return decodeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),reply.headers.get('content-type'),validate);
}
function compare(a,b) {
  for (const key of ['sequence','rank']) {
    if (BigInt(a[key]) !== BigInt(b[key])) return BigInt(a[key]) < BigInt(b[key]) ? -1 : 1;
  }
  for (const key of ['run_id','entry_id']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  return 0;
}
export async function drainDisplay(fixture, sid, latest, fetchImpl = fetch) {
  const initial = parseDisplayCursor(latest.live_after,'live',sid);
  if (initial.sequence !== latest.snapshot_head || initial.rank !== '3') reject();
  const abort = new AbortController();
  const reply = await fetchImpl(`${fixture.origin}/v1/sessions/${sid}/conversation/events?after=${encodeURIComponent(latest.live_after)}`,{
    method:'GET',headers:{Authorization:`Bearer ${fixture.owner}`,Accept:'text/event-stream'},credentials:'omit',cache:'no-store',redirect:'error',signal:abort.signal,
  });
  try { headers(reply,'text/event-stream',200); } catch { abort.abort(); await reply.body?.cancel().catch(()=>{}); throw new Error('Native latency rejected'); }
  if (!reply.body) reject();
  const reader = reply.body.getReader();
  let closing = false, last = initial, head = BigInt(latest.snapshot_head), frames = 0, bytes = 0, failed = false;
  let rejectLoss;
  const loss = new Promise((_,rejectLossPromise) => { rejectLoss = rejectLossPromise; });
  loss.catch(()=>{});
  const parser = new WiConversationSseParser(sid,record => {
    if (record.kind !== 'conversation') reject();
    const next = parseDisplayCursor(record.id,'live',sid), observed = BigInt(record.changes.observed_head);
    if (compare(next,last) < 0 || observed < head || BigInt(next.sequence) > observed) reject();
    last = next; head = observed; frames++;
  });
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { parser.finish(); if (!closing) reject(); break; }
        bytes += chunk.value.byteLength; parser.push(chunk.value);
      }
    } catch {
      if (!closing) { failed = true; rejectLoss(new Error('Native latency display failed')); }
    } finally { reader.releaseLock(); }
  })();
  return {
    guard: promise => Promise.race([promise,loss]),
    facts: () => ({frames,bytes,failed,head:String(head)}),
    async close() {
      closing = true; abort.abort();
      try { await reader.cancel(); } catch { /* The fetch abort can already release the reader. */ }
      await pump;
      if (failed) reject();
      return {closed:true,released:true,...this.facts()};
    },
  };
}

// A missing stat alone is not absence. Unknown probe states never certify cleanup.
export async function resolveNative(root, probes = {}) {
  const read = probes.read ?? readFile, exists = probes.exists ?? lstat;
  let text;
  try { text = await read(`/proc/${root.pid}/stat`,'utf8'); }
  catch (error) {
    if (!['ENOENT','ESRCH'].includes(error.code)) return {status:'unknown',code:'STAT_UNKNOWN'};
    try { await exists(`/proc/${root.pid}`); return {status:'unknown',code:'STAT_MISSING_PROCESS_PRESENT'}; }
    catch (error) { return {status:error.code === 'ENOENT' ? 'absent' : 'unknown',code:error.code === 'ENOENT' ? 'ENOENT' : 'DIRECTORY_UNKNOWN'}; }
  }
  const end = text.lastIndexOf(')'), fields = text.slice(end+2).trim().split(/\s+/);
  if (end < 0 || !text.startsWith(`${root.pid} (`) || fields.length < 20 || !/^[RSDZTtXxKWPI]$/.test(fields[0]) || !/^(0|[1-9][0-9]*)$/.test(fields[19])) return {status:'unknown',code:'INVALID_STAT'};
  return {status:fields[19] === root.start ? 'present' : 'reused',start_ticks:fields[19]};
}
export function cleanupProof(cleanup) {
  if (!cleanup || cleanup.stream.closed !== true || cleanup.stream.released !== true || cleanup.stream.failed
    || cleanup.root_absent !== true || !['absent','reused'].includes(cleanup.process.status)) reject();
  strictStop(cleanup.fixture);
  return true;
}
export async function runObservation(fixture, {fetchImpl = fetch, uuid = randomUUID, processProbe = resolveNative, rootProbe = lstat} = {}) {
  let stream, root, original = null, diagnostic = null, latency = null, capture = 'unavailable', phase = 0, gate = 0;
  const commands = [], receipts = [];
  const cleanup = {stream:{closed:true,released:true,failed:false},root:null,root_absent:false,process:{status:'unknown'},fixture:null,valid:false};
  try {
    root = await fixture.bindRoot(); cleanup.root = root;
    phase = 1;
    const settings = await jsonRequest(fixture,'/v1/settings',200,validateSettingsView,undefined,fetchImpl);
    if (settings.provider_transport !== 'websocket' || settings.enable_add_numbers !== true || settings.workspaces.length !== 1) reject();
    const workspace = settings.workspaces[0];
    const create = {operation_id:uuid(),title:data.title,workspace};
    const created = await jsonRequest(fixture,'/v1/sessions',201,validateCreateView,create,fetchImpl), sid = created.session_id;
    if (created.duplicate || created.warning_code !== null || created.receipt.operation_id !== create.operation_id
      || created.receipt.first_sequence !== '1' || created.receipt.last_sequence !== '1') reject();
    await fixture.request({command:'select',session_id:sid});
    phase = 2;
    const latest = await jsonRequest(fixture,`/v1/sessions/${sid}/conversation`,200,v=>validateConversationPage(v,{kind:'latest'},sid),undefined,fetchImpl);
    if (latest.snapshot_head !== '1' || latest.block !== null || latest.entries.length !== 0 || latest.session.workspace !== workspace) reject();
    stream = await drainDisplay(fixture,sid,latest,fetchImpl);
    const guarded = promise => stream.guard(promise);
    for (const task of [0,1]) {
      phase = 3+task; gate = 0;
      const command = {operation_id:uuid(),run_id:uuid(),text:data.user}; commands.push(command);
      const accepted = await guarded(jsonRequest(fixture,`/v1/sessions/${sid}/runs`,202,v=>validateDisplayTaskAccepted(v,{...command,session_id:sid}),command,fetchImpl));
      if (accepted.duplicate || accepted.warning_code !== null || accepted.notices.length !== 0) reject();
      equal([accepted.receipt.first_sequence,accepted.receipt.last_sequence],task === 0 ? ['2','3'] : ['119','120']);
      receipts.push(accepted.receipt);
      await guarded(fixture.wait('model_paused',task*6+1));
      const last = task === 0 ? 6 : 10;
      for (let nextGate = task*6+1; nextGate <= last; nextGate++) {
        gate = nextGate;
        await guarded(fixture.request({command:'drive',gate}));
        if (gate === 6) await guarded(fixture.wait('task_finished',1));
        else await guarded(fixture.wait('model_paused',gate+1));
      }
      if (task === 0) {
        const native = nativeCompletion(await guarded(fixture.inspect()),commands,receipts);
        if (native.sequence_count !== '118' || native.result_sequences[0] !== '118') reject();
        const page = await guarded(jsonRequest(fixture,`/v1/sessions/${sid}/conversation`,200,v=>validateConversationPage(v,{kind:'latest'},sid),undefined,fetchImpl));
        completeProof(page,{sid,head:'118',command,receipt:receipts[0],task:0,workspace,resultSequence:'118'});
      }
    }
  } catch (error) {
    // Freeze the original endpoint before any capture request can see later progress.
    const message = typeof error?.message === 'string' ? error.message : '';
    original = Object.freeze({phase,gate,category:message.includes('timed out') ? 'timeout' : message.includes('fixture') ? 'fixture' : 'protocol'});
  }
  try {
    diagnostic = await captureGate11(fixture,original);
    latency = await captureLatency(fixture);
    if (original === null) requireGate11(diagnostic);
    capture = 'captured';
  } catch (error) {
    const state = typeof error?.message === 'string' ? error.message.replace('fixture latency ','') : '';
    capture = ['disabled','unavailable','capture_failed'].includes(state) ? state : 'rejected';
  }
  finally {
    try { if (stream) cleanup.stream = await stream.close(); } catch { cleanup.stream = {closed:false,released:false,failed:true}; }
    try { await fixture.stop(); } catch { /* Preserve strict Stop facts, not a fallback success. */ }
    cleanup.fixture = fixture.evidence();
    try {
      if (root) {
        cleanup.process = await processProbe(root);
        cleanup.root_absent = await fixtureRootAbsent(root,rootProbe);
      }
      cleanupProof(cleanup); cleanup.valid = true;
    } catch { cleanup.valid = false; }
  }
  return Object.freeze({endpoint:original === null ? 'boundary' : 'failed',failure:original,capture,diagnostic,latency,cleanup,
    task_acceptances:receipts.map(r=>[Number(r.first_sequence),Number(r.last_sequence)]),
    // This outcome diagnoses the endpoint. It is never a C49 or G1.1 PASS.
    valid:original === null && capture === 'captured' && latency[0][6] === 0 && latency[0][7] === 0 && cleanup.valid});
}
// Unlike the historical valid predicate, this qualifies complete aggregates, not rolling detail.
export function qualifyComparison(result) {
  const incomplete = Object.freeze({admissible:false,aggregate_complete:false,rolling_detail_complete:false});
  if (!result || result.capture !== 'captured' || !result.cleanup?.valid || !Array.isArray(result.latency)
    || result.latency[31]?.[0] !== 4 || result.latency[0][7] !== 0
    || result.diagnostic?.native_state !== 'captured' || result.diagnostic.node?.state !== 'captured'
    || result.diagnostic.node.truncated || result.task_acceptances.length !== 2
    || !isDeepStrictEqual(result.task_acceptances,[[2,3],[119,120]])) return incomplete;
  const t = result.diagnostic.native.trace, rows = result.latency, work = rows[31];
  try {
    cleanupProof(result.cleanup);
    const pages = Math.ceil(rows.length/24);
    for (let page = 0; page < pages; page++) latencyEvidence({protocol:1,event:'gate11_latency',id:1,state:'captured',page,pages,rows:rows.slice(page*24,page*24+24)});
    if (rows.length > 800 || rows[0][0] !== 0 || rows.slice(1,31).some((r,i)=>r[0] !== 1 || r[1] !== i)
      || rows.slice(32).some(r=>![2,3].includes(r[0]))) return incomplete;
  } catch { return incomplete; }
  const [fetched,decoded,barriers,reads] = work.slice(1), stages = rows.slice(1,31);
  const labels = result.diagnostic.node.history.map(r=>r[1]);
  const boundary = result.endpoint === 'boundary' && result.failure === null;
  const timeout = result.endpoint === 'failed' && isDeepStrictEqual(result.failure,{phase:4,gate:10,category:'timeout'});
  if ((!boundary && !timeout) || t.consumed_ms === null || t.expected_deltas !== 70 || t.expected_frames !== 72
    || t.committed_counts[3] > 70 || barriers > t.committed_counts[3] || barriers > 70 || reads < barriers || reads > stages[1][2]
    || decoded > fetched || (decoded < fetched && stages[26][5] === 0)
    || !['drive_request','drive_ack','wait_start'].every(s=>labels.includes(s))
    || (timeout && !labels.includes('wait_expired'))) return incomplete;
  if (boundary) {
    try { requireGate11(result.diagnostic); } catch { return incomplete; }
    if (barriers !== 70 || t.committed_counts[1] !== 70) return incomplete;
  }
  return Object.freeze({admissible:true,aggregate_complete:true,
    rolling_detail_complete:rows[0][6] === 0 && t.truncated === false,
    // These are completed work at freeze, not estimates for pending SQL or a censored full burst.
    rows_fetched:fetched,rows_typed_decoded:decoded,successful_barriers:barriers,completed_reads:reads,
    pending_reads:stages[1][5],pending_fetches:stages[25][5],pending_reconstructions:stages[26][5],
    pre_window_spans:rows[0][8],window_us:rows[0][2]-rows[0][1],leaf_union_us:rows[0][3],
    unexplained_us:rows[0][4],overlap_us:rows[0][5],timeout_censored:timeout,
    historical_reproduction_claim:false,c49_pass:false});
}
export async function observeComparison(executable, mode) {
  if (!['baseline','incremental'].includes(mode)) reject();
  const fixture = await startFixture(executable,{transport:'websocket',recovered:false,mime:true,presentation:true},
    {gate11Diagnostics:true,nativeLatency:true,finalPolling:mode});
  const result = await runObservation(fixture);
  return Object.freeze({mode,result,comparison:qualifyComparison(result),original_exit_code:result.failure === null ? 0 : 1});
}
export async function observeNative(executable) {
  const fixture = await startFixture(executable,{transport:'websocket',recovered:false,mime:true,presentation:true},
    {gate11Diagnostics:true,nativeLatency:true});
  return runObservation(fixture);
}
