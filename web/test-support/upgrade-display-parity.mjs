import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { ROOT } from './fixture.mjs';
import { rootProof, terminalProof, processIdentity, workProof, handshakeProof } from './restart-display.mjs';
import { files, leaked, responseHeaders, publicPrivacy, boundary } from './interrupted-display-parity.mjs';
import { expectedBlock } from './rich-display-parity.mjs';
import { validateConversationPage, validateEntryPage } from '../dist/display-api.js';
export { boundary, publicPrivacy };
const reject = () => { throw new Error('Upgrade parity rejected'); };
const equal = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); return true; };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = n => `51000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const sid = uuid(1), title = 'Legacy upgrade 雪 <img src="https://invalid.example/x">';
export const missing = 'ab123456-789a-4bcd-8abc-0123456789ab';
export const head = '21';
export const facts = ['A', 'B'].map((name, i) => ({ name, run: uuid(10 + i), accepted: 2 + 10 * i,
  user: `  Legacy ${name} user 雪🦀\r\nsecond line\t \n`,
  text: `Legacy ${name} exact answer 雪🦀\r\n  preserved whitespace\t\n` + (i ? 'B viewport line 雪\n'.repeat(36) : 'A short tail\n'),
  tool: ` {"legacy":"${name}","error":true,"snow":"雪🦀"} \r\n  saved tail\t \n`, is_error: i === 1 }));
const ddlPins = [['src/storage/session_v2.sql', '8b886aed5ddc190d15d459c05015ae6a9d84167140016e3e63df1ee7d38400bf'],
  ['tests/storage/catalog_v1.sql', 'd7e4adcc4fcef1aeb8e6ac3da0b81188a39bd8af7917ad14714be6d31a9b5229']];
const canonicalColumns = {
  manifest: ['singleton','session_id','format_version','title','workspace_json','created_at_ms','updated_at_ms','head_sequence','creation_provenance_json'],
  events: ['sequence','event_id','event_type','event_version','created_at_ms','run_id','source_event_id','source_sequence','payload_json'],
  commands: ['operation_id','method','payload_hash','first_sequence','last_sequence','receipt_json'],
  runs: ['run_id','accepted_sequence','state','last_runtime_sequence','owner_instance_id','provider_session_id','terminal_sequence','terminal_json','result_sequence'],
  tool_results: ['run_id','call_id','tool_name','request_id','started_sequence','finished_sequence','result_sequence','is_error','output'],
};
export const projectionTables = ['conversation_projection','conversation_blocks','conversation_entries','conversation_fields','conversation_chunks'];
const handles = new Set();
let opens = 0, closes = 0;
export function handleFacts() { return { active: handles.size, opens, closes }; }
function database(path, readOnly, action) {
  const db = new DatabaseSync(path, { readOnly }); handles.add(db); opens++;
  try { return action(db); } finally { db.close(); handles.delete(db); closes++; }
}
const normalize = value => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
const rows = (db, query) => db.prepare(query).all().map(row => Object.values(row).map(normalize));
export const sessionPath = fixture => join(fixture.root, 'private-data/sessions', sid.slice(0, 2), sid, 'session.sqlite3');
export async function ownedFilesProof(fixture) {
  for (const name of ['private-data','private-data/sessions',`private-data/sessions/${sid.slice(0,2)}`,`private-data/sessions/${sid.slice(0,2)}/${sid}`]) {
    const metadata = await lstat(join(fixture.root,name));
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o7077) !== 0 || metadata.uid !== process.getuid()) reject();
  }
  for (const path of [sessionPath(fixture),join(fixture.root,'private-data/catalog.sqlite3')]) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o7077) !== 0 || metadata.uid !== process.getuid()) reject();
  }
  return true;
}
export function snapshot(fixture) {
  return database(sessionPath(fixture), true, db => {
    db.exec('BEGIN');
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const schema = db.prepare('SELECT schema_version FROM manifest').get().schema_version;
      const names = rows(db, "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'conversation_%' ORDER BY name").flat();
      const canonical = {};
      for (const [table, columns] of Object.entries(canonicalColumns)) canonical[table] = rows(db, `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${columns[0]}`);
      const definitions = rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'conversation_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const projection = {};
      for (const table of names) { if (!projectionTables.includes(table)) reject(); projection[table] = rows(db, `SELECT * FROM ${table} ORDER BY ${table === 'conversation_projection' ? 'singleton' : 'run_id'}${table === 'conversation_entries' ? ',entry_id' : table === 'conversation_fields' ? ',entry_id,field_id' : table === 'conversation_chunks' ? ',entry_id,field_id,start_byte' : ''}`); }
      if (rows(db, 'PRAGMA foreign_key_check').length || rows(db, 'PRAGMA integrity_check').flat().join() !== 'ok') reject();
      return { version, schema, names, canonical, definitions, projection };
    } finally { db.exec('ROLLBACK'); }
  });
}
export function legacyProof(value, seed) {
  if (value.version !== 2 || value.schema !== 2 || value.names.length || Object.keys(value.projection).length) reject();
  equal(value.canonical, seed.canonical); equal(value.definitions, seed.definitions);
  if (String(value.canonical.manifest[0][7]) !== head || value.canonical.events.length !== Number(head)) reject();
  return true;
}
export function upgradedProof(value, seed, held) {
  if (value.version !== 3 || value.schema !== 3) reject();
  equal(value.names, [...projectionTables].sort()); equal(value.canonical, seed.canonical); equal(value.definitions, seed.definitions);
  equal(value.projection.conversation_projection, [[1,1,Number(head),1]]);
  if (value.projection.conversation_blocks.length !== 2 || value.projection.conversation_entries.length !== 6
    || value.projection.conversation_fields.length !== 8 || value.projection.conversation_chunks.length !== 8) reject();
  if (held !== undefined) equal(value, held);
  return true;
}
export async function seedLegacy(fixture) {
  await rootProof(fixture, 'observe');
  const ddl = [];
  for (const [file, expected] of ddlPins) { const bytes = await readFile(join(ROOT, file)); if (digest(bytes) !== expected) reject(); ddl.push(bytes.toString('utf8')); }
  // Storage rejects group/other access. Create private files before SQLite opens them.
  await mkdir(join(fixture.root, 'private-data/sessions', sid.slice(0,2), sid), { recursive: true, mode: 0o700 });
  for (const path of [sessionPath(fixture),join(fixture.root,'private-data/catalog.sqlite3')]) await writeFile(path,'',{ flag:'wx',mode:0o600 });
  const request = JSON.stringify({ method: 'create_session', title, workspace: null });
  const receipt = { operation_id: uuid(2), session_id: sid, run_id: null, first_sequence: 1, last_sequence: 1 };
  const provenance = { operation_id: uuid(2), method: 'create_session', session_id: sid, creation_event_id: uuid(3), created_at_ms: 42,
    request_json: request, payload_hash: [...createHash('sha256').update(request).digest()], receipt };
  const canonical = Object.fromEntries(Object.keys(canonicalColumns).map(key => [key, []]));
  canonical.manifest.push([1,sid,1,title,null,42,42,Number(head),JSON.stringify(provenance)]);
  let sequence = 0;
  const insert = (type, run, payload, event = uuid(100 + sequence + 1)) => {
    sequence++; const text = ` \n${JSON.stringify(payload, null, 2)}\n `;
    canonical.events.push([sequence,event,type,1,42,run,payload.event_id ?? null,payload.sequence ?? null,text]); return sequence;
  };
  insert('session.created', null, { title, workspace: null, creation_provenance: provenance }, uuid(3));
  for (const fact of facts) {
    const input = { user_text: fact.user, prepared_request: { provider_id: 'synthetic', options: { model: 'model', instructions: 'private-operator-legacy',
      tools: [], transport: 'websocket', required_features: [] }, prompt: 'private-project-legacy\r\n雪' }, tool_definitions: [], available_skills: [], active_skills: [], project_instructions_source: null };
    const owner = uuid(30 + fact.accepted);
    const accepted = insert('run.accepted', fact.run, { run_id: fact.run, owner_instance_id: owner, input });
    let source = 0;
    const observed = payload => { const type = payload.type; return insert('runtime.observed', fact.run, { ...payload, schema_version: 2, sequence: ++source,
      event_id: uuid(200 + sequence + 1), run_id: fact.run, session_id: type === 'run_started' ? null : 'session',
      turn_id: ['run_started','run_finished'].includes(type) ? null : 'turn', request_id: ['run_started','turn_started'].includes(type) ? null : 'request' }); };
    observed({ type: 'run_started' }); observed({ type: 'turn_started', number: 1 });
    const item = { id: 'item', kind: 'message', native_type: 'message', function_call: null,
      native: { id: 'item', type: 'message', content: [{ type: 'output_text', text: fact.text }], opaque_response: 'private-native-legacy' } };
    const response = { id: 'response', model: 'observed-model', outcome: { status: 'completed' }, text: fact.text, usage: null,
      output: [item], output_provenance: 'native_terminal', native: { id: 'response', status: 'completed', output: [item.native] } };
    observed({ type: 'provider_event', event: { schema_version: 1, sequence: 1, event_id: uuid(300 + accepted), session_id: 'session', request_id: 'request',
      provider: 'synthetic', provider_sequence: null, type: 'response_finished', response } });
    const started = observed({ type: 'tool_event', event: { type: 'tool_execution_started', call_id: 'call', tool_name: 'synthetic' } });
    const result = insert('tool.result.recorded', fact.run, { request_id: 'request', call_id: 'call', output: fact.tool, is_error: fact.is_error });
    const finished = observed({ type: 'tool_event', event: { type: 'tool_execution_finished', call_id: 'call', tool_name: 'synthetic', is_error: fact.is_error } });
    observed({ type: 'turn_finished', number: 1, response_id: 'response', outcome: { type: 'tools_prepared' }, upstream_outcome: 'terminal_received' });
    const summary = { turns_started: 0, turns_finished: 0, model_requests_attempted: 0, model_requests_admitted: 0, new_tool_dispatches: 0,
      tool_results_prepared: 0, reused_results: 0, last_request_id: null, last_upstream_outcome: null };
    const terminal = observed({ type: 'run_finished', outcome: { type: 'completed' }, summary });
    const terminalJson = canonical.events.at(-1)[8];
    const final = insert('run.result.recorded', fact.run, { run_id: fact.run, session_id: 'session', outcome: { type: 'completed' }, summary,
      last_response: response, events_complete: true, sink_error: null });
    canonical.runs.push([fact.run,accepted,'completed',source,owner,'session',terminal,terminalJson,final]);
    canonical.tool_results.push([fact.run,'call','synthetic','request',started,finished,result,Number(fact.is_error),fact.tool]);
    const op = uuid(400 + accepted), acceptRequest = JSON.stringify({ method: 'accept_run', session_id: sid, run_id: fact.run, input });
    canonical.commands.push([op,'accept_run',digest(acceptRequest),accepted,accepted,`\n ${JSON.stringify({ operation_id: op, session_id: sid, run_id: fact.run, first_sequence: accepted, last_sequence: accepted })} `]);
  }
  if (String(sequence) !== head) reject();
  database(sessionPath(fixture), false, db => {
    db.exec(ddl[0]); db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    for (const [table, data] of Object.entries(canonical)) for (const row of data) {
      const values = row.map((v, i) => table === 'commands' && i === 2 ? Buffer.from(v, 'hex') : v);
      if (table === 'manifest') db.prepare('INSERT INTO manifest VALUES (?,?,2,?,?,?,?,?,?,?)').run(...values);
      else db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values);
    }
    // Released immutable triggers must reject writes without changing saved facts.
    for (const query of ['UPDATE events SET payload_json=payload_json','DELETE FROM events','UPDATE commands SET receipt_json=receipt_json','DELETE FROM commands','UPDATE manifest SET created_at_ms=43']) {
      let denied = false; try { db.exec(query); } catch { denied = true; } if (!denied) reject();
    }
    if (rows(db, 'PRAGMA foreign_key_check').length) reject(); db.exec('COMMIT');
  });
  database(join(fixture.root, 'private-data/catalog.sqlite3'), false, db => {
    db.exec(ddl[1]);
    db.prepare("INSERT INTO sessions (session_id,relative_path,title,created_at_ms,updated_at_ms,head_sequence,schema_version,availability) VALUES (?,?,?,42,42,?,2,'ready')")
      .run(sid, `sessions/${sid.slice(0,2)}/${sid}/session.sqlite3`, title, Number(head));
    db.prepare("INSERT INTO creation_commands VALUES (?,?,?,?,?,42,'accepted',?,NULL)").run(uuid(2),Buffer.from(provenance.payload_hash),request,sid,uuid(3),JSON.stringify(receipt));
  });
  const before = snapshot(fixture); equal(before.canonical, canonical);
  const seed = { canonical, definitions: before.definitions, fixture_hashes: ddlPins, before };
  legacyProof(before, seed); catalogProof(fixture); await ownedFilesProof(fixture); if (handleFacts().active !== 0) reject(); return seed;
}
export function catalogProof(fixture) {
  return database(join(fixture.root, 'private-data/catalog.sqlite3'), true, db => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) reject();
    equal(rows(db, 'SELECT session_id,relative_path,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,schema_version,availability,fault_code FROM sessions WHERE session_id=?'.replace('?', `'${missing}'`)),
      [[missing,`sessions/ab/${missing}/session.sqlite3`,'Independent fixture: Ω','"/synthetic/nonexistent-workspace"',100,101,1,1,'missing','storage.not_found']]); return true;
  });
}
const cursor = (prefix, data) => `${prefix}.${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
export const previous = cursor('g11b', [1,sid,'12']);
const optional = value => value === null ? '0' : `1${value.toString(16).padStart(16, '0')}`;
function field(run, entry, kind, text, generation, output, rank, group, content) {
  const source = `${optional(output)}:${rank}:0:${optional(content)}`;
  const order = `${optional(output)}:${group.toString(16).padStart(16,'0')}:0:${optional(content)}:${rank.toString(16).padStart(16,'0')}`;
  const id = digest(JSON.stringify([1,'wi.conversation.field',run,entry,source])), size = String(Buffer.byteLength(text));
  return { field_id: id, order_key: order, kind, generation: String(generation), total_bytes: size, from_byte: '0', to_byte: size, text, has_earlier: false, has_later: false };
}
export function expectedPage(index, latest = index === 1) {
  const fact = facts[index], n = fact.accepted;
  const entry = (offset, kind, revision, epoch, fields, tool = false) => ({ run_id: fact.run, entry_id: `e:${n+offset}:0`, position: { sequence: String(n+offset), slot: '0' },
    revision: String(n+revision), content_epoch: String(n+epoch), kind, recorded_state: tool && fact.is_error ? 'failed' : kind === 'human' ? 'accepted' : 'completed',
    provisional: false, reference: null, result_recorded: tool ? true : null, finish_recorded: tool ? true : null, is_error: tool ? fact.is_error : null,
    fields, earlier_content: null, content_complete: true });
  const bytes = String(Buffer.byteLength(fact.user));
  const human = entry(0,'human',0,0,[{ field_id: 'text', order_key: '0', kind: 'text', generation: String(n), total_bytes: bytes, from_byte: '0', to_byte: bytes,
    text: fact.user, has_earlier: false, has_later: false }]);
  const assistant = entry(3,'assistant',3,3,[field(fact.run,`e:${n+3}:0`,'text',fact.text,n+3,0,2,1,0)]);
  const tool = entry(4,'tool',6,4,[field(fact.run,`e:${n+4}:0`,'tool_name','synthetic',n+4,null,5,4,null),
    field(fact.run,`e:${n+4}:0`,'tool_result',fact.tool,n+5,null,6,5,null)],true);
  return { api_version: 1, conversation_version: 1, session_id: sid, snapshot_head: head,
    session: { api_version: 1, session_id: sid, title, workspace: null, created_at_ms: '42', updated_at_ms: '42', head_sequence: head, view: 'canonical' },
    block: { run_id: fact.run, accepted_sequence: String(n), revision: String(n+9), state: 'completed', result_recorded: true, outcome: { type: 'completed' },
      summary: { turns_started: '0', turns_finished: '0', model_requests_attempted: '0', model_requests_admitted: '0', new_tool_dispatches: '0', tool_results_prepared: '0',
        reused_results: '0', last_request_id: null, last_upstream_outcome: null }, events_complete: true, sink_error: null, human }, entries: [assistant,tool], earlier_activity: null,
    previous_block: index === 1 ? previous : null, live_after: latest ? cursor('g11l',[1,sid,head,'3','','']) : null };
}
export function pageProof(value, index, latest = index === 1) {
  const query = latest ? { kind: 'latest' } : { kind: 'before', cursor: previous };
  validateConversationPage(value, query, sid); equal(value, expectedPage(index, latest)); return value;
}
export function entryProof(value, index, entry) {
  const page = expectedPage(index);
  validateEntryPage(value, { session_id: sid, run_id: page.block.run_id, entry_id: entry.entry_id });
  equal(value, { api_version: 1, conversation_version: 1, session_id: sid, snapshot_head: head, block: page.block, entry }); return value;
}
export function domProof(value, index) { return equal(value, expectedBlock(expectedPage(index))); }
export function sameDom(value, held) { if (typeof value !== 'string' || !value.length) reject(); return equal(value, held); }
export function newRecord() { return { requests: [], snapshots: [], streams: [], older: [], assets: new Set(), events: [], newest: false, intent: false, prekey: null, setup_reads: null }; }
export function newFaults() { return { external: 0, request: 0, response: 0, console: 0, page: 0, private: 0, collector: 0 }; }
export function requestAllowed(method, url) {
  if (method !== 'GET') return false;
  if (url.pathname === '/v1/settings') return url.search === '';
  if (url.pathname === '/v1/sessions') return url.search === '?limit=32';
  const base = `/v1/sessions/${sid}/conversation`;
  return url.pathname === base && (url.search === '' || url.search === `?before=${encodeURIComponent(previous)}`)
    || url.pathname === `${base}/events` && url.search === `?after=${encodeURIComponent(expectedPage(1).live_after)}`;
}
export function collector({ origin, owner, record, faults, assetReads }) {
  return {
    async route(route) { try { if (new URL(route.request().url()).origin !== origin) { faults.external++; await route.abort(); } else await route.continue(); } catch { faults.collector++; } },
    request(request) {
      try {
        const url = new URL(request.url()), method = request.method(); record.requests.push({ method, path: url.pathname, search: url.search });
        if (url.origin !== origin) faults.external++; if (leaked(request.url(),owner)) faults.private++;
        if (url.pathname.startsWith('/v1/')) {
          const h = request.headers(); if (!requestAllowed(method,url) || h.authorization !== `Bearer ${owner}` || h.cookie !== undefined || h.origin !== undefined && h.origin !== origin) faults.request++;
        } else if (method !== 'GET' || !files.has(url.pathname) || url.search) faults.request++;
        const base = `/v1/sessions/${sid}/conversation`;
        if (url.pathname === base && !url.search) { record.snapshots.push({ request, index: record.requests.length-1, response: null }); record.events.push('latest'); }
        if (url.pathname === `${base}/events`) { record.streams.push({ request, index: record.requests.length-1, response: record.snapshots.at(-1)?.response, reply: null }); record.events.push('stream'); }
        if (url.pathname === base && url.search) {
          if (!record.newest || !record.intent || record.older.length || url.search !== `?before=${encodeURIComponent(previous)}`) faults.request++;
          record.older.push({ request, index: record.requests.length-1, response: null }); record.events.push('older-request');
        }
      } catch { faults.collector++; }
    },
    response(response) {
      try {
        const url = new URL(response.url());
        for (const list of [record.snapshots,record.older]) { const item = list.find(s=>s.request===response.request()); if (item) { item.response=response; responseHeaders(response,'application/json'); } }
        const stream = record.streams.find(s=>s.request===response.request()); if (stream) { stream.reply=response; responseHeaders(response,'text/event-stream'); }
        if (response.status() >= 300) faults.response++;
        const file = files.get(url.pathname); if (!file) return;
        assetReads.push((async()=>{responseHeaders(response,file[1]);const bytes=await response.body();if(!bytes.equals(await readFile(join(ROOT,'web',file[0]))))faults.response++;
          if(leaked(bytes.toString('utf8'),owner))faults.private++;record.assets.add(url.pathname);})().catch(()=>{faults.collector++;}));
      } catch { faults.collector++; }
    },
  };
}
const connectPhases = ['latest_response','token_fill','connect_click','token_cleared','streaming_status','sse_200'];
const diagnosticValue = (read, valid) => { try { const value=read(); return valid(value)?value:'unavailable'; } catch { return 'unavailable'; } };
const diagnosticCount = read => diagnosticValue(read,n=>Number.isSafeInteger(n)&&n>=0);
function responseFacts(read, key) {
  const item=diagnosticValue(read,v=>v===undefined||v!==null&&typeof v==='object');
  if(item==='unavailable')return Object.freeze({request:'unavailable',response:'unavailable',identity_match:'unavailable',status:'unavailable',media:'unavailable'});
  const request=diagnosticValue(()=>item?.request,v=>v===undefined||v===null||typeof v==='object'||typeof v==='function');
  const reply=diagnosticValue(()=>item?.[key],v=>v===undefined||v===null||typeof v==='object'||typeof v==='function');
  const present=v=>v==='unavailable'?'unavailable':v!==undefined&&v!==null;
  const identity=present(request)===true&&present(reply)===true ? diagnosticValue(()=>reply.request()===request,v=>typeof v==='boolean') : 'unavailable';
  const status=identity===true ? diagnosticValue(()=>reply.status(),n=>Number.isInteger(n)&&n>=100&&n<=599) : 'unavailable';
  let media='unavailable';
  if(identity===true)media=diagnosticValue(()=>{
    const type=reply.headers()['content-type'];
    if(type===undefined||type===null||type==='')return 'missing';
    if(typeof type!=='string')return 'unavailable';
    if(/^application\/json(?:\s*;|\s*$)/i.test(type))return 'json';
    if(/^text\/event-stream(?:\s*;|\s*$)/i.test(type))return 'sse';
    return 'other';
  },v=>['json','sse','missing','other','unavailable'].includes(v));
  return Object.freeze({request:present(request),response:present(reply),identity_match:identity,status,media});
}
export function connectDiagnostics(index, record, faults) {
  const iteration=[0,1].includes(index)?index:'unavailable', stage=['upgrade','reopen'][iteration]??'unavailable';
  const states=Object.fromEntries(connectPhases.map(phase=>[phase,'not_started']));
  let first=null,packet=null;
  return {
    async operation(phase, action) {
      if(!connectPhases.includes(phase)||states[phase]!=='not_started')reject();
      states[phase]='pending';
      try { const value=await action();states[phase]='resolved';return value; }
      catch(error) {
        states[phase]='failed';
        if(first===null) {
          // Copy at the rejection, before a sibling or cleanup can change the facts.
          first=phase;
          packet={iteration,stage,first_phase:first,diagnostic:'unavailable'};
          try {
            packet=Object.freeze({iteration,stage,first_phase:first,phases:Object.freeze({...states}),
              counts:Object.freeze(Object.fromEntries(['requests','snapshots','streams','older'].map(k=>[k,diagnosticCount(()=>record[k].length)]))),
              latest:responseFacts(()=>record.snapshots[0],'response'),sse:responseFacts(()=>record.streams[0],'reply'),
              faults:Object.freeze(Object.fromEntries(['external','request','response','console','page','private','collector'].map(k=>[k,diagnosticCount(()=>faults[k])])))});
          } catch {}
        }
        throw error;
      }
    },
    emit(log=console.log, serialize=JSON.stringify) {
      if(packet===null)return;
      try { log(`Upgrade parity Connect diagnostic: ${serialize(packet)}`); }
      catch { try { log('Upgrade parity Connect diagnostic: unavailable'); } catch {} }
    },
  };
}
export function reportUpgradeFailure(error, stage, check, diagnostic, log=console.log) {
  try { diagnostic?.emit(log); } catch {}
  const safeStage=['binding','seed','upgrade','reopen','cleanup'].includes(stage)?stage:'unavailable';
  const safeCheck=['binding','legacy','pre-spawn','fresh','connect','original-b','upgraded','independent-dto','overflow','setup','upward','older','privacy','close','stop','final'].includes(check)?check:'unavailable';
  const timeout=diagnosticValue(()=>typeof error?.message==='string'&&/Timeout|timed out/.test(error.message),v=>typeof v==='boolean');
  try { log(`Upgrade parity failure: ${JSON.stringify({stage:safeStage,check:safeCheck,timeout})}`); } catch {}
  return new Error(`Upgrade parity failed: ${safeStage}/${safeCheck}`);
}
function original(record, reply) {
  if (record.snapshots.length !== 1 || record.streams.length !== 1) reject();
  const s=record.snapshots[0],t=record.streams[0];
  if (s.request!==reply.request() || s.response!==reply || t.response!==reply || s.index>=t.index || !t.reply || t.reply.request()!==t.request || s.request===t.request) reject();
  responseHeaders(reply,'application/json'); responseHeaders(t.reply,'text/event-stream');
}
export function observationOrder() {
  let selected=false,recovered=false,bound=false,finished=false;
  return {
    selected() { if(selected)reject();selected=true; },
    displayed(record,reply) { if(!selected||recovered||record.older.length)reject();original(record,reply);recovered=true; },
    async read(action) { if(!recovered||finished)reject();return action(); },
    handshake(record,reply,value,origin) { if(!recovered||bound)reject();handshakeProof({origin,sid,head,value,snapshots:record.snapshots,streams:record.streams,reply});bound=true; },
    finish(record) { if(!bound||finished)reject();requestProof(record);finished=true;return [...record.events]; },
  };
}
export function requestProof(record) {
  equal(record.events,['latest','stream','newest-rendered','upward-intent','older-request','older-rendered']);
  if(record.snapshots.length!==1||record.streams.length!==1||record.older.length!==1||record.requests.some(r=>r.method!=='GET')||record.assets.size!==files.size
    || ![...files.keys()].every(p=>record.assets.has(p)) || record.setup_reads!==0 || !record.prekey?.focused || record.prekey.top<0 || record.prekey.top>96
    || !Number.isFinite(record.prekey.top) || !(record.prekey.height>record.prekey.viewport))reject();
  return true;
}
export function observerWork(samples) {
  if(!Array.isArray(samples)||samples.length<4||samples[0].event!=='sample'||samples.at(-1).event!=='stopped')reject();
  for(const sample of samples)workProof(sample.work,'observe');return true;
}
export function cleanupProof({closed,rootRemoved,processes,handles: h}) {
  equal(closed,[true,true]);if(!rootRemoved||processes.length!==2||h.active!==0||h.opens!==h.closes||h.opens<2)reject();
  if(processes[0].pid===processes[1].pid)reject();
  for(const p of processes){if(p.phase!=='observe'||!p.identity?.start_ticks||p.identity.executable!==processes[0].identity.executable)reject();terminalProof(p,false);observerWork(p.samples);}return true;
}
export async function removeUpgradeRoot(fixture, processes, closed) {
  cleanupProof({closed,rootRemoved:true,processes:processes.map(p=>p.evidence()),handles:handleFacts()});
  await rootProof(fixture,'observe');
  for(const p of processes){const current=await processIdentity(p.pid);if(current&&current.start_ticks===p.evidence().identity.start_ticks)reject();}
  await rm(fixture.root,{recursive:true});
  try{await lstat(fixture.root);}catch(error){if(error.code==='ENOENT')return true;}reject();
}
