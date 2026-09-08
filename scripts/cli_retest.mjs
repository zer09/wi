#!/usr/bin/env node
// Fixed CLI runner. Raw subprocess data stays in bounded memory, never in reports.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATEWAY = fileURLToPath(new URL('../target/debug/gateway', import.meta.url));
const LINE = 8 * 1024 * 1024;
const TOTAL = 64 * 1024 * 1024;
const STDERR = 64 * 1024;
const TEXT = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const own = (v, k) => Object.hasOwn(v, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 512;
const emptyCounts = () => ({ total: 0, message: 0, function_call: 0, reasoning: 0, other: 0, malformed: 0 });
const errorMap = new Map([
  ['error: invalid provider protocol: CLI streamed output is inconsistent with terminal output or exceeds tracking limits', 'lifecycle_guard'],
  ['error: demo expected a tool call but the model did not request one', 'no_tool'],
  ['error: locally interrupted; upstream execution may still be running', 'cancelled'],
  ['error: provider rejected the request; error details withheld', 'provider_failed'],
  ['error: provider transport timed out; no automatic retry', 'transport_timeout'],
  ['error: provider transport failed; no automatic retry', 'transport_failed'],
  ['error: response is not completed; tools must not execute', 'not_completed'],
  ['error: unsupported output; no unknown tool/program is executed', 'unsupported_output'],
  ['error: tool arguments failed local validation', 'invalid_arguments'],
  ['error: invalid provider protocol: synthetic answer did not match', 'answer_mismatch'],
]);

export function command(which) {
  if (!['continuation', 'tool'].includes(which)) throw new Error('invalid_case');
  const args = [which === 'tool' ? 'tool-demo' : 'generate', '--auth-source', 'codex',
    '--model', 'gpt-6-astra', '--transport', 'websocket', '--json'];
  if (which === 'continuation') args.push('--prompt', 'Remember the word lantern and acknowledge.',
    '--follow-up', 'What word did I ask you to remember?');
  return args;
}
function countItem(counts, item) {
  counts.total++;
  if (!object(item) || typeof item.kind !== 'string') counts.malformed++;
  else if (['message', 'function_call', 'reasoning'].includes(item.kind)) counts[item.kind]++;
  else counts.other++;
}
function ordinary(response) {
  if (!Array.isArray(response.output)) return { state: 'missing_or_invalid_output' };
  let text = '', seen = false;
  for (const item of response.output) {
    if (!object(item)) return { state: 'malformed_content' };
    if (item.kind === 'reasoning') continue;
    if (item.kind === 'function_call') return { state: 'unsupported_kind_or_part' };
    if (item.kind !== 'message') return { state: 'unsupported_kind_or_part' };
    if (item.native_type !== 'message' || item.native?.type !== 'message' || !Array.isArray(item.native?.content)) return { state: 'malformed_content' };
    for (const part of item.native.content) {
      if (part?.type !== 'output_text') return { state: 'unsupported_kind_or_part' };
      if (typeof part.text !== 'string') return { state: 'malformed_content' };
      if (Buffer.byteLength(text) + Buffer.byteLength(part.text) > TEXT) return { state: 'over_limit' };
      text += part.text;
      seen = true;
    }
  }
  if (!seen) return { state: 'no_ordinary_parts' };
  if (response.text !== text) return { state: 'normalized_mismatch' };
  return { state: 'available', lantern: /\blantern\b/i.test(text), final42: text.trim() === '42' };
}
function exactCall(item) {
  const c = item?.function_call, n = item?.native;
  if (item?.kind !== 'function_call' || item.native_type !== 'function_call' || !object(c) || !object(n)) return false;
  if (!id(c.call_id) || c.name !== 'add_numbers' || c.complete !== true || c.origin !== 'direct' || c.namespace !== null) return false;
  if (n.type !== 'function_call' || n.call_id !== c.call_id || n.name !== c.name || n.arguments !== c.arguments) return false;
  if ((own(n, 'status') && n.status !== 'completed') || (n.namespace != null)) return false;
  if (n.caller != null && (!object(n.caller) || n.caller.type !== 'direct')) return false;
  if (typeof c.arguments !== 'string' || Buffer.byteLength(c.arguments) > 65536) return false;
  // Reject floating/exponent spellings too, as the Rust i64 validator does.
  return /^\s*\{\s*"a"\s*:\s*17\s*,\s*"b"\s*:\s*25\s*\}\s*$/.test(c.arguments)
    || /^\s*\{\s*"b"\s*:\s*25\s*,\s*"a"\s*:\s*17\s*\}\s*$/.test(c.arguments);
}

export class Evidence {
  // Identity and phase must never become fields of the emitted request summaries.
  #lifecycle = new Map();
  #active = null;
  #stream = { sessionId: null, eventIds: new Set(), sequence: -1 };
  constructor(which) {
    command(which);
    this.which = which;
    this.pending = Buffer.alloc(0);
    this.total = 0;
    this.stderr = Buffer.alloc(0);
    this.requests = new Map();
    this.reason = null;
    this.lines = 0;
    this.callId = null;
    this.started = 0;
    this.finished = 0;
    this.executorOK = true;
    this.reused = 0;
  }
  fail(reason) { this.reason ??= reason; this.pending = Buffer.alloc(0); }
  data(chunk) {
    if (this.reason) return;
    this.total += chunk.length;
    if (this.total > TOTAL) return this.fail('cumulative_overflow');
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      if (this.pending.length + i - start > LINE) return this.fail('line_overflow');
      const line = Buffer.concat([this.pending, chunk.subarray(start, i)]);
      this.pending = Buffer.alloc(0);
      this.line(line);
      if (this.reason) return;
      start = i + 1;
    }
    if (this.pending.length + chunk.length - start > LINE) return this.fail('line_overflow');
    this.pending = Buffer.concat([this.pending, chunk.subarray(start)]);
  }
  errorData(chunk) {
    if (this.reason) return;
    if (this.stderr.length + chunk.length > STDERR) return this.fail('stderr_overflow');
    this.stderr = Buffer.concat([this.stderr, chunk]);
  }
  line(bytes) {
    if (++this.lines > 8192) return this.fail('event_overflow');
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); } catch { return this.fail('invalid_json'); }
    if (!object(value)) return this.fail('invalid_event');
    // EventEnvelope flattens ProviderEvent; executor events have no envelope.
    if (!own(value, 'schema_version')) {
      if (['sequence', 'event_id', 'session_id', 'provider', 'provider_sequence', 'request_id'].some(k => own(value, k))) return this.fail('invalid_envelope');
      return this.tool(value);
    }
    if (value.schema_version !== 1 || typeof value.type !== 'string') return this.fail('invalid_event');
    const stream = this.#stream;
    if (!id(value.event_id) || !id(value.session_id) || value.provider !== 'openai-codex'
      || (stream.sessionId !== null && value.session_id !== stream.sessionId)
      || stream.eventIds.has(value.event_id)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.sequence <= stream.sequence
      || (value.provider_sequence != null && (!Number.isSafeInteger(value.provider_sequence) || value.provider_sequence < 0))) return this.fail('invalid_envelope');
    stream.sessionId = value.session_id;
    stream.eventIds.add(value.event_id);
    stream.sequence = value.sequence;
    const e = value;
    if (e.type === 'session_closed') return this.fail('session_closed');
    if (!id(value.request_id)) return this.fail('invalid_identity');
    let r = this.requests.get(value.request_id);
    if (!r) {
      if (this.requests.size === 2) return this.fail('request_overflow');
      const previous = [...this.requests.values()].at(-1);
      if (previous && (previous.terminal !== 1 || previous.terminal_status !== 'completed')) return this.fail('invalid_lifecycle');
      // Even pre-start events prove the next request began before execution finished.
      if (previous && this.which === 'tool'
        && !(this.executorOK && this.started === 1 && this.finished === 1 && this.reused === 0)) return this.fail('invalid_lifecycle');
      r = { events: 0, started: 0, status: 0, terminal: 0, failed: 0, extensions: 0,
        deltas: { text: 0, refusal: 0, reasoning_summary: 0, reasoning_text: 0, function_arguments: 0, custom_tool_input: 0 },
        started_items: emptyCounts(), done_items: emptyCounts(), effective_items: emptyCounts(), native_terminal_items: emptyCounts(),
        output_provenance: 'native_terminal',
        terminal_status: null, effective_text_state: 'no_terminal', lantern_present: null,
        final42_equal: null, call_count: 0, exact_add_numbers_17_25: false };
      this.requests.set(value.request_id, r);
      this.#lifecycle.set(r, { phase: 'ready', responseId: null });
      this.#active = r;
    }
    if (++r.events > 4096) return this.fail('event_overflow');
    const state = this.#lifecycle.get(r);
    if (r !== this.#active || ['terminal', 'failed'].includes(state.phase)) return this.fail('invalid_lifecycle');
    const responseEvent = ['response_status', 'output_item_started', 'output_item_finished', 'output_item_updated', 'response_finished'].includes(e.type);
    if (responseEvent && state.phase !== 'started') return this.fail('invalid_lifecycle');
    if (e.type === 'response_started' || responseEvent) {
      const responseId = e.type === 'response_finished' ? e.response?.id : e.response_id;
      if (!id(responseId) || (own(e, 'response_id') && (!id(e.response_id) || e.response_id !== responseId))) return this.fail('invalid_identity');
      if (e.type === 'response_started') {
        if (state.phase !== 'ready') return this.fail('invalid_lifecycle');
        if ([...this.#lifecycle.values()].some(s => s.responseId === responseId)) return this.fail('invalid_identity');
        if (this.which === 'tool' && this.requests.size === 2
          && !(this.executorOK && this.started === 1 && this.finished === 1 && this.reused === 0)) return this.fail('invalid_lifecycle');
        state.responseId = responseId;
      } else if (responseId !== state.responseId) return this.fail('invalid_identity');
    }
    switch (e.type) {
      case 'response_started':
        state.phase = 'started';
        r.started++;
        break;
      case 'response_status': r.status++; break;
      case 'output_item_started': countItem(r.started_items, e.item); break;
      case 'output_item_finished': countItem(r.done_items, e.item); break;
      case 'output_item_updated':
        if (!own(r.deltas, e.kind) || typeof e.delta !== 'string') return this.fail('invalid_event');
        r.deltas[e.kind]++;
        break;
      case 'provider_extension': r.extensions++; break;
      case 'request_failed': state.phase = 'failed'; r.failed++; break;
      case 'response_finished': {
        const response = e.response;
        if (!object(response) || !Array.isArray(response.output) || response.output.length > 512) return this.fail('invalid_event');
        state.phase = 'terminal';
        r.terminal++;
        r.terminal_status = ['completed', 'incomplete', 'failed', 'cancelled'].includes(response.outcome?.status)
          ? response.outcome.status : 'unknown';
        const provenance = own(response, 'output_provenance') ? response.output_provenance : 'native_terminal';
        if (!['native_terminal', 'validated_output_item_done'].includes(provenance)) return this.fail('invalid_event');
        r.output_provenance = provenance;
        for (const item of response.output) countItem(r.effective_items, item);
        if (Array.isArray(response.native?.output)) {
          for (const item of response.native.output) countItem(r.native_terminal_items, object(item) ? { kind: item.type } : item);
        }
        const text = ordinary(response);
        r.effective_text_state = text.state;
        r.lantern_present = text.lantern ?? null;
        r.final42_equal = text.final42 ?? null;
        const calls = response.output.filter(i => i?.kind === 'function_call');
        r.call_count = calls.length;
        r.exact_add_numbers_17_25 = r.terminal_status === 'completed' && calls.length === 1
          && response.output.every(i => ['message', 'reasoning', 'function_call'].includes(i?.kind)) && exactCall(calls[0]);
        if (this.requests.size === 1 && r.exact_add_numbers_17_25) this.callId = calls[0].function_call.call_id;
        break;
      }
      default: this.fail('invalid_event');
    }
    if (r.started_items.total > 512 || r.done_items.total > 512) this.fail('item_overflow');
  }
  tool(e) {
    if (!['tool_execution_started', 'tool_execution_finished', 'tool_result_reused'].includes(e.type)) return this.fail('invalid_event');
    const first = [...this.requests.values()][0];
    const linked = this.which === 'tool' && first?.terminal === 1 && first.terminal_status === 'completed'
      && this.requests.size === 1
      && this.callId !== null && id(e.call_id) && e.call_id === this.callId && e.tool_name === 'add_numbers';
    this.executorOK &&= linked;
    if (e.type === 'tool_execution_started') {
      this.started++;
      this.executorOK &&= this.started === 1 && this.finished === 0;
    } else if (e.type === 'tool_execution_finished') {
      this.finished++;
      this.executorOK &&= this.finished === 1 && this.started === 1 && e.is_error === false;
    }
    else { this.reused++; this.executorOK = false; }
    if (this.started + this.finished + this.reused > 3) this.fail('event_overflow');
    if (!this.executorOK) this.fail('invalid_executor_lifecycle');
  }
  summary(exit, signal = null, timeLimit = false, cancelled = false) {
    if (this.pending.length) this.fail('truncated_json');
    let publicError = null;
    if (this.stderr.length) {
      try {
        const last = decoder.decode(this.stderr).trimEnd().split('\n').at(-1);
        publicError = errorMap.get(last) ?? 'unclassified';
      } catch { publicError = 'unclassified'; }
    }
    const requests = [...this.requests.values()];
    const complete = requests.length === 2 && requests.every(r => r.started === 1 && r.terminal === 1 && r.failed === 0 && r.terminal_status === 'completed');
    const clean = !this.reason && !signal && !timeLimit && !cancelled;
    const inferredFirstStop = clean && exit === 1 && requests.length === 1 && requests[0].terminal === 1
      && this.started === 0 && this.finished === 0 && this.reused === 0
      && (publicError === 'lifecycle_guard' || (this.which === 'tool' && publicError === 'no_tool' && requests[0].call_count === 0));
    const executor = this.executorOK && this.started === 1 && this.finished === 1 && this.reused === 0;
    const success = clean && exit === 0 && complete && (this.which === 'continuation'
      ? requests.every(r => r.call_count === 0) && requests[1].lantern_present === true
      : requests[0].exact_add_numbers_17_25 && executor && requests[1].final42_equal === true && requests[1].call_count === 0);
    return { schema_version: 1, case: this.which, exit: Number.isInteger(exit) && exit >= 0 && exit <= 255 ? exit : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal) ? signal : signal ? 'other' : null,
      time_limit: timeLimit, cancelled, reason: this.reason, public_error: publicError,
      accounting: { observed_request_ids: requests.length, observed_transport_submissions: null,
        conservative_upper_bound: inferredFirstStop ? 1 : 2,
        basis: inferredFirstStop ? 'inferred_first_response_stop' : complete && clean ? 'complete_cli_events_command_max' : 'uncertain_command_max' },
      requests, executor: { started: this.started, finished: this.finished, reused: this.reused,
        correlated: executor, result42_observed: null,
        result42_validated_by_cli_inferred: this.which === 'tool' && executor && requests.length === 2 },
      assertions_passed: success };
  }
}

// Only production main supplies spawn. Tests supply an in-memory fake child.
export async function run(which, launch = spawn, deadline = 180000, grace = 1000) {
  const evidence = new Evidence(which);
  let child, timeLimit = false, cancelled = false, stopped = false;
  let timer, killTimer, finishTimer;
  return new Promise(resolve => {
    let resolved = false;
    const finish = (exit, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finishTimer);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      resolve(evidence.summary(exit, signal, timeLimit, cancelled));
    };
    const stop = () => {
      if (stopped || resolved) return;
      stopped = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finishTimer = setTimeout(() => {
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          finish(null, 'SIGKILL');
        }, grace);
      }, grace);
    };
    const cancel = () => { cancelled = true; stop(); };
    try { child = launch(GATEWAY, command(which), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch { evidence.fail('spawn_failed'); finish(null, null); return; }
    child.stdout.on('data', chunk => { evidence.data(chunk); if (evidence.reason) stop(); });
    child.stderr.on('data', chunk => { evidence.errorData(chunk); if (evidence.reason) stop(); });
    child.stdout.on('error', () => { evidence.fail('pipe_error'); stop(); });
    child.stderr.on('error', () => { evidence.fail('pipe_error'); stop(); });
    child.on('error', () => { evidence.fail('spawn_failed'); stop(); });
    child.on('close', finish);
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    timer = setTimeout(() => { timeLimit = true; stop(); }, deadline);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    const { selfTest } = await import('./cli_retest.test.mjs');
    const tests = await selfTest();
    console.log(JSON.stringify({ self_test: 'passed', tests, live_started: false }));
    return;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Offline: --help | --self-test. Live (explicit authorization required): --run-live --case continuation|tool. Fixed Codex auth, gpt-6-astra, WebSocket; maximum two submissions; 180-second deadline.');
    return;
  }
  if (args.length !== 3 || args[0] !== '--run-live' || args[1] !== '--case' || !['continuation', 'tool'].includes(args[2])) {
    console.log(JSON.stringify({ error: 'explicit_fixed_case_required', live_started: false }));
    process.exitCode = 2;
    return;
  }
  const summary = await run(args[2]);
  console.log(JSON.stringify(summary));
  process.exitCode = summary.assertions_passed ? 0 : 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.log(JSON.stringify({ error: 'runner_failure', conservative_upper_bound: 2 }));
    process.exitCode = 1;
  });
}
