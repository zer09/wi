import * as fs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { facts, sid, head, expectedPage, projectionTables, digest } from './upgrade-display-parity.mjs';
import { expectedBlock } from './rich-display-parity.mjs';
import { files, leaked, responseHeaders } from './interrupted-display-parity.mjs';
import { nativeBinding, workProof } from './restart-display.mjs';
import { transportTiming, transportSizes, identity, parseStat, retirement, browserSourceProof } from './display-measurements.mjs';
const reject = () => { throw new Error('Content measurement rejected'); };
const equal = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const same = (a, b) => ['pid','ppid','start_ticks','executable','cwd'].every(k => a[k] === b[k]);

let text = '', length = 0;
for (let n = 0; ; n++) {
  const line = `C53 ${String(n).padStart(6, '0')} 雪🦀\r\n  scalar tail\t <inert>\n`;
  if (length + Buffer.byteLength(line) > 192000) break;
  text += line; length += Buffer.byteLength(line);
}
export const knownText = text + 'x'.repeat(191999 - length) + '\n';
export const totalBytes = Buffer.byteLength(knownText);
export function contentFacts() {
  const seed = structuredClone(facts); seed[1].user = knownText; return seed;
}
export function suffix(from, to = totalBytes) {
  if (!integer(from) || !integer(to) || from > to || to > totalBytes) reject();
  const bytes = Buffer.from(knownText).subarray(from, to);
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(value).equals(bytes)) reject(); return value;
}
export function contentCursor(upper) {
  suffix(upper); if (upper <= 0 || upper >= totalBytes) reject();
  return `g11c.${Buffer.from(JSON.stringify([1,sid,facts[1].run,'e:12:0','12','text','12',String(upper)])).toString('base64url')}`;
}

// Epoch and generation come from stored projection rows, not from a request or hidden browser state.
export function customProjection(value, seed, held) {
  if (value.version !== 3 || value.schema !== 3) reject();
  equal(value.names, [...projectionTables].sort()); equal(value.canonical, seed.canonical); equal(value.definitions, seed.definitions);
  const p = value.projection;
  equal(p.conversation_projection, [[1,1,Number(head),1]]);
  if (p.conversation_blocks.length !== 2 || p.conversation_entries.length !== 6 || p.conversation_fields.length !== 8) reject();
  const human = p.conversation_entries.filter(r => r[0] === facts[1].run && r[1] === 'e:12:0');
  if (human.length !== 1 || human[0][3] !== 12 || human[0][4] !== 0 || human[0][5] !== 12 || human[0][6] !== 12 || human[0][7] !== 'human') reject();
  const custom = p.conversation_fields.filter(r => r[0] === facts[1].run && r[1] === 'e:12:0');
  if (custom.length !== 1 || custom[0][2] !== 'text' || custom[0][3] !== '0' || custom[0][4] !== 12 || custom[0][5] !== totalBytes || custom[0][6] !== 'text') reject();
  let chunks = 0;
  for (const field of p.conversation_fields) {
    const selected = p.conversation_chunks.filter(r => r[0] === field[0] && r[1] === field[1] && r[2] === field[2]);
    let end = 0; const bytes = [];
    for (const r of selected) {
      const b = Buffer.from(r[4], 'hex');
      if (r[3] !== end || !b.length || b.length > 8192) reject();
      new TextDecoder('utf-8', { fatal: true }).decode(b); bytes.push(b); end += b.length; chunks++;
    }
    if (end !== field[5]) reject();
    const pages=[expectedPage(0),expectedPage(1)];
    const entries=pages.flatMap(page=>[page.block.human,...page.entries]);
    const entry=entries.find(e=>e.run_id===field[0]&&e.entry_id===field[1]);
    const expected=entry?.fields.find(f=>f.field_id===field[2]); if(!expected)reject();
    equal(field.slice(0,7),[entry.run_id,entry.entry_id,expected.field_id,expected.order_key,Number(expected.generation),
      field === custom[0] ? totalBytes : Number(expected.total_bytes),expected.kind]);
    equal(Buffer.concat(bytes), Buffer.from(field === custom[0] ? knownText : expected.text));
  }
  if (chunks !== p.conversation_chunks.length || chunks <= 8) reject();
  if (held !== undefined) equal(value, held);
  return { schema: 3, head: Number(head), tables: 5, blocks: 2, entries: 6, fields: 8, chunks, epoch: 12, generation: 12,
    total_bytes: totalBytes, canonical_sha256: digest(JSON.stringify(value.canonical)), definitions_sha256: digest(JSON.stringify(value.definitions)), projection_sha256: digest(JSON.stringify(p)) };
}
export async function partialDom(run) {
  return run.evaluate(node => ({ run_id: node.dataset.run, status: node.querySelector(':scope > .metadata').textContent,
    recording: node.querySelector(':scope > details > pre').textContent,
    entries: Array.from(node.querySelectorAll('.entry'), entry => ({ entry_id: entry.dataset.entry,
      kind: entry.querySelector('h4').textContent, state: entry.querySelector(':scope > .metadata').textContent,
      content: entry.querySelectorAll(':scope > .metadata')[1].textContent,
      incomplete_visible: !entry.querySelectorAll(':scope > .metadata')[1].hidden,
      fields: Array.from(entry.querySelectorAll('[data-field]'), field => ({ field_id: field.dataset.field,
        kind: field.querySelector('h5,summary').textContent, metadata: field.querySelector('.metadata').textContent,
        gaps: Array.from(field.querySelectorAll('[data-range]')).filter(n => n.tagName !== 'PRE').map(n => ({ range: n.dataset.range, text: n.textContent })),
        ranges: Array.from(field.querySelectorAll('pre'), pre => ({ range: pre.dataset.range, text: pre.textContent })) })) })) }));
}
export function partialDomProof(value, prior) {
  const expected = expectedBlock(expectedPage(1));
  equal({ run_id:value.run_id, status:value.status, recording:value.recording }, { run_id:expected.run_id, status:expected.status, recording:expected.recording });
  if (value.entries.length !== 3) reject();
  for (let i=1; i<3; i++) {
    const { incomplete_visible, fields, ...entry } = value.entries[i];
    equal({ ...entry, fields:fields.map(({ gaps, ...f }) => { equal(gaps, []); return f; }) }, expected.entries[i]);
    if (incomplete_visible) reject();
  }
  const human=value.entries[0], f=human.fields[0];
  if (human.entry_id !== 'e:12:0' || human.kind !== 'Human' || human.state !== expected.entries[0].state || !human.incomplete_visible
    || human.content !== 'Content or field descriptors incomplete. Reads do not imply execution completion. Earlier field descriptors are not loaded.' || human.fields.length !== 1
    || f.field_id !== 'text' || f.kind !== 'text' || f.metadata !== `Recorded bytes: ${totalBytes}; generation: 12` || f.ranges.length !== 1) reject();
  const match=/^text:([1-9][0-9]*)$/.exec(f.ranges[0].range); if (!match) reject();
  const from=Number(match[1]); if (!integer(from) || from >= totalBytes) reject();
  equal(f.ranges[0].text, suffix(from)); equal(f.gaps, [{ range:'gap:0', text:`Missing bytes [0, ${from})` }]);
  if (!prior && Buffer.byteLength(f.ranges[0].text)>32768) reject();
  if (prior) {
    if (prior.from_byte-from>32768) reject();
    if (!integer(prior.from_byte) || from >= prior.from_byte || prior.total_bytes !== totalBytes || prior.tail_sha256 !== digest(suffix(prior.from_byte))) reject();
    equal(Buffer.from(f.ranges[0].text).subarray(prior.from_byte-from), Buffer.from(suffix(prior.from_byte)));
    if (digest(JSON.stringify(value.entries.slice(1))) !== prior.activity_sha256) reject();
  }
  return { from_byte:from, to_byte:totalBytes, total_bytes:totalBytes, generation:12, epoch:12, missing_prefix:true, incomplete:true,
    scalar_aligned:true, exact_text:true, retained_tail:prior !== undefined, no_duplication:true,
    tail_sha256:digest(f.ranges[0].text), activity_sha256:digest(JSON.stringify(value.entries.slice(1))) };
}

export async function resolveFixture(env, discover, bind = nativeBinding) {
  if (env.WI_C47_FIXTURE_SHA256 !== undefined && !/^[0-9a-f]{64}$/.test(env.WI_C47_FIXTURE_SHA256)) reject();
  if (env.WI_C3A_FIXTURE === undefined) env.WI_C3A_FIXTURE = await discover();
  if (typeof env.WI_C3A_FIXTURE !== 'string' || !isAbsolute(env.WI_C3A_FIXTURE)) reject();
  const binding = await bind(env.WI_C3A_FIXTURE);
  if (env.WI_C47_FIXTURE_SHA256 !== undefined && binding.sha256 !== env.WI_C47_FIXTURE_SHA256) reject();
  return binding;
}
export async function reserveOutput(testInfo, io = fs) {
  const root=testInfo.outputPath('c53-evidence'); if (!isAbsolute(root)) reject();
  await io.mkdir(root, { mode:0o700 });
  await io.writeFile(`${root}/C53.once.json`, `${JSON.stringify({ consumed:true })}\n`, { mode:0o600, flag:'wx' });
  return root;
}

// Request identities remain live through cleanup. Publishing a measurement does not reset admission.
export function contentCollector({ origin, owner, faults }) {
  const items=new Map(), pending=new Set(), assets=new Set(), results={};
  const counts={ latest:0, sse:0, content:0, setup_content:0, before:0, within:0, entry:0, mutations:0, helper_http:0 };
  const base=`/v1/sessions/${sid}/conversation`, live=expectedPage(1).live_after;
  let sequence=0, expectedCursor, armed=false, error=false, closing=false;
  const fail=() => { error=true; faults.collector++; };
  function classify(url) {
    if (url.pathname === base && !url.search) return 'latest';
    if (url.pathname === `${base}/events`) return 'sse';
    if (url.pathname === `${base}/content`) return 'content';
    return null;
  }
  function exact(q, kind) {
    const u=new URL(q.url());
    const search=kind === 'sse' ? `?after=${encodeURIComponent(live)}` : kind === 'content' ? `?cursor=${encodeURIComponent(expectedCursor)}` : '';
    const path=kind === 'latest' ? base : `${base}/${kind === 'sse' ? 'events' : 'content'}`;
    if (u.origin !== origin || u.pathname !== path || u.search !== search || q.method() !== 'GET') reject();
  }
  return {
    async route(route) { try { if (new URL(route.request().url()).origin !== origin) { faults.external++; await route.abort(); } else await route.continue(); } catch { fail(); } },
    request(q) {
      try {
        const url=new URL(q.url()), h=q.headers(), kind=classify(url);
        if (url.origin !== origin || leaked(q.url(),owner)) reject();
        if (q.method() !== 'GET') { counts.mutations++; reject(); }
        if (url.pathname.startsWith('/v1/')) {
          if (h.authorization !== `Bearer ${owner}` || h.cookie !== undefined || h.origin !== undefined && h.origin !== origin) reject();
          if (url.pathname === base && url.search) { if(url.searchParams.has('before'))counts.before++;if(url.searchParams.has('within'))counts.within++;reject(); }
          if (url.pathname.startsWith(`${base}/entries/`)) { counts.entry++; reject(); }
          if (kind) {
            counts[kind]++;
            if (kind === 'content' && !armed) { counts.setup_content++; reject(); }
            exact(q,kind); if (items.has(q) || counts[kind] !== 1 || kind === 'sse' && ![...items.values()].some(v => v.kind === 'latest' && v.reply)) reject();
            items.set(q,{ kind, reply:null, finished:false, request_order:++sequence });
          } else if (!(url.pathname === '/v1/settings' && !url.search || url.pathname === '/v1/sessions' && url.search === '?limit=32')) reject();
        } else if (!files.has(url.pathname) || url.search) reject();
      } catch { fail(); }
    },
    response(reply) {
      try {
        const q=reply.request(), item=items.get(q), url=new URL(reply.url());
        if (item) {
          if (item.reply || reply.url() !== q.url()) reject(); exact(q,item.kind);
          responseHeaders(reply,item.kind === 'sse' ? 'text/event-stream' : 'application/json');
          item.reply=reply; item.response_order=++sequence;
          if (item.kind === 'sse') results.sse={ identity_match:true, status:200, no_store:true, headers_only:true,
            request_order:item.request_order, response_order:item.response_order };
        } else {
          if (classify(url)) reject();
          const file=files.get(url.pathname);
          if (file) {
            const task=(async () => {
              responseHeaders(reply,file[1]); const assetReply=reply;
              const bytes=await assetReply.body();
              equal(bytes,await fs.readFile(new URL(`../${file[0]}`,import.meta.url)));
              if (leaked(bytes.toString('utf8'),owner)) reject(); assets.add(url.pathname);
            })().catch(fail).finally(()=>pending.delete(task)); pending.add(task);
          } else responseHeaders(reply,'application/json');
        }
      } catch { fail(); }
    },
    finished(q) {
      const item=items.get(q);
      if (!item) { try { if(classify(new URL(q.url())))fail(); } catch { fail(); } return; }
      if (item.kind === 'sse') return;
      const task=(async () => {
        if (item.finished || !item.reply || item.reply.request() !== q) reject();
        item.finished=true; const finished_order=++sequence;
        const result={ identity_match:true, status:200, no_store:true, requestfinished:true,
          request_order:item.request_order, response_order:item.response_order, finished_order };
        if (item.kind === 'content') {
          result.timing=transportTiming(q.timing());
          let timer;
          try { result.sizes=transportSizes(await Promise.race([q.sizes(),new Promise((_,failSize)=>{
            timer=setTimeout(()=>failSize(new Error('Public sizes unavailable')),5000);
          })])); } finally { clearTimeout(timer); }
          if (result.sizes.responseBodySize > 512*1024) reject();
        }
        if (results[item.kind]) reject(); results[item.kind]=result;
      })().catch(fail).finally(()=>pending.delete(task)); pending.add(task);
    },
    closing() { closing=true; },
    failed(q) { const item=items.get(q); if (closing && item?.kind === 'sse' && item.reply) return; fail(); },
    arm(cursor) { if (armed || !results.latest || !results.sse || counts.content || error) reject(); expectedCursor=cursor; armed=true; },
    ready(kind) { return !error && results[kind] !== undefined; },
    async drain() { while (pending.size) await Promise.all([...pending]); },
    facts() { return structuredClone({ counts, operations:results, failed:error, pending:pending.size, assets:assets.size }); },
    cleanupProof() {
      if (error || pending.size || ['setup_content','before','within','entry','mutations','helper_http'].some(k=>counts[k]!==0)) reject();
      for(const kind of ['latest','sse','content']) {
        const observed=[...items.values()].filter(v=>v.kind===kind);
        if(counts[kind]>1 || observed.length!==counts[kind] || observed.some(v=>!v.reply || kind!=='sse'&&!v.finished)
          || (counts[kind]===1)!==(results[kind]!==undefined)) reject();
      }
      return this.facts();
    },
    proof() {
      this.cleanupProof();
      if (error || pending.size || counts.latest !== 1 || counts.sse !== 1 || counts.content !== 1
        || ['setup_content','before','within','entry','mutations','helper_http'].some(k=>counts[k]!==0) || !results.latest || !results.sse || !results.content) reject();
      return this.facts();
    },
  };
}

// A stopped zero-work pair proves early cleanup only, never a completed content case.
export function contentWork(samples) {
  if (!Array.isArray(samples) || samples.length < 2 || samples[0].event !== 'sample'
    || samples.at(-1).event !== 'stopped') reject();
  for (const [index,sample] of samples.entries()) {
    if(sample.event !== (index===samples.length-1 ? 'stopped' : 'sample')) reject();
    workProof(sample.work,'observe');
  }
  return true;
}
export const contentPhases = ['fresh_goto','fresh_token_empty','fresh_task_empty','fresh_rows_empty','fresh_boundary',
  'token_fill','connect_click','token_cleared','latest_sse_ready','session_title','streaming_status','run_count','run_identity','partial_dom_poll',
  'initial_settled','initial_dom','geometry_read','viewport_filled','initial_snapshot','initial_projection','initial_catalog','initial_files','initial_sample',
  'no_content','no_setup_content','no_other_older','content_cursor','content_arm','content_click','content_ready','prepend_dom_poll','prepend_settled',
  'prepend_dom','retained_settled','retained_dom','retained_projection','retained_catalog','content_sample','content_discovery',
  'privacy_boundary','commands_empty','task_empty','content_drain','content_proof','zero_faults'];
const diagnosticValue = read => { try { return read(); } catch { return undefined; } };
const diagnosticCount = read => { const n=diagnosticValue(read); return integer(n)&&n<=1000000 ? n : 'unavailable'; };
const diagnosticBoolean = read => { const v=diagnosticValue(read); return typeof v==='boolean' ? v : 'unavailable'; };
export function contentDiagnostics(readNetwork, faults) {
  const states=Object.fromEntries(contentPhases.map(k=>[k,'not_started']));let packet=null, firstOperation=null;
  function freeze(first) {
    if(firstOperation!==null)return packet;
    firstOperation=contentPhases.includes(first)?first:'outside_path';
    const phases=Object.freeze({...states});
    const network=diagnosticValue(readNetwork);
    const operations=Object.fromEntries(['latest','sse','content'].map(k=>{
      const value=diagnosticValue(()=>network.operations[k]);
      const status=diagnosticValue(()=>value.status);
      return [k,Object.freeze({observed:diagnosticBoolean(()=>value===undefined?undefined:value.identity_match),
        status:Number.isInteger(status)&&status>=100&&status<=599?status:'unavailable'})];
    }));
    packet=Object.freeze({first_operation:firstOperation,phases,
      counts:Object.freeze(Object.fromEntries(['latest','sse','content','setup_content','before','within','entry','mutations','helper_http'].map(k=>[k,diagnosticCount(()=>network.counts[k])]))),
      pending:diagnosticCount(()=>network.pending),collector_failed:diagnosticBoolean(()=>network.failed),operations:Object.freeze(operations),
      faults:Object.freeze(Object.fromEntries(['external','request','response','console','page','private','collector'].map(k=>[k,diagnosticCount(()=>faults[k])])))});
    return packet;
  }
  return {
    async operation(name, action) {
      if(!contentPhases.includes(name)||states[name]!=='not_started')reject();states[name]='pending';
      try { const value=await action();states[name]='resolved';return value; }
      catch(error) { states[name]='failed';try { freeze(name); } catch {} throw error; }
    },
    freeze, packet:()=>packet,
  };
}

// Finite ancestry discovery uses stat and identity only. It does not read process memory.
export async function browserTree(root, io = fs) {
  if (root.state !== 'present') reject();
  const stats=new Map(), members=[root], errors={ enumeration:0, stat:0, identity:0 };
  try {
    for (const name of await io.readdir('/proc')) if (/^[1-9][0-9]*$/.test(name)) {
      const pid=Number(name); try { stats.set(pid,parseStat(await io.readFile(`/proc/${pid}/stat`,'utf8'),pid)); } catch (error) {
        // A listed process may disappear before its first stat read; other failures remain fatal.
        if (!['ENOENT','ESRCH'].includes(error?.code)) errors.stat++;
      }
    }
  } catch { errors.enumeration++; }
  const anchor=await identity(root.pid,io); if (anchor.state !== 'present' || !same(anchor,root)) reject();
  const known=new Map([[root.pid,root]]); let changed=true;
  while(changed) {
    changed=false;
    for(const [pid,s] of stats) if(!known.has(pid)&&known.has(s.ppid)) {
      const parent=known.get(s.ppid), current=await identity(pid,io), parentNow=await identity(parent.pid,io);
      if (same(parentNow,parent) && current.state === 'absent') {
        // Confirmed absence is not membership, but it does not bypass the parent proof.
        stats.delete(pid);
      } else if(current.state==='present'&&current.start_ticks===s.start_ticks&&current.ppid===parent.pid&&same(parentNow,parent)) {
        known.set(pid,current);members.push(current);changed=true;
      } else { errors.identity++;stats.delete(pid); }
    }
  }
  if(errors.enumeration||errors.stat||errors.identity)reject();
  return { members, errors };
}
export async function retireTree(members, io = fs) {
  if (!members.length) reject();
  const values=await Promise.all(members.map(v=>retirement(v,io)));
  if(values.some(v=>!['absent','reused'].includes(v.retirement)))reject();return values;
}
export function removable(cleanupFailed, fallback, handles, native, browser) {
  return !cleanupFailed && !fallback && handles.active===0 && handles.opens===handles.closes
    && native.length>0 && browser.length>0 && [...native,...browser].every(v=>['absent','reused'].includes(v.retirement));
}
export function sourceGuard(spec, helper) {
  browserSourceProof(spec);
  const implementation=helper.slice(0,helper.indexOf('export function sourceGuard'));
  const forbidden=[/newCDPSession|_channel|_connection|wsPath\s*:|executablePath\s*:|args\s*:/,
    /\.(json|text|arrayBuffer)\s*\(/,/test\.(skip|fixme|only)\s*\(/,/globalThis\.fetch\s*=|prototype\.|\.stack\b|console\./,
    /memoryProbe\s*\(|sampler\s*\(|fetch\s*\(/,/JSON\.stringify\((error|reply|request|response|process\.env)\)/];
  if (/\.body\s*\(/.test(spec) || forbidden.some(re=>re.test(spec)||re.test(implementation))
    || (spec.match(/name: 'Load older', exact: true/g)??[]).length!==1
    || !spec.includes("context.on('requestfailed', network.failed)") || !spec.includes("host: '127.0.0.1'")
    || !spec.includes("reserveOutput(testInfo)") || !spec.includes('resolveFixture(process.env, discoverFixture)')
    || !spec.includes('() => chromium.connect(server.wsEndpoint())') || (spec.match(/server\.wsEndpoint\(\)/g)??[]).length!==1
    || (implementation.match(/\.body\s*\(/g)??[]).length!==1 || !implementation.includes('await assetReply.body()')) reject();
  return true;
}
