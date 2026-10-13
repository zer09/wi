import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountMismatchProtocol, mismatchEvidence } from './account-mismatch-protocol.mjs';
import { fixedHeadEvidence, fixedHeadProtocol } from './fixed-head-protocol.mjs';
import { unboundEvidence, unboundProtocol } from './unbound-history-protocol.mjs';
import { toolFidelityEvidence, toolFidelityProtocol } from './tool-fidelity-protocol.mjs';
import { lifecycleEvidence, lifecycleFlat, lifecycleProtocol } from './lifecycle-failure-protocol.mjs';
import { cancellationEvidence, cancellationFlat, cancellationProtocol, startScenario } from './cancellation-protocol.mjs';
import { linuxProcess, strictStop } from './skill-source-fidelity.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CHILD_TEST = 'providers::openai_codex::tests::replay_loopback_tests::http_api_joined::browser::child';
export const CARGO_ARGS = ['test', '--lib', '--no-run', '--locked', '--offline', '--message-format=json'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const fail = () => { throw new Error('fixture protocol rejected'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function keys(value, fields) {
  if (!object(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
}

export function artifactFromCargo(text, root = ROOT) {
  const artifacts = [];
  let finished = 0;
  for (const line of text.split('\n').filter(line => line.trim() !== '')) {
    let value;
    try { value = JSON.parse(line); } catch { fail(); }
    if (!object(value)) fail();
    if (value.reason === 'build-finished') {
      if (value.success !== true) fail();
      finished++;
    }
    if (value.reason === 'compiler-message' && value.message?.level === 'error') fail();
    if (value.reason !== 'compiler-artifact' || value.target?.name !== 'wi'
      || value.target?.kind?.length !== 1 || value.target.kind[0] !== 'lib'
      || value.profile?.test !== true) continue;
    if (value.target.src_path !== resolve(root, 'src/lib.rs')
      || value.manifest_path !== resolve(root, 'Cargo.toml')
      || typeof value.executable !== 'string' || !isAbsolute(value.executable)) fail();
    artifacts.push(value.executable);
  }
  if (finished !== 1 || artifacts.length !== 1) fail();
  return artifacts[0];
}

export async function discoverFixture() {
  if (!process.versions.node.startsWith('24.')) throw new Error('Node24 required');
  const result = spawnSync('cargo', CARGO_ARGS, { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  // Compiler output is not a fixture protocol and is never forwarded to a browser report.
  if (result.error || result.status !== 0) throw new Error('fixture Cargo build failed');
  const executable = artifactFromCargo(result.stdout);
  if (!(await stat(executable)).isFile()) fail();
  return executable;
}

export function replayHeadRequest(value) {
  keys(value, ['command', 'id', 'step']);
  if (value.command !== 'replay_head' || !count(value.id) || value.id === 0 || value.id > 0xffffffff
    || !['arm', 'wait', 'release'].includes(value.step)) fail();
  return value;
}

export function acceptanceUnknownRequest(value) {
  keys(value, ['command', 'id']);
  if (value.command !== 'arm_acceptance_unknown' || !count(value.id) || value.id === 0 || value.id > 0xffffffff) fail();
  return value;
}

export function acceptanceUnknownProtocol(mutations) {
  let selecting;
  let selected;
  let freshBrowserSessions = new Set();
  let otherControl = false;
  let armedId;
  let acknowledged = false;
  const incompatible = ['arm_acceptance', 'wait_acceptance', 'release_acceptance', 'replay_head', 'seed_input_framing', 'drive', 'arm_acceptance_warning', 'rotate_account'];
  return {
    request(value) {
      if (value.command === 'select') {
        if (armedId !== undefined) fail();
        selecting = { id: value.id, session: value.session_id };
      }
      if (incompatible.includes(value.command)) {
        if (armedId !== undefined) fail();
        otherControl = true;
      }
      if (value.command !== 'arm_acceptance_unknown') return;
      acceptanceUnknownRequest(value);
      if (mutations !== true || !freshBrowserSessions.has(selected) || selecting !== undefined || otherControl || armedId !== undefined) fail();
      armedId = value.id;
    },
    reply(value) {
      if (value.event === 'mutation_inspect') {
        freshBrowserSessions = new Set(value.creations.filter(entry => entry.exact && entry.sequence_count === '1')
          .map(entry => entry.receipt.session_id));
      }
      if (selecting !== undefined && value.id === selecting.id) {
        if (value.event !== 'selected') fail();
        selected = selecting.session; selecting = undefined;
      }
      if (value.event === 'acceptance_unknown_armed' || (armedId !== undefined && value.id === armedId)) {
        if (value.event !== 'acceptance_unknown_armed' || value.id !== armedId || acknowledged) fail();
        acknowledged = true;
      }
    },
  };
}

export function acceptanceWarningRequest(value) {
  keys(value, ['command', 'id']);
  if (value.command !== 'arm_acceptance_warning' || !count(value.id) || value.id === 0 || value.id > 0xffffffff) fail();
  return value;
}

export function acceptanceWarningProtocol(mutations) {
  let selecting;
  let selected;
  let freshBrowserSessions = new Set();
  let otherControl = false;
  let armedId;
  let acknowledged = false;
  let lastId = 0;
  const incompatible = ['arm_acceptance', 'wait_acceptance', 'release_acceptance', 'replay_head', 'seed_input_framing', 'drive', 'arm_acceptance_unknown', 'rotate_account'];
  return {
    request(value) {
      if (!object(value) || !count(value.id) || value.id <= lastId || value.id > 0xffffffff) fail();
      if (value.command === 'select') {
        keys(value, ['command', 'id', 'session_id']);
        if (armedId !== undefined || selecting !== undefined || typeof value.session_id !== 'string'
          || !UUID.test(value.session_id) || value.session_id === '00000000-0000-0000-0000-000000000000') fail();
        selecting = { id: value.id, session: value.session_id };
      }
      if (incompatible.includes(value.command)) {
        if (armedId !== undefined) fail();
        otherControl = true;
      }
      if (value.command === 'arm_acceptance_warning') {
        acceptanceWarningRequest(value);
        if (mutations !== true || !freshBrowserSessions.has(selected) || selecting !== undefined || otherControl || armedId !== undefined) fail();
        armedId = value.id;
      }
      lastId = value.id;
    },
    reply(value) {
      if (value.event === 'mutation_inspect') {
        freshBrowserSessions = new Set(value.creations.filter(entry => entry.exact && entry.sequence_count === '1')
          .map(entry => entry.receipt.session_id));
      }
      if (value.event === 'selected' || (selecting !== undefined && value.id === selecting.id)) {
        parseControl(value);
        if (value.event !== 'selected' || selecting === undefined || value.id !== selecting.id) fail();
        selected = selecting.session; selecting = undefined;
      }
      if (value.event === 'acceptance_warning_armed' || (armedId !== undefined && value.id === armedId)) {
        parseControl(value);
        if (value.event !== 'acceptance_warning_armed' || value.id !== armedId || acknowledged) fail();
        acknowledged = true;
      }
    },
  };
}

export function gate11Options(options, scenario) {
  if (!object(options) || Object.keys(options).some(k => !['gate11Diagnostics','nativeLatency','finalPolling'].includes(k))
    || ['gate11Diagnostics','nativeLatency'].some(k => Object.hasOwn(options,k) && typeof options[k] !== 'boolean')
    || (options.nativeLatency === true && options.gate11Diagnostics !== true)
    || (Object.hasOwn(options,'finalPolling') && (!['baseline','incremental'].includes(options.finalPolling)
      || options.nativeLatency !== true || options.gate11Diagnostics !== true))) fail();
  const enabled = options.gate11Diagnostics === true;
  if (enabled && (scenario.transport !== 'websocket' || scenario.recovered !== false || scenario.mime !== true
    || scenario.presentation !== true || ['mutations','unbound_history','fixed_head','tool_fidelity','lifecycle_failure','cancellation'].some(k => scenario[k] === true))) fail();
  return enabled;
}

export function gate11Evidence(value) {
  keys(value, ['protocol','event','id','state','trace']);
  if (value.protocol !== 1 || value.event !== 'gate11_diagnostic' || !count(value.id) || value.id < 1 || value.id > 0xffffffff
    || !['disabled','unavailable','capture_failed','captured'].includes(value.state)) fail();
  if (value.state !== 'captured') { if (value.trace !== null) fail(); return value; }
  const t = value.trace, finite = (n, max) => count(n) && n <= max, time = n => finite(n, 600_000);
  keys(t, ['admitted_ms','consumed_ms','snapshot_ms','expected_deltas','expected_frames','await_counts',
    'committed_counts','count_changes','gate_ms','history','truncated']);
  if (t.admitted_ms !== 0 || !time(t.snapshot_ms) || (t.consumed_ms !== null && (!time(t.consumed_ms) || t.consumed_ms > t.snapshot_ms))
    || !finite(t.expected_deltas,128) || !finite(t.expected_frames,130) || t.expected_frames < t.expected_deltas
    || !finite(t.count_changes,1_000_000) || typeof t.truncated !== 'boolean') fail();
  if (!Array.isArray(t.await_counts) || t.await_counts.length !== 6 || t.await_counts.some(n => !finite(n,1_000_000))
    || [0,2,4].some(i => t.await_counts[i+1] > t.await_counts[i])) fail();
  if (!Array.isArray(t.committed_counts) || t.committed_counts.length !== 4 || t.committed_counts.some(n => n !== null && !finite(n,1_000_000))) fail();
  const [first,last,min,max] = t.committed_counts;
  if (first === null ? t.committed_counts.some(n => n !== null) || t.count_changes !== 0
    : [last,min,max].some(n => n === null) || min > first || min > last || max < first || max < last || t.count_changes === 0) fail();
  if (!Array.isArray(t.gate_ms) || t.gate_ms.length !== 3) fail();
  let previous = 0, absent = false;
  for (const n of t.gate_ms) {
    if (n === null) absent = true;
    else { if (absent || !time(n) || n < previous || n > t.snapshot_ms) fail(); previous = n; }
  }
  if (!Array.isArray(t.history) || t.history.length > 12) fail();
  previous = 0;
  for (const row of t.history) {
    if (!Array.isArray(row) || row.length !== 5 || !time(row[0]) || row[0] < previous || row[0] > t.snapshot_ms
      || !['send','sent','read','read_done','count','pace','paced'].includes(row[1]) || !finite(row[2],130) || !finite(row[3],128)
      || (row[1] === 'count' ? !finite(row[4],1_000_000) : row[4] !== null)) fail();
    previous = row[0];
  }
  return value;
}

export function latencyEvidence(value) {
  keys(value, ['protocol','event','id','state','page','pages','rows']);
  if (value.protocol !== 1 || value.event !== 'gate11_latency' || !count(value.id) || value.id < 1 || value.id > 0xffffffff
    || !['disabled','unavailable','capture_failed','captured'].includes(value.state)
    || !count(value.page) || !count(value.pages) || value.page > 33 || value.pages > 34 || !Array.isArray(value.rows)) fail();
  if (value.state !== 'captured') {
    if (value.page !== 0 || value.pages !== 0 || value.rows.length !== 0) fail();
    return value;
  }
  if (value.pages < 1 || value.page >= value.pages || value.rows.length < 1 || value.rows.length > 24) fail();
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.some(n => !count(n) || n > 600_000_000)) fail();
    const [kind] = row;
    if (kind === 0) {
      if (row.length !== 9 || row[1] > row[2] || row[3] > row[2]-row[1] || row[4] !== row[2]-row[1]-row[3]
        || row.slice(6,8).some(n => n > 1) || row[8] > 128) fail();
    } else if (kind === 1) {
      if (row.length !== 6 || row[1] > 29 || row[4] > row[3] || row[5] > row[2]) fail();
    } else if (kind === 2) {
      if (row.length !== 9 || row[1] > 29 || row[2] > 1_000_000 || row[3] > 1_000_000 || row[4] > 70
        || row[5] > row[6] || row[7] > 1 || row[8] > 1) fail();
    } else if (kind === 3) {
      if (row.length !== 4 || row[1] < 1 || row[1] > 1_000_000 || row[2] > 2 || row[3] > 70) fail();
    } else if (kind === 4) {
      if (row.length !== 5 || row[2] > row[1] || row[3] > 70 || row[3] > row[4]) fail();
    } else fail();
  }
  return value;
}

export async function captureLatency(fixture) {
  const rows = [];
  let pages, bytes = 0;
  for (let page = 0; page < (pages ?? 1); page++) {
    const value = latencyEvidence(await fixture.request({command:'gate11_latency',page}));
    if (value.state !== 'captured') throw new Error(`fixture latency ${value.state}`);
    if (value.page !== page || (pages !== undefined && pages !== value.pages) || (page < value.pages-1 && value.rows.length !== 24)) fail();
    pages = value.pages; bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > 48 * 1024) fail();
    rows.push(...value.rows);
  }
  const work = rows[31]?.[0] === 4;
  if (rows.length > 800 || rows[0]?.[0] !== 0 || rows.slice(1,31).some((r,i) => r[0] !== 1 || r[1] !== i)
    || rows.length < 31 || rows.slice(work ? 32 : 31).some(r => ![2,3].includes(r[0]))) fail();
  const operations = rows.filter(r => r[0] === 3), intervals = rows.filter(r => r[0] === 2), window = rows[0][2]-rows[0][1];
  if (operations.length > 512 || intervals.length > 256 || new Set(operations.map(r=>r[1])).size !== operations.length
    || intervals.some(r=>r[6]>window || (r[2] !== 0 && !operations.some(op=>op[1]===r[2])))) fail();
  return Object.freeze(rows.map(row => Object.freeze([...row])));
}

// Node and native clock origins are separate. Only drive10/gate11 correlate them.
export function gate11Witness(enabled, now = () => performance.now()) {
  let origin, failed = false, truncated = false, driveId = null;
  const history = [];
  const labels = ['drive_request','drive_ack','wait_start','wait_expired','gate_parse','gate_queue','gate_match'];
  return {
    mark(label, id = null) {
      if (!enabled) return;
      try {
        if (!labels.includes(label)) fail();
        if (label === 'drive_request') { if (origin !== undefined || !count(id) || id < 1 || id > 0xffffffff) fail(); origin = now(); driveId = id; }
        if (origin === undefined) fail();
        const ms = Math.floor(now() - origin);
        if (!count(ms) || ms > 600_000 || ms < (history.at(-1)?.[0] ?? 0)) fail();
        if (history.length === 16) { history.shift(); truncated = true; }
        history.push([ms,label]);
      } catch { failed = true; }
    },
    snapshot() {
      const state = !enabled ? 'disabled' : failed ? 'capture_failed' : origin === undefined ? 'unavailable' : 'captured';
      return Object.freeze({ state, drive_id: driveId, truncated, history: Object.freeze(history.map(row => Object.freeze([...row]))) });
    },
  };
}

export async function captureGate11(fixture, failure = null) {
  // Freeze timeout-time facts before a control request can observe later native progress.
  const facts = failure === null ? null : Object.freeze({ ...failure });
  let node;
  try { node = fixture.diagnostics(); } catch { node = Object.freeze({state:'capture_failed',drive_id:null,truncated:false,history:Object.freeze([])}); }
  let native = null, native_state = 'unavailable';
  try {
    native = gate11Evidence(await fixture.request({command:'gate11_diagnostic'}));
    native_state = native.state;
  } catch { native_state = 'rejected'; }
  return Object.freeze({ observation: facts === null ? 'boundary' : 'post_failure', failure: facts, node, native_state, native });
}

export function requireGate11(report) {
  if (report.node.state !== 'captured' || report.native_state !== 'captured') throw new Error('fixture diagnostic failed');
  if (report.observation === 'boundary') {
    const t = report.native.trace, labels = report.node.history.map(row => row[1]);
    if (t.consumed_ms === null || t.expected_deltas !== 70 || t.expected_frames !== 72
      || t.gate_ms.some(n => n === null) || t.await_counts[0] !== 72 || t.await_counts[1] !== 72
      || t.await_counts[2] !== t.await_counts[3] || t.await_counts[2] < 70 || t.committed_counts[1] !== 70
      || !['drive_request','drive_ack','wait_start','gate_parse','gate_match'].every(label => labels.includes(label))
      || labels.includes('wait_expired') || report.node.truncated) throw new Error('fixture diagnostic failed');
  }
}

export function parseControl(value) {
  if (!object(value) || value.protocol !== 1 || typeof value.event !== 'string') fail();
  const base = ['protocol', 'event'];
  if (value.event === 'fixture_failed') {
    keys(value, [...base, 'phase', 'category']);
    // These pairs match the native caught-failure markers, not free-form diagnostics.
    const categories = {
      unknown: ['control_other'], selection: ['invariant'], connect: ['connect_busy', 'connect_other'],
      events_query: ['query_busy', 'query_other'], events_decode: ['decode'],
      receipts_query: ['query_busy', 'query_other'], receipts_decode: ['decode'],
    };
    if (typeof value.phase !== 'string' || typeof value.category !== 'string'
      || !Object.hasOwn(categories, value.phase) || !categories[value.phase].includes(value.category)) fail();
    return value;
  }
  if (['model_paused', 'task_finished'].includes(value.event)) {
    const field = value.event === 'model_paused' ? 'gate' : 'task';
    keys(value, [...base, field]);
    if (!count(value[field]) || value[field] < 1 || value[field] > (field === 'gate' ? 12 : 2)) fail();
    return value;
  }
  if (!count(value.id) || value.id === 0) fail();
  base.push('id');
  if (value.event === 'ready') {
    keys(value, [...base, 'origin', ...Object.hasOwn(value, 'session_id') ? ['session_id'] : []]);
    if (Object.hasOwn(value, 'session_id') && (typeof value.session_id !== 'string' || !UUID.test(value.session_id)
      || value.session_id === '00000000-0000-0000-0000-000000000000')) fail();
    if (typeof value.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(value.origin)) fail();
    let url;
    try { url = new URL(value.origin); } catch { fail(); }
    if (url.origin !== value.origin) fail();
  } else if (value.event === 'inspect') {
    keys(value, [...base, 'connections', 'requests', 'gate', 'completed', 'fresh_empty', 'restored_history',
      'fresh_parents', 'continuations', 'prepared_exact', 'auth_loads', 'auth_prepares', 'sequence_count',
      'accepted', 'receipts', 'tool_results', 'terminals', 'results', 'response_finishes', 'terminal_sequences', 'result_sequences',
      'provider_stage', 'provider_failed', 'read_failure']);
    for (const field of ['connections', 'requests', 'completed', 'fresh_parents', 'continuations', 'prepared_exact',
      'auth_loads', 'auth_prepares', 'tool_results', 'terminals', 'results']) if (!count(value[field])) fail();
    if (typeof value.provider_failed !== 'boolean'
      || ![null, 'request', 'request_records', 'reply', 'close', 'final_records', 'saved_fidelity', 'saved_summary', 'finished'].includes(value.provider_stage)
      || ![null, 'connect_busy', 'connect_other', 'query_busy', 'query_other'].includes(value.read_failure)) fail();
    if (typeof value.fresh_empty !== 'boolean' || typeof value.restored_history !== 'boolean'
      || (value.gate !== null && (!count(value.gate) || value.gate < 1 || value.gate > 12))
      || typeof value.sequence_count !== 'string' || !DECIMAL.test(value.sequence_count)
      || !Array.isArray(value.accepted) || value.accepted.length > 2
      || !Array.isArray(value.receipts) || value.receipts.length > 2) fail();
    if (!Array.isArray(value.response_finishes) || value.response_finishes.length > 4) fail();
    for (const response of value.response_finishes) {
      keys(response, ['sequence', 'provenance']);
      if (typeof response.sequence !== 'string' || !DECIMAL.test(response.sequence)
        || !['native_terminal', 'validated_output_item_done'].includes(response.provenance)) fail();
    }
    for (const field of ['terminal_sequences', 'result_sequences']) {
      if (!Array.isArray(value[field]) || value[field].length > 2
        || value[field].some(sequence => typeof sequence !== 'string' || !DECIMAL.test(sequence))) fail();
    }
    if (value.terminal_sequences.length !== value.terminals || value.result_sequences.length !== value.results) fail();
    for (const accepted of value.accepted) {
      keys(accepted, ['run_id', 'accepted_sequence']);
      if (!UUID.test(accepted.run_id) || typeof accepted.accepted_sequence !== 'string' || !DECIMAL.test(accepted.accepted_sequence)) fail();
    }
    for (const receipt of value.receipts) {
      keys(receipt, ['operation_id', 'session_id', 'run_id', 'first_sequence', 'last_sequence']);
      for (const field of ['operation_id', 'session_id', 'run_id']) if (!UUID.test(receipt[field])) fail();
      for (const field of ['first_sequence', 'last_sequence']) if (typeof receipt[field] !== 'string' || !DECIMAL.test(receipt[field])) fail();
      if (BigInt(receipt.last_sequence) !== BigInt(receipt.first_sequence) + 1n) fail();
    }
  } else if (['cancellation_pending', 'cancellation_paused', 'cancellation_inspect'].includes(value.event)) {
    cancellationEvidence(value);
  } else if (['cancellation_armed', 'cancellation_released'].includes(value.event)) {
    keys(value, base);
    if (value.id > 0xffffffff) fail();
  } else if (['lifecycle_failure_paused', 'lifecycle_failure_inspect'].includes(value.event)) {
    lifecycleEvidence(value);
  } else if (['lifecycle_failure_armed', 'lifecycle_failure_released'].includes(value.event)) {
    keys(value, base);
    if (value.id > 0xffffffff) fail();
  } else if (value.event === 'tool_fidelity_inspect') {
    toolFidelityEvidence(value);
  } else if (value.event === 'fixed_head_inspect') {
    fixedHeadEvidence(value);
  } else if (value.event === 'unbound_history_inspect') {
    unboundEvidence(value);
  } else if (value.event === 'account_mismatch_inspect') {
    mismatchEvidence(value);
  } else if (['acceptance_unknown_armed', 'acceptance_warning_armed', 'account_rotated'].includes(value.event)) {
    keys(value, base);
    if (value.id > 0xffffffff) fail();
  } else if (value.event === 'replay_head') {
    keys(value, [...base, 'step']);
    if (value.id > 0xffffffff || !['armed', 'paused', 'released'].includes(value.step)) fail();
  } else if (value.event === 'input_framing_seeded') {
    keys(value, [...base, 'max_input_bytes', 'task_bytes', 'unframed_bytes', 'project_bytes', 'skill_bytes',
      'framed_bytes', 'catalog_entries', 'unframed_valid', 'framing_overflow']);
    const max = value.max_input_bytes;
    if (value.id > 0xffffffff || max !== 1024 * 1024 || value.task_bytes !== max * 3 / 4
      || value.project_bytes !== max / 2 || value.catalog_entries !== 1
      || value.unframed_valid !== true || value.framing_overflow !== true
      || !count(value.unframed_bytes) || value.unframed_bytes <= value.task_bytes || value.unframed_bytes > max
      || !count(value.skill_bytes) || value.skill_bytes === 0 || value.skill_bytes >= max
      || !count(value.framed_bytes) || value.framed_bytes <= max || value.framed_bytes >= 2 * max) fail();
  } else if (value.event === 'task_inspect') {
    keys(value, [...base, 'exact', 'receipt', 'accepted_event_id', 'checkpoint_event_id', 'sequence_count',
      'task_commands', 'runs', 'acceptance_events', 'selection_events', 'binding_events', 'rename_events',
      'run_state', 'deltas', 'tool_starts', 'tool_finishes']);
    const receipt = value.receipt;
    keys(receipt, ['operation_id', 'session_id', 'run_id', 'first_sequence', 'last_sequence']);
    const ids = [receipt.operation_id, receipt.session_id, receipt.run_id, value.accepted_event_id, value.checkpoint_event_id];
    if (ids.some(id => typeof id !== 'string' || !UUID.test(id) || id === '00000000-0000-0000-0000-000000000000')
      || value.accepted_event_id === value.checkpoint_event_id || value.exact !== true
      || receipt.first_sequence !== '2' || receipt.last_sequence !== '3'
      || typeof value.sequence_count !== 'string' || !DECIMAL.test(value.sequence_count)
      || BigInt(value.sequence_count) < 3n || BigInt(value.sequence_count) > 9223372036854775807n
      || ['task_commands', 'runs', 'acceptance_events', 'selection_events'].some(field => value[field] !== 1)
      || value.rename_events !== 0 || !['accepted', 'running', 'completed'].includes(value.run_state)
      || ['binding_events', 'deltas', 'tool_starts', 'tool_finishes'].some(field => !count(value[field]) || value[field] > 1)
      || value.tool_finishes > value.tool_starts) fail();
  } else if (value.event === 'mutation_inspect') {
    keys(value, [...base, 'max_input_bytes', 'session_count', 'seed_sessions', 'creations']);
    if (!count(value.max_input_bytes) || value.max_input_bytes === 0
      || !Array.isArray(value.creations) || value.creations.length > 2
      || !count(value.seed_sessions) || value.seed_sessions > 1
      || !count(value.session_count) || value.session_count !== value.creations.length + value.seed_sessions) fail();
    for (const [slot, entry] of value.creations.entries()) {
      keys(entry, ['slot', 'receipt', 'sequence_count', 'rename_events', 'renames', 'rename_event_ids',
        'exact', 'catalog_head_sequence', 'catalog_current']);
      if (entry.slot !== slot || entry.exact !== true || typeof entry.catalog_current !== 'boolean'
        || !Array.isArray(entry.renames) || entry.renames.length > 2 || entry.rename_events !== entry.renames.length
        || entry.sequence_count !== String(1 + entry.renames.length)
        || (slot !== 0 && entry.renames.length !== 0)
        || !Array.isArray(entry.rename_event_ids) || entry.rename_event_ids.length !== entry.rename_events
        || entry.rename_event_ids.some(id => typeof id !== 'string' || !UUID.test(id) || id === '00000000-0000-0000-0000-000000000000')
        || new Set(entry.rename_event_ids).size !== entry.rename_events
        || typeof entry.catalog_head_sequence !== 'string' || !DECIMAL.test(entry.catalog_head_sequence)
        || BigInt(entry.catalog_head_sequence) < 1n || BigInt(entry.catalog_head_sequence) > BigInt(entry.sequence_count)
        || entry.catalog_current !== (entry.catalog_head_sequence === entry.sequence_count)) fail();
      const operations = new Set();
      let previous = 0n;
      for (const receipt of [entry.receipt, ...entry.renames]) {
        keys(receipt, ['operation_id', 'session_id', 'run_id', 'first_sequence', 'last_sequence']);
        if (['operation_id', 'session_id'].some(field => typeof receipt[field] !== 'string' || !UUID.test(receipt[field])
          || receipt[field] === '00000000-0000-0000-0000-000000000000') || receipt.run_id !== null
          || receipt.session_id !== entry.receipt.session_id || operations.has(receipt.operation_id)
          || typeof receipt.first_sequence !== 'string' || !DECIMAL.test(receipt.first_sequence)
          || receipt.first_sequence !== receipt.last_sequence || BigInt(receipt.first_sequence) !== previous + 1n
          || BigInt(receipt.last_sequence) > BigInt(entry.sequence_count)) fail();
        operations.add(receipt.operation_id);
        previous = BigInt(receipt.last_sequence);
      }
      if (entry.receipt.first_sequence !== '1') fail();
    }
    if (new Set(value.creations.map(entry => entry.receipt.session_id)).size !== value.creations.length) fail();
  } else if (value.event === 'gate11_latency') {
    latencyEvidence(value);
  } else if (value.event === 'gate11_diagnostic') {
    gate11Evidence(value);
  } else if (value.event === 'stopped') {
    keys(value, [...base, 'cleaned']);
    if (value.cleaned !== true) fail();
  } else {
    if (!['selected', 'armed', 'acceptance_paused', 'released', 'driven'].includes(value.event)) fail();
    keys(value, base);
  }
  return value;
}

export function stdoutParser(onMessage) {
  let pending = Buffer.alloc(0);
  let total = 0;
  let harnessLines = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    push(chunk) {
      total += chunk.length;
      if (total > 64 * 1024) fail();
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end === -1) break;
        if (end > 4096) fail();
        let line;
        try { line = decoder.decode(pending.subarray(0, end)); } catch { fail(); }
        pending = pending.subarray(end + 1);
        const prefix = `test ${CHILD_TEST} ... `;
        if (line.startsWith(prefix)) line = line.slice(prefix.length);
        if (line.startsWith('{')) {
          let value;
          try { value = JSON.parse(line); } catch { fail(); }
          // JSON.parse hides earlier event members, so count decoded top-level names before dispatch.
          let depth = 0, events = 0;
          for (const token of line.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
            const text = token[0];
            if (text === '{' || text === '[') depth++;
            else if (text === '}' || text === ']') depth--;
            else if (depth === 1 && /^\s*:/.test(line.slice(token.index + text.length))
              && JSON.parse(text) === 'event' && ++events > 1) fail();
          }
          if (['gate11_diagnostic','gate11_latency'].includes(value?.event)) {
            // Numeric-only traces need no escapes. Reject hidden duplicate members at every level.
            if (line.includes('\\')) fail();
            const objects = [];
            for (const token of line.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
              if (token[0] === '{') objects.push(new Set());
              else if (token[0] === '}') objects.pop();
              else if (/^\s*:/.test(line.slice(token.index + token[0].length))) {
                const name = JSON.parse(token[0]), fields = objects.at(-1);
                if (!fields || fields.has(name)) fail();
                fields.add(name);
              }
            }
          }
          if (value?.event === 'fixture_failed') {
            // Reject escaped keys as well as duplicates before JSON.parse hides them.
            if (line.includes('\\') || line.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length !== 5) fail();
          }
          if (value?.event?.startsWith('cancellation_') || ['ready','stopped'].includes(value?.event)) cancellationFlat(line);
          if (value?.event === 'tool_fidelity_inspect') toolFidelityEvidence(line);
          if (value?.event?.startsWith('lifecycle_failure_') || ['selected','driven','model_paused'].includes(value?.event)) lifecycleFlat(line);
          // Flat acknowledgements have a fixed field count. Count keys before
          // JSON.parse can hide duplicates, including escaped spellings of the same key.
          if (['ready', 'fixed_head_inspect', 'unbound_history_inspect', 'replay_head', 'acceptance_unknown_armed', 'acceptance_warning_armed', 'account_rotated', 'account_mismatch_inspect'].includes(value?.event)) {
            let fields = 3;
            if (value.event === 'ready') fields = Object.hasOwn(value, 'session_id') ? 5 : 4;
            if (value.event === 'unbound_history_inspect') fields = 21;
            if (value.event === 'fixed_head_inspect') {
              fields = 19;
              if (line.includes('\\')) fail();
            }
            if (value.event === 'replay_head') fields = 4;
            if (value.event === 'account_mismatch_inspect') fields = 20;
            if (line.replace(/"(?:\\.|[^"\\])*"/g, '""').split(':').length !== fields + 1) fail();
          }
          onMessage(parseControl(value));
        } else {
          // Retain only a count, never raw harness or panic text.
          if (++harnessLines > 16 || !(line === '' || line === 'ok' || line === 'running 1 test'
            || /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [0-9.]+s$/.test(line))) fail();
        }
      }
      if (pending.length > 4096) fail();
    },
    end() { if (pending.length !== 0) fail(); },
    get harnessLines() { return harnessLines; },
  };
}

export const bounded = async (promise, ms, message, expired) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { expired?.(); reject(new Error(message)); }, ms); })]);
  } finally { clearTimeout(timer); }
};

function boundRoot(root) {
  if (!object(root) || root.verified !== true || typeof root.path !== 'string' || root.path !== resolve(root.path)
    || dirname(root.path) !== tmpdir() || !/^wi-browser-[A-Za-z0-9]+$/.test(basename(root.path))
    || !Number.isSafeInteger(root.pid) || root.pid <= 1 || !/^[0-9]+$/.test(root.start)
    || !/^[0-9]+$/.test(root.dev) || !/^[0-9]+$/.test(root.ino)) fail();
}
export async function fixtureRootAbsent(root, probe = lstat) {
  boundRoot(root);
  try { await probe(root.path); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  fail();
}
export function evaluateSkillCleanup(cleanup) {
  strictStop(cleanup?.evidence);
  boundRoot(cleanup.root);
  if (typeof cleanup.handle_acquired !== 'boolean'
    || (cleanup.handle_acquired ? cleanup.handle_closed !== true : cleanup.handle_closed !== null)
    || cleanup.fixture !== true || cleanup.root_absent !== true || cleanup.pid_absent !== true
    || !Number.isSafeInteger(cleanup.contexts_expected) || cleanup.contexts_expected < 1
    || cleanup.contexts !== cleanup.contexts_expected) fail();
  return true;
}

export async function startFixture(executable, scenario, options = {}) {
  scenario = startScenario(scenario);
  const diagnosticsEnabled = gate11Options(options, scenario);
  const diagnostic = gate11Witness(diagnosticsEnabled);
  const sandbox = await mkdtemp(join(tmpdir(), 'wi-browser-'));
  const owner = randomBytes(32).toString('hex');
  const child = spawn(executable, ['--ignored', '--exact', CHILD_TEST, '--nocapture', '--test-threads=1'], {
    cwd: sandbox, stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: sandbox, XDG_CONFIG_HOME: sandbox, CODEX_HOME: sandbox, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
  });
  const messages = [];
  const waiters = [];
  let error = null;
  let stderrBytes = 0;
  let nextId = 1;
  let closing = false;
  let terminal = null;
  let stopResult, stopId;
  let closed = false;
  const stopFacts = { attempted: false, clean_acknowledgment: false, reap_complete: false, sandbox_removed: false, sigterm: false, sigkill: false };
  const evidence = () => Object.freeze({ failure: terminal, stop: Object.freeze({ ...stopFacts,
    exit_observed: closed, exit_zero: closed ? exitCode === 0 : null, error_latched: error !== null, stderr_empty: stderrBytes === 0 }) });
  const rejectAll = () => {
    error ??= new Error('fixture child failed');
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const acceptanceUnknown = acceptanceUnknownProtocol(scenario.mutations);
  const acceptanceWarning = acceptanceWarningProtocol(scenario.mutations);
  const accountMismatch = accountMismatchProtocol(scenario);
  const unbound = unboundProtocol(scenario.unbound_history === true);
  const fixedHead = fixedHeadProtocol(scenario.fixed_head === true);
  const toolFidelity = toolFidelityProtocol(scenario.tool_fidelity === true);
  const lifecycle = lifecycleProtocol(scenario.lifecycle_failure === true);
  const cancellation = cancellationProtocol(scenario.cancellation === true);
  const parser = stdoutParser(message => {
    if (message.event === 'fixture_failed') {
      terminal ??= Object.freeze({ phase: message.phase, category: message.category });
      rejectAll();
      return;
    }
    const gate11 = message.event === 'model_paused' && message.gate === 11;
    if (gate11) diagnostic.mark('gate_parse');
    if (message.id === stopId && message.event === 'stopped') stopFacts.clean_acknowledgment = message.cleaned === true;
    if (error) return;
    cancellation.reply(message);
    lifecycle.reply(message);
    toolFidelity.reply(message);
    fixedHead.reply(message);
    if (scenario.fixed_head !== true) unbound.reply(message);
    acceptanceWarning.reply(message);
    acceptanceUnknown.reply(message);
    accountMismatch.reply(message);
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index >= 0) {
      if (gate11) diagnostic.mark('gate_match');
      waiters.splice(index, 1)[0].resolve(message);
    } else {
      if (messages.length >= 32) fail();
      if (gate11) diagnostic.mark('gate_queue');
      messages.push(message);
    }
  });
  // A later failed signal attempt must not erase an earlier successful one.
  child.stdout.on('data', chunk => { try { parser.push(chunk); } catch { rejectAll(); if (!terminal) stopFacts.sigterm = child.kill('SIGTERM') || stopFacts.sigterm; } });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 16 * 1024) { rejectAll(); if (!terminal) stopFacts.sigterm = child.kill('SIGTERM') || stopFacts.sigterm; }
  });
  child.stdin.on('error', rejectAll);
  child.on('error', rejectAll);
  let exitCode;
  const exited = new Promise(resolveExit => child.on('close', code => {
    exitCode = code;
    closed = true;
    try { parser.end(); } catch { rejectAll(); }
    if (!closing || code !== 0 || waiters.length !== 0) rejectAll();
    resolveExit();
  }));
  const wait = async (match, gate11 = false) => {
    if (gate11) diagnostic.mark('wait_start');
    if (error) throw error;
    const index = messages.findIndex(match);
    if (index >= 0) {
      if (gate11) diagnostic.mark('gate_match');
      return messages.splice(index, 1)[0];
    }
    let waiter;
    try {
      const message = await bounded(new Promise((resolveMessage, reject) => {
        waiter = { match, resolve: resolveMessage, reject }; waiters.push(waiter);
      }), 20_000, 'fixture control timed out', gate11 ? () => diagnostic.mark('wait_expired') : undefined);
      if (error) throw error;
      return message;
    } finally {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    }
  };
  const request = async body => {
    if (error) throw error;
    // Retired controls must not reach the child's stdin in any retained mode.
    if (body.command === 'read_reconnect') fail();
    if (body.command === 'gate11_diagnostic') {
      keys(body, ['command']);
      if (!diagnosticsEnabled) fail();
    }
    if (body.command === 'gate11_latency') {
      keys(body, ['command','page']);
      if (options.nativeLatency !== true || !count(body.page) || body.page > 33) fail();
    }
    const id = nextId++;
    if (body.command === 'stop') stopId = id;
    const command = { ...body, id };
    if ((scenario.cancellation === true || scenario.lifecycle_failure === true || scenario.tool_fidelity === true || scenario.unbound_history === true || scenario.fixed_head === true || ['arm_acceptance_unknown', 'arm_acceptance_warning', 'rotate_account'].includes(body.command)) && Object.hasOwn(body, 'id')) fail();
    cancellation.request(command);
    lifecycle.request(command);
    toolFidelity.request(command);
    fixedHead.request(command);
    unbound.request(command);
    acceptanceWarning.request(command);
    acceptanceUnknown.request(command);
    accountMismatch.request(command);
    if (body.command === 'replay_head') replayHeadRequest(command);
    const drive10 = body.command === 'drive' && body.gate === 10;
    if (drive10) diagnostic.mark('drive_request', id);
    const reply = wait(message => message.id === id);
    child.stdin.write(`${JSON.stringify(command)}\n`);
    const message = await reply;
    // An acknowledgment and fatal event can arrive in the same pipe chunk.
    if (error) throw error;
    if (drive10 && message.event === 'driven') diagnostic.mark('drive_ack');
    return message;
  };
  function stop() {
    stopResult ??= (async () => {
      closing = true;
      try {
        if (!closed && !error) {
          stopFacts.attempted = true;
          const reply = await bounded(request({ command: 'stop' }), 5000, 'fixture stop timed out');
          stopFacts.clean_acknowledgment = reply.event === 'stopped' && reply.cleaned === true;
        }
      } catch { /* Reap below without forwarding child diagnostics. */ }
      finally {
        child.stdin.end();
        // A valid fatal event rejects controls but lets the native drain finish first.
        try { await bounded(exited, 5000, 'fixture exit timed out'); }
        catch {
          stopFacts.sigterm = child.kill('SIGTERM') || stopFacts.sigterm;
          try { await bounded(exited, 2000, 'fixture terminate timed out'); }
          catch { stopFacts.sigkill = child.kill('SIGKILL'); await bounded(exited, 2000, 'fixture reap timed out'); }
        }
        stopFacts.reap_complete = closed;
        await rm(sandbox, { recursive: true, force: true });
        stopFacts.sandbox_removed = true;
      }
      if (!stopFacts.clean_acknowledgment || exitCode !== 0 || error || stderrBytes !== 0) throw new Error('fixture shutdown failed');
    })();
    return stopResult;
  }
  try {
    if (!['websocket', 'sse'].includes(scenario.transport)) fail();
    // The internal Rust enum uses web_socket; the public SettingsView uses websocket.
    const transport = scenario.transport === 'websocket' ? 'web_socket' : 'sse';
    const ready = await request({ ...scenario, transport, owner, ...(diagnosticsEnabled ? {gate11_diagnostics:true} : {}), ...(options.nativeLatency === true ? {native_latency:true} : {}),
      ...(Object.hasOwn(options,'finalPolling') ? {final_polling:options.finalPolling} : {}) });
    if (ready.event !== 'ready') fail();
    return {
      origin: ready.origin, sessionId: ready.session_id, owner, request, stop, evidence, pid: child.pid,
      async bindRoot() {
        // Bind the actual fixture sandbox without opening or changing the skill source.
        const s = await lstat(sandbox, {bigint:true}), live = await linuxProcess(child.pid);
        if (!s.isDirectory() || s.isSymbolicLink() || await realpath(sandbox) !== sandbox
          || live.pid !== child.pid || live.ppid !== process.pid || !live.alive
          || live.cwd !== sandbox || live.tmpdir !== sandbox) fail();
        const root = Object.freeze({path:sandbox,pid:child.pid,start:live.start,dev:String(s.dev),ino:String(s.ino),verified:true});
        boundRoot(root); return root;
      },
      diagnostics: () => diagnostic.snapshot(),
      wait: (event, number) => wait(message => message.event === event && (message.gate ?? message.task) === number, event === 'model_paused' && number === 11),
      inspect: () => request({ command: 'inspect' }),
      inspectMutations: () => request({ command: 'inspect_mutations' }),
      inspectTask: () => request({ command: 'inspect_task' }),
      inspectToolFidelity: () => request({ command: 'inspect_tool_fidelity' }),
    };
  } catch {
    await stop().catch(() => {});
    throw new Error('fixture startup failed');
  }
}
