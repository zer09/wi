import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { preparationRedactor, sanitizeRecord } from './browser-fixture-preparation.mjs';

export const reportName = 'case-observations.v1.json';
export const annotationType = 'wi-case-observation-v1';
export const sourceFiles = Object.freeze([
  'cancellation', 'catalog-pagination', 'client-close-handoff', 'content-measurements', 'create-recovery',
  'display-app', 'display-measurements', 'display-view', 'interrupted-display-parity', 'joined', 'lifecycle-failure',
  'live-commit-measurements', 'presentation', 'rename-recovery', 'restart-display', 'rich-display-parity',
  'saved-history-active-rename', 'skill-source-fidelity', 'task-acceptance-unknown', 'task-acceptance-warning',
  'task-account-mismatch', 'task-active-conflict', 'task-disconnect-epoch', 'task-fixed-head', 'task-incomplete-history',
  'task-input-framing', 'task-input-rejection', 'task-recovery', 'task-reload-epoch', 'task-selection-epoch',
  'task-stale-history', 'task-unbound-history', 'tool-fidelity', 'upgrade-display-parity',
].map(name => `web/e2e/${name}.spec.mjs`));
export const joinedScenarios = Object.freeze(['WS native', 'WS recovered', 'provider-SSE labelled native',
  'provider-SSE labelled recovered', 'provider-SSE missing-MIME native', 'provider-SSE missing-MIME recovered']);
export const livePhases = Object.freeze(['output', 'binding', 'allocation', 'allocation_cleanup', 'root', 'native', 'server', 'identity', 'browser', 'context', 'page', 'goto', 'fresh', 'connect',
  'handshake', 'task', 'first', 'first_dom', 'browser_arm', 'native_arm', 'second', 'pages', 'append_dom', 'authority', 'authority_dom', 'terminal',
  'terminal_dom', 'complete', 'observer_finish', 'privacy', 'body_proof', 'cleanup', 'publication',
  'root_cleanup', 'native_stop', 'native_abandon', 'native_retirement', 'browser_discovery', 'server_close', 'browser_emergency', 'browser_retirement', 'browser_close', 'context_close', 'collector_drain',
  'collector_route', 'collector_request', 'collector_response', 'collector_finished', 'collector_failed', 'collector_asset', 'native_failed_frame', 'native_node_failure']);
export const contentPhases = Object.freeze(['fresh_goto','fresh_token_empty','fresh_task_empty','fresh_rows_empty','fresh_boundary',
  'token_fill','connect_click','token_cleared','latest_sse_ready','session_title','streaming_status','run_count','run_identity','partial_dom_poll',
  'initial_settled','initial_dom','geometry_read','viewport_filled','initial_snapshot','initial_projection','initial_catalog','initial_files','initial_sample',
  'no_content','no_setup_content','no_other_older','content_cursor','content_arm','content_click','content_ready','prepend_dom_poll','prepend_settled',
  'prepend_dom','retained_settled','retained_dom','retained_projection','retained_catalog','content_sample','content_discovery',
  'privacy_boundary','commands_empty','task_empty','content_drain','content_proof','zero_faults','outside_path']);
export const cleanupSteps = Object.freeze(['browser-final-discovery', 'context-close', 'browser-connection-close', 'browser-server-close',
  'browser-emergency', 'browser-retirement', 'collector-drain', 'native-stop', 'native-abandon', 'native-emergency', 'native-retirement', 'root', 'allocation-parent', 'final-collector']);
export const kinds = Object.freeze(['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'ProtocolError', 'other']);
export const matchers = Object.freeze(['toBe', 'toEqual', 'toHaveCount', 'toHaveText', 'toContainText', 'toHaveValue', 'toBeVisible', 'toBeEnabled', 'action or control']);
export const bodyClasses = Object.freeze(['method_get_response_body', 'target_closed', 'target_crashed', 'timeout', 'other', 'get_response_body_no_resource',
  'get_response_body_no_data', 'get_response_body_evicted', 'method_load_network_resource', 'method_io_read', 'method_io_close', 'collected', 'redirect_body_unavailable']);
// IDs are versioned with source_map 2. These are stored labels, not assertion attribution.
export const families = Object.freeze([
  { source: 9, prefix: 'Interrupted parity failed:', stages: ['binding','produce','connect-a','create','task','partial','close-a','kill','observe','connect-observer','parity','close-observers','drain','cleanup'], checks: ['identity','reply','work','fields','handshake','privacy','assets','requests','cleanup'] },
  { source: 13, prefix: 'Presentation failed:', stages: ['startup','connect','create','rename','catalog','keyboard','acceptance','partial','items','tools','final-deltas','final-item','disconnect-reader','completion','rebase','older','abort','navigation-seed','navigation-selected','navigation','cleanup'],
    checks: ['outside','reply','reply-response','reply-status','reply-body','reply-size','reply-utf8','reply-decode','status','identity','execution','headings','fields','metadata','ids','occurrences','receipt','native','focus','disclosure','scroll','geometry','scroll-position','relative-anchor','aria','layout','privacy','assets','requests','parity','measurement'] },
  { source: 24, prefix: 'Fixed head failed:', stages: ['startup','initial','interleaved','attach','tool','provisional','terminal','stable','disconnect'], checks: ['outside','native','b-snapshot','a-snapshot','rename','task','held','parity','producer','bytes','final','quiet','assets','clear'] },
  { source: 30, prefix: 'Selection epoch failed:', stages: ['startup','two UI creations in distinct configured workspaces','refresh list and open A','native accepted response held while A runs at model gate one','actual session-list switch retires A display','release the same real A response after B is fully selected','actual A receipt remains global and B stays unchanged','A tool gate one','A provisional gate two','A terminal gate three','A completed provider audit','A completed task audit','reopen A through UI with completed supplied display','B reopened through Latest and display SSE remains head one','Disconnect clears memory and DOM without cancellation'], checks: [] },
  { source: 3, prefix: 'Client handoff failed:', stages: ['startup','create','first-send','close-a','observer-connect','first-completion','later-explicit-send','reopened-a'], checks: ['outside','receipt','native','dto','handshake','order','assets','requests'] },
  { source: 10, prefix: 'Joined browser assertion failed:', stages: ['startup','public embedded assets and connection','real creation receipt and canonical header','create session submission','open canonical receipt session','fixture selects browser-created session','initial empty conversation view','initial fixture inspection','initial observation and display read order','Enter is a newline, not a task',
    ...[1,2].flatMap(n => ['before-commit acceptance','durable receipt before model reply','real AddNumbers and correlated continuation','release final provider reply','SQLite final data','final supplied display state','execution and result-recorded view','exact authoritative answer and tool output','actual recorded outcome and result summary'].map(s => `task ${n} ${s}`)),
    'stored-history proof and read-only reload/navigation','Disconnect clears DOM without cancellation or model work'], checks: [] },
  { source: 11, prefix: 'Lifecycle failure failed:', stages: ['startup','connect and fresh selection','one explicit submission','distinct final append pause','read-only latest display rebase','disconnect and privacy', ...[1,2,3,4].flatMap(n => [`checkpoint ${n} display`,`checkpoint ${n} read-only reconcile`])],
    checks: ['outside','status','run-count','run-identity','execution','headings','entry-ids-read','entry-ids','entry-metadata','entry-fields','tool-open','tool-click','tool-visible','tool-output','task-occurrences','argument-occurrences','output-occurrences','partial-occurrences','request-id-read','request-id','recording','storage-error-absent','reconcile-action','reconcile-reply','reconcile-acceptance','reconcile-run','run-view','task-state','task-body','task-receipt','privacy','parity-dom'] },
  { source: 29, prefix: 'Reload epoch failed:', stages: ['startup','UI creation and matching head-one display observation','actual Task202 accepted before full reload at provider gate one','actual full reload retires the accepted first document','disconnected second document stays API-idle through real tools and final durable recording','token entry alone cannot authorize retained-hash reads','explicit Connect reads retained A exactly once without command recovery or resubmission','unchanged durable task audit after explicit Connect'], checks: [] },
  { source: 33, prefix: 'Tool fidelity failed:', stages: ['startup','connect and create','first explicit submission','second explicit submission','first committed results privacy','second committed result privacy','first reuse privacy','first closed audit','second closed audit','first supplied display and DOM','second supplied display and DOM','stable results and public assets','disconnect and privacy'], checks: [] },
  { source: 16, prefix: 'Rich parity failed:', stages: ['startup','connect','create','task','partial','fresh','parity','close-b','drain','cleanup'], checks: ['outside','reply','identity','native','fields','handshake','privacy','assets','requests','cleanup'] },
  { source: 18, prefix: 'Skill fidelity failed:', stages: ['startup','create','task-1','task-2','fixed-boundary','change-source','delete-source','changed-observer','deleted-observer'], checks: ['outside','fill-task','accepted-response','accepted-dto','paused-1','paused-2','paused-3','paused-4','paused-5','paused-6','paused-7','paused-8','paused-9','paused-10','paused-11','paused-12','drive-1','drive-2','drive-3','drive-4','drive-5','drive-6','drive-7','drive-8','drive-9','drive-10','drive-11','drive-12','finished-1','finished-2','gate11-diagnostic','provider-finished','native','complete-dto','complete-dom','ownership','handshake','newest-dom','setup-top','transcript-focus','layout-settled','pre-key-sample','pre-key-focus','pre-key-geometry','setup-reads','key-dispatch','older-request-wait','older-request-route','older-request-cursor','older-dto','older-dom','privacy','native-unchanged','assets'] },
  { source: 31, prefix: 'Stale history failed:', stages: ['startup','real browser creation and selection','one explicit Send paused after replay-head capture','one real browser rename commits before task release','release and exact stale-history rejection','draft edit preserves immutable rejected command and truthful rename','embedded asset integrity and Disconnect clearing'], checks: [] },
  { source: 21, prefix: 'Account mismatch failed:', stages: ['startup','real browser creation and selection','first normal acceptance and real tool completion','one-shot private rotation after audited completion','finite no-auto-action interval and stable canonical failure','Disconnect clears without cancel or retry'], checks: [] },
].map(f => Object.freeze({ ...f, stages: Object.freeze(f.stages), checks: Object.freeze(f.checks) })));
const labels = ['short-selected', 'long-selected', 'disconnected-reader'];
const testStatuses = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'];
const runStatuses = ['passed', 'failed', 'timedout', 'interrupted'];
const reasons = ['unknown_source', 'unknown_scenario', 'unsupported_error', 'malformed_error', 'missing_annotation', 'malformed_annotation', 'duplicate_annotation', 'callback_unavailable', 'privacy_collision'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000;
const positive = n => integer(n) && n > 0;
const bounded = n => integer(n) ? n : null;
const bool = n => typeof n === 'boolean' ? n : null;
const id = (table, value) => table.includes(value) ? table.indexOf(value) + 1 : null;
const label = (table, value) => positive(value) && value <= table.length ? table[value - 1] : null;
const reject = (reason = 'schema_unavailable') => { const error = Error('Case observation unavailable'); error.code = reason; throw error; };
function clean(value, redact) { if (!isDeepStrictEqual(sanitizeRecord(value, redact), value)) reject('privacy_collision'); return value; }
function source(file) { return sourceFiles.find(name => file === name || file === join(ROOT, name) || file === pathToFileURL(join(ROOT, name)).href) ?? null; }
function location(value, expected) {
  if (expected === null || !value || source(value.file) !== expected || !positive(value.line) || !positive(value.column)) return null;
  return [value.line, value.column];
}
function replyClasses(message, family) {
  const start = message.indexOf('; capture='), end = message.indexOf(family === 4 ? '; delay=' : '; disconnectedView=', start);
  if (start < 0 || end < 0) return null;
  const capture = JSON.parse(message.slice(start + 10, end));
  const rows = family === 4 ? [...(Array.isArray(capture.creates) ? capture.creates : []), capture.task, ...(Array.isArray(capture.latest) ? capture.latest : [])]
    : [capture.create, capture.task, ...(Array.isArray(capture.latest) ? capture.latest : [])];
  const known = [...new Set(rows.map(row => row?.body_rejection_class).filter(v => bodyClasses.includes(v)))];
  return known.length ? known : null;
}
export function storedObservation(file, message) {
  const index = families.findIndex(f => sourceFiles[f.source - 1] === file);
  if (index < 0 || typeof message !== 'string' || message.length > 1_000_000) return null;
  const f = families[index], family = index + 1;
  if (!message.startsWith(f.prefix + ' ')) return null;
  const text = message.slice(f.prefix.length + 1);
  let m, stage, check = null, kind = null, matcher = null, stored_line = null, presentation = null, entry = null;
  if ([1,5,10,11].includes(family)) { m = /^stage=([^;\r\n]+); check=([^;\r\n]+)$/.exec(text); if (!m) return null; [,stage,check] = m; }
  else if (family === 2) { m = /^label=([^;\r\n]+); stage=([^;\r\n]+); check=([^;\r\n]+); kind=([^;\r\n]+)$/.exec(text); if (!m) return null; [,presentation,stage,check,kind] = m; }
  else if (family === 3) { m = /^([^;\r\n]+); kind=([^;\r\n]+); check=([^;\r\n]+); capture=/.exec(text); if (!m) return null; [,stage,kind,check] = m; }
  else if (family === 4) { m = /^([^;\r\n]+); kind=([^;\r\n]+) line=([1-9][0-9]{0,6}|none); capture=/.exec(text); if (!m) return null; [,stage,kind] = m; stored_line = positive(Number(m[3])) ? Number(m[3]) : null; }
  else if (family === 6) { m = /^([^;\r\n]+); ([^;\r\n]+); line=([1-9][0-9]{0,6}|unknown)$/.exec(text); if (!m) return null; [,stage,matcher] = m; stored_line = positive(Number(m[3])) ? Number(m[3]) : null; }
  else if (family === 7) { m = /^([^;\r\n]+); kind=([^;\r\n]+); check=([^;\r\n]+); entry=(none|other|[0-3]); capture=/.exec(text); if (!m) return null; [,stage,kind,check] = m; entry = /^[0-3]$/.test(m[4]) ? Number(m[4]) : null; }
  else if (family === 8) { m = /^([^;\r\n]+); capture=/.exec(text); if (!m) return null; stage = m[1]; }
  else if ([12,13].includes(family)) { m = /^([^;\r\n]+); kind=([^;\r\n]+) line=([1-9][0-9]{0,6}|none); capture=/.exec(text); if (!m) return null; [,stage,kind] = m; stored_line = positive(Number(m[3])) ? Number(m[3]) : null; }
  else { m = /^([^;\r\n]+); kind=([^;\r\n]+); faults=/.exec(text); if (!m) return null; [,stage,kind] = m; }
  const value = { family, stage: f.stages.includes(stage) ? stage : null, check: f.checks.includes(check) ? check : null,
    kind: kinds.includes(kind) ? kind : null, matcher: matchers.includes(matcher) ? matcher : null, stored_line,
    presentation: labels.includes(presentation) ? presentation : null, entry, body_classes: null };
  if ([4,8].includes(family)) { try { value.body_classes = replyClasses(message, family); } catch {} }
  return value;
}
function encodeStored(s) { if (s === null) return null; const f = families[s.family - 1]; return [s.family, id(f.stages,s.stage), id(f.checks,s.check), id(kinds,s.kind), id(matchers,s.matcher), s.stored_line, id(labels,s.presentation), s.entry, s.body_classes === null ? null : s.body_classes.map(v => id(bodyClasses,v))]; }
function decodeStored(s) {
  if (s === null) return null;
  if (!Array.isArray(s) || s.length !== 9 || !label(families,s[0])) reject();
  const f = families[s[0]-1];
  const decode = (table, n) => { if (n === null) return null; const v = label(table,n); if (v === null) reject(); return v; };
  if (s[5] !== null && !positive(s[5]) || s[7] !== null && (!integer(s[7]) || s[7] > 3) || s[8] !== null && (!Array.isArray(s[8]) || s[8].length > bodyClasses.length)) reject();
  return {family:s[0],stage:decode(f.stages,s[1]),check:decode(f.checks,s[2]),kind:decode(kinds,s[3]),matcher:decode(matchers,s[4]),stored_line:s[5],presentation:decode(labels,s[6]),entry:s[7],body_classes:s[8] === null ? null : s[8].map(n=>decode(bodyClasses,n))};
}
function encodeMeasurement(m) { return m === null ? null : [m.family, id(m.family === 1 ? livePhases : contentPhases,m.checkpoint), m.body_success, m.cleanup, id(cleanupSteps,m.failed_cleanup_step)]; }
function decodeMeasurement(m) {
  if (m === null) return null;
  if (!Array.isArray(m) || m.length !== 5 || ![1,2].includes(m[0])) reject();
  const table = m[0] === 1 ? livePhases : contentPhases;
  if (m[1] !== null && !label(table,m[1]) || m[4] !== null && !label(cleanupSteps,m[4]) || m.slice(2,4).some(v => v !== null && typeof v !== 'boolean')) reject();
  return {family:m[0],checkpoint:label(table,m[1]),body_success:m[2],cleanup:m[3],failed_cleanup_step:label(cleanupSteps,m[4])};
}
// The thunk keeps argument extraction and TestInfo access inside the same non-fatal boundary.
export function appendMeasurementAnnotation(read) {
  try {
    const { info, family, packet, body_success, cleanup, steps } = read();
    if (![1,2].includes(family)) return;
    const operation = packet?.first_operation, table = family === 1 ? livePhases : contentPhases;
    let failed = null;
    if (Array.isArray(steps)) for (const step of steps) if (step.ok === false) { failed = step.name; break; }
    const m = {family,checkpoint:table.includes(operation) ? operation : null,body_success:bool(body_success),cleanup:bool(cleanup),failed_cleanup_step:cleanupSteps.includes(failed) ? failed : null};
    const redact = preparationRedactor(process.env);
    let description;
    try {
      clean(m,redact);
      description = JSON.stringify([1,...encodeMeasurement(m)]);
      clean({type:annotationType,description},redact);
    } catch (error) {
      if (error.code !== 'privacy_collision') return;
      // Workers must carry the rejection, not silently turn it into missing facts.
      description = JSON.stringify([1,0]);
      clean({type:annotationType,description},redact);
    }
    info.annotations.push({type:annotationType,description});
  } catch { /* Diagnostics must not replace the original body or cleanup error. */ }
}
function measurement(annotations, file, protect, collision) {
  if (!Array.isArray(annotations)) return {value:null,reason:'missing_annotation'};
  let count = 0, value = null, malformed = false;
  for (const a of annotations) {
    try {
      if (a.type !== annotationType) continue;
      count++;
      const description = a.description;
      if (typeof description !== 'string' || description.length > 256) reject();
      const tuple = JSON.parse(description);
      // Latch before duplicate, malformed-companion or case-retention omission.
      if (Array.isArray(tuple) && tuple.length === 2 && tuple[0] === 1 && tuple[1] === 0) { collision(); continue; }
      if (!Array.isArray(tuple) || tuple.length !== 6 || tuple[0] !== 1) reject();
      const decoded = decodeMeasurement(tuple.slice(1));
      // Even duplicate or wrong-source annotations must pass privacy before omission.
      protect(decoded);
      if (file !== sourceFiles[decoded.family === 1 ? 11 : 3]) reject();
      value = decoded;
    } catch { malformed = true; }
  }
  if (count === 0) return {value:null,reason:'missing_annotation'};
  if (count > 1) return {value:null,reason:'duplicate_annotation'};
  return malformed ? {value:null,reason:'malformed_annotation'} : {value,reason:null};
}
export function encodeReport(report, redact = preparationRedactor(process.env)) {
  clean(report,redact);
  const encoded = {version:1,source_map:2,completion:report.completion === 'complete' ? 1 : 2,run:id(runStatuses,report.run),counts:[...report.counts],
    cases:report.cases.map(c => [id(sourceFiles,c.file),...c.declaration,id(joinedScenarios,c.scenario),c.begin,c.end,c.result,id(testStatuses,c.status),c.worker,c.duration,c.error_count,
      c.errors.map(e => [e.ordinal,e.location===null?null:[...e.location],encodeStored(e.stored),id(reasons,e.reason)]),encodeMeasurement(c.measurement),id(reasons,c.reason)]),omitted:[...report.omitted]};
  clean(encoded,redact); return encoded;
}
// Reconstruct every allowlisted label before privacy checking or public byte omission.
function collisionRecord(encoded, redact) {
  if (encoded && Object.keys(encoded).sort().join() === 'source_map,unavailable,version' && encoded.version === 1 && encoded.source_map === 2 && encoded.unavailable === id(reasons,'privacy_collision')) {
    clean({version:1,source_map:2,unavailable:'privacy_collision'},redact);clean(encoded,redact);return true;
  }
  return false;
}
export function decodeReport(encoded, redact = preparationRedactor(process.env)) {
  if (collisionRecord(encoded,redact)) reject('privacy_collision');
  const keys = ['version','source_map','completion','run','counts','cases','omitted'];
  if (!encoded || Object.keys(encoded).sort().join() !== keys.sort().join() || encoded.version !== 1 || encoded.source_map !== 2 || ![1,2].includes(encoded.completion)
    || encoded.run !== null && !label(runStatuses,encoded.run) || !Array.isArray(encoded.counts) || encoded.counts.length !== 10 || encoded.counts.some(n=>n!==null&&!integer(n))
    || encoded.counts.slice(1).some(n=>n===null) || !Array.isArray(encoded.cases) || encoded.cases.length > 256 || !Array.isArray(encoded.omitted) || encoded.omitted.length !== 2 || encoded.omitted.some(n=>!integer(n))) reject();
  const nullable = (table,n) => { if (n === null) return null; const v=label(table,n);if(v===null)reject();return v; };
  const coordinate = v => { if(v!==null&&(!Array.isArray(v)||v.length!==2||v.some(n=>!positive(n))))reject();return v; };
  const ends = new Set(), begins = new Set(), identities = new Set();
  const cases=encoded.cases.map(c=>{
    if(!Array.isArray(c)||c.length!==14||c.slice(4,7).some(n=>n!==null&&!positive(n))||c.slice(8,11).some(n=>n!==null&&!integer(n))||!Array.isArray(c[11])||c[11].length>8)reject();
    if(c[11].length!==(c[10]===null?0:Math.min(c[10],8)))reject();
    coordinate(c.slice(1,3).every(v=>v===null)?null:c.slice(1,3));
    if(c[5]===null||c[6]===null||c[5]>encoded.counts[2]||c[6]>encoded.counts[2]||ends.has(c[5])||c[4]!==null&&(c[4]>encoded.counts[1]||begins.has(c[4])))reject();
    ends.add(c[5]);if(c[4]!==null)begins.add(c[4]);
    const identity=JSON.stringify([c[0],c[1],c[2],c[3],c[6]]);
    // Unknown scenarios and duplicate source declarations cannot establish identity.
    if(c[0]!==null&&c[3]!==null&&identities.has(identity))reject();identities.add(identity);
    const file=nullable(sourceFiles,c[0]),scenario=nullable(joinedScenarios,c[3]);if(scenario!==null&&file!==sourceFiles[9])reject();
    const errors=c[11].map((e,i)=>{if(!Array.isArray(e)||e.length!==4||e[0]!==i+1||c[10]===null||e[0]>c[10])reject();const stored=decodeStored(e[2]);if(stored&&families[stored.family-1].source!==c[0])reject();return {ordinal:e[0],location:coordinate(e[1]),stored,reason:nullable(reasons,e[3])};});
    const m=decodeMeasurement(c[12]);if(m&&file!==sourceFiles[m.family===1?11:3])reject();
    return {file,declaration:c.slice(1,3),scenario,begin:c[4],end:c[5],result:c[6],status:nullable(testStatuses,c[7]),worker:c[8],duration:c[9],error_count:c[10],errors,measurement:m,reason:nullable(reasons,c[13])};
  });
  // Missing cases can add omitted errors, but cannot erase known retained-case overflow.
  const knownOverflow=cases.reduce((n,c)=>n+(c.error_count===null?0:Math.max(c.error_count-8,0)),0);
  if(encoded.omitted[1]<knownOverflow||encoded.omitted[0]===0&&encoded.omitted[1]!==knownOverflow)reject();
  if(encoded.cases.length+encoded.omitted[0]!==encoded.counts[2]||encoded.counts.slice(4).reduce((a,b)=>a+b,0)>encoded.counts[2]
    ||encoded.completion===1&&(encoded.counts[0]!==encoded.counts[1]||encoded.counts[1]!==encoded.counts[2]||encoded.counts.slice(4).reduce((a,b)=>a+b,0)!==encoded.counts[2]))reject();
  const retained=[0,0,0,0,0,0];
  for(const c of cases)retained[c.status===null?5:testStatuses.indexOf(c.status)]++;
  // Missing rows can add to a bin, but cannot erase a retained observation.
  if(retained.some((n,i)=>n>encoded.counts[i+4]||encoded.omitted[0]===0&&n!==encoded.counts[i+4]))reject();
  const report={completion:encoded.completion===1?'complete':'incomplete',run:nullable(runStatuses,encoded.run),counts:[...encoded.counts],cases,omitted:[...encoded.omitted]};
  clean(report,redact);clean(encoded,redact);return report;
}
function witness(c) {
  if(c.measurement?.checkpoint!==null&&c.measurement) return [3,...encodeMeasurement(c.measurement)];
  for(const e of c.errors) {
    if(e.stored&&(e.stored.stage!==null||e.stored.check!==null||e.stored.stored_line!==null)) {
      const stored=encodeStored(e.stored);
      return [2,e.ordinal,...stored.slice(0,6),stored[8]?.[0]??null];
    }
    if(e.location!==null)return [1,e.ordinal,...e.location];
  }
  return null;
}
export function publicSummary(encoded, envelope, redact = preparationRedactor(process.env), limit = 1024) {
  try {
    const report=decodeReport(encoded,redact);clean(envelope,redact);
    const rows=report.cases.filter(c=>c.status!=='passed'&&c.status!=='skipped');
    const summary={version:1,source_map:2,completion:encoded.completion,run:encoded.run,counts:encoded.counts,cases:[],omitted:[encoded.omitted[0]+rows.length,encoded.omitted[1]+rows.reduce((n,c)=>n+c.errors.length,0)]};
    const projection={...envelope,case_observations:summary};
    const size=()=>Buffer.byteLength('browser_suite_launch: failure '+JSON.stringify(projection)+'\n');
    for(const c of rows) {
      const row=[id(sourceFiles,c.file),...c.declaration,id(joinedScenarios,c.scenario),id(testStatuses,c.status),c.begin,c.end,c.result,c.error_count,witness(c)];
      const usedError=Number(row[9]?.[0]!==3&&row[9]!==null);
      summary.cases.push(row);summary.omitted[0]--;summary.omitted[1]-=usedError;
      if(size()>limit) {summary.cases.pop();summary.omitted[0]++;summary.omitted[1]+=usedError;}
    }
    clean(projection,redact);
    return size()<=limit ? {value:projection,reason:null} : {value:null,reason:'byte_limit'};
  } catch (error) {return {value:null,reason:error.code==='privacy_collision'?'privacy_collision':'schema_unavailable'};}
}
async function directory(path, privateMode) {
  const s=await fs.lstat(path);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||await fs.realpath(path)!==path
    ||privateMode&&(s.mode&0o7777)!==0o700||!privateMode&&![0o700,0o755].includes(s.mode&0o7777))reject();
  return [s.dev,s.ino,s.mode,s.uid];
}
export async function writeReport(output, value) {
  if (!collisionRecord(value,preparationRedactor(process.env))) decodeReport(value);
  // Validate the exact bytes now; callers can change their arrays while file operations wait.
  const raw=JSON.stringify(value)+'\n';if(Buffer.byteLength(raw)>1024*1024)reject();
  const stable=JSON.parse(raw);
  if (!collisionRecord(stable,preparationRedactor(process.env))) decodeReport(stable);
  if(typeof output!=='string'||resolve(output)!==output||basename(output)!=='playwright-output')reject();
  const parent=dirname(output), before=await directory(parent,true);
  try {await fs.lstat(output);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(output,{mode:0o755});}
  const outputBefore=await directory(output,false);
  if(!isDeepStrictEqual(before,await directory(parent,true)))reject();
  let handle;
  try {
    handle=await fs.open(join(output,reportName),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o600||stat.nlink!==1)reject();
    await handle.writeFile(raw,'utf8');
    if(!isDeepStrictEqual(outputBefore,await directory(output,false))||!isDeepStrictEqual(before,await directory(parent,true)))reject();
  } finally {await handle?.close();}
}
export default class BrowserCaseDiagnostics {
  constructor() {
    this.tests=new WeakMap();this.results=new WeakMap();this.nextResults=new WeakMap();this.cases=[];this.counts=[null,0,0,0,0,0,0,0,0,0];
    this.omitted=[0,0];this.incomplete=false;this.collision=false;this.ended=false;this.output=null;this.redact=preparationRedactor(process.env);
  }
  printsToStdio(){return false;}
  contain(action){if(this.ended)return;try{action();}catch{this.incomplete=true;}}
  protect(value){try{clean(value,this.redact);}catch{this.collision=true;}}
  declaration(test) {
    let d=this.tests.get(test);if(d)return d;
    const loc=test.location,file=source(loc?.file),coords=location(loc,file);
    const scenario=file===sourceFiles[9]&&joinedScenarios.includes(test.title)?test.title:null;
    let reason=null;
    if(file===null)reason='unknown_source';
    else if(file===sourceFiles[9]&&scenario===null)reason='unknown_scenario';
    d={file,declaration:coords??[null,null],scenario,reason};
    this.protect(d);this.tests.set(test,d);return d;
  }
  onBegin(config,suite){this.contain(()=>{
    const projects=config.projects;
    if(Array.isArray(projects)&&projects.length) {const outputs=projects.map(p=>p.outputDir);if(outputs.every(v=>typeof v==='string'&&v===outputs[0]))this.output=outputs[0];}
    const tests=suite.allTests();if(!Array.isArray(tests)||!integer(tests.length))reject();this.counts[0]=tests.length;
    for(const test of tests)this.declaration(test);
  });}
  result(test,result){let r=this.results.get(result);if(r)return r;const ordinal=(this.nextResults.get(test)??0)+1;this.nextResults.set(test,ordinal);r={test,ordinal,begin:null,ended:false};this.results.set(result,r);return r;}
  onTestBegin(test,result){this.contain(()=>{this.counts[1]++;this.declaration(test);const r=this.result(test,result);if(r.begin!==null||r.ended){this.incomplete=true;return;}r.begin=this.counts[1];});}
  onError(){if(!this.ended)this.counts[3]++;}
  onTestEnd(test,result){this.contain(()=>{
    this.counts[2]++;const d=this.declaration(test),r=this.result(test,result);if(r.ended||r.test!==test){this.incomplete=true;return;}r.ended=true;
    const rawStatus=result.status,status=testStatuses.includes(rawStatus)?rawStatus:null;
    this.counts[status===null?9:4+testStatuses.indexOf(status)]++;
    const rawErrors=result.errors,error_count=Array.isArray(rawErrors)&&integer(rawErrors.length)?rawErrors.length:null,errors=[];
    if(error_count===null)this.incomplete=true;
    if(error_count!==null)for(let i=0;i<error_count;i++){
      let e;try{
        const error=rawErrors[i],message=error.message;
        // The pinned SDK prefixes ordinary Error messages; keep the bare parser strict.
        const stored=typeof message==='string'&&message.length<=1_000_000&&message.startsWith('Error: ')?storedObservation(d.file,message.slice(7)):null;
        e={ordinal:i+1,location:location(error.location,d.file),stored,reason:stored===null?'unsupported_error':null};
      }
      catch{e={ordinal:i+1,location:null,stored:null,reason:'malformed_error'};}
      this.protect(e);if(i<8)errors.push(e);else this.omitted[1]++;
    }
    let measured;try{measured=measurement(result.annotations,d.file,v=>this.protect(v),()=>{this.collision=true;});}catch{measured={value:null,reason:'malformed_annotation'};}
    const worker=result.workerIndex;
    const c={...d,reason:d.reason??measured.reason,begin:r.begin,end:this.counts[2],result:r.ordinal,status,worker:bounded(worker),duration:bounded(result.duration),error_count,errors,measurement:measured.value};
    this.protect(c);if(this.cases.length<256)this.cases.push(c);else{this.omitted[0]++;this.omitted[1]+=errors.length;}
  });}
  async onEnd(result){
    if(this.ended)return;
    // Late worker callbacks can still arrive. This report includes only observations admitted by this entry.
    this.ended=true;
    try{
      if(this.counts[2]===0||this.output===null)return;
      if(this.collision)reject('privacy_collision');
      const status=result.status,run=runStatuses.includes(status)?status:null;
      const report={completion:!this.incomplete&&this.counts[0]===this.counts[1]&&this.counts[1]===this.counts[2]?'complete':'incomplete',run,counts:this.counts,cases:this.cases,omitted:this.omitted};
      const encoded=encodeReport(report,this.redact);await writeReport(this.output,encoded);
    }catch(error){
      // A collision rejects all facts. The separate marker reports only that rejection.
      if(error.code==='privacy_collision'&&this.counts[2]>0&&this.output!==null)try{
        const unavailable={version:1,source_map:2,unavailable:id(reasons,'privacy_collision')};
        collisionRecord(unavailable,this.redact);await writeReport(this.output,unavailable);
      }catch{}
      // Reporter failure cannot change the suite's terminal status.
    }
  }
}
