import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountMismatchProtocol, mismatchEvidence } from './account-mismatch-protocol.mjs';
import { fixedHeadEvidence, fixedHeadProtocol } from './fixed-head-protocol.mjs';
import { unboundEvidence, unboundProtocol } from './unbound-history-protocol.mjs';
import { toolFidelityEvidence, toolFidelityProtocol } from './tool-fidelity-protocol.mjs';
import { lifecycleEvidence, lifecycleFlat, lifecycleProtocol } from './lifecycle-failure-protocol.mjs';
import { cancellationEvidence, cancellationFlat, cancellationProtocol } from './cancellation-protocol.mjs';
import { reconnectEvidence, reconnectProtocol, startScenario } from './read-reconnect-protocol.mjs';

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

export function parseControl(value) {
  if (!object(value) || value.protocol !== 1 || typeof value.event !== 'string') fail();
  const base = ['protocol', 'event'];
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
  } else if (value.event === 'read_reconnect') {
    reconnectEvidence(value);
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
          if (value?.event?.startsWith('cancellation_') || ['ready','stopped'].includes(value?.event)) cancellationFlat(line);
          if (value?.event === 'read_reconnect') reconnectEvidence(line);
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

const bounded = async (promise, ms, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
};

export async function startFixture(executable, scenario) {
  scenario = startScenario(scenario);
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
  const rejectAll = () => {
    error = new Error('fixture child failed');
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
  const reconnect = reconnectProtocol(scenario.read_reconnect === true);
  const parser = stdoutParser(message => {
    reconnect.reply(message);
    cancellation.reply(message);
    lifecycle.reply(message);
    toolFidelity.reply(message);
    fixedHead.reply(message);
    if (scenario.fixed_head !== true) unbound.reply(message);
    acceptanceWarning.reply(message);
    acceptanceUnknown.reply(message);
    accountMismatch.reply(message);
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else {
      if (messages.length >= 32) fail();
      messages.push(message);
    }
  });
  child.stdout.on('data', chunk => { try { parser.push(chunk); } catch { rejectAll(); child.kill('SIGTERM'); } });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 16 * 1024) { rejectAll(); child.kill('SIGTERM'); }
  });
  child.stdin.on('error', rejectAll);
  child.on('error', rejectAll);
  let exitCode;
  const exited = new Promise(resolveExit => child.on('close', code => {
    exitCode = code;
    try { parser.end(); } catch { rejectAll(); }
    if (!closing || code !== 0) rejectAll();
    resolveExit();
  }));
  const wait = async match => {
    if (error) throw error;
    const index = messages.findIndex(match);
    if (index >= 0) return messages.splice(index, 1)[0];
    let waiter;
    try {
      return await bounded(new Promise((resolveMessage, reject) => {
        waiter = { match, resolve: resolveMessage, reject }; waiters.push(waiter);
      }), 20_000, 'fixture control timed out');
    } finally {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    }
  };
  const request = async body => {
    const id = nextId++;
    const command = { ...body, id };
    if ((scenario.read_reconnect === true || scenario.cancellation === true || scenario.lifecycle_failure === true || scenario.tool_fidelity === true || scenario.unbound_history === true || scenario.fixed_head === true || ['arm_acceptance_unknown', 'arm_acceptance_warning', 'rotate_account'].includes(body.command)) && Object.hasOwn(body, 'id')) fail();
    reconnect.request(command);
    cancellation.request(command);
    lifecycle.request(command);
    toolFidelity.request(command);
    fixedHead.request(command);
    unbound.request(command);
    acceptanceWarning.request(command);
    acceptanceUnknown.request(command);
    accountMismatch.request(command);
    if (body.command === 'replay_head') replayHeadRequest(command);
    const reply = wait(message => message.id === id);
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return reply;
  };
  async function stop() {
    if (closing) return;
    closing = true;
    let clean = false;
    try {
      if (exitCode === undefined && !error) {
        clean = (await bounded(request({ command: 'stop' }), 5000, 'fixture stop timed out')).cleaned === true;
      }
    } catch { /* Reap below without forwarding child diagnostics. */ }
    finally {
      child.stdin.end();
      try { await bounded(exited, 5000, 'fixture exit timed out'); }
      catch {
        child.kill('SIGTERM');
        try { await bounded(exited, 2000, 'fixture terminate timed out'); }
        catch { child.kill('SIGKILL'); await bounded(exited, 2000, 'fixture reap timed out'); }
      }
      await rm(sandbox, { recursive: true, force: true });
    }
    if (!clean || exitCode !== 0 || error || stderrBytes !== 0) throw new Error('fixture shutdown failed');
  }
  try {
    if (!['websocket', 'sse'].includes(scenario.transport)) fail();
    // The internal Rust enum uses web_socket; the public SettingsView uses websocket.
    const transport = scenario.transport === 'websocket' ? 'web_socket' : 'sse';
    const ready = await request({ ...scenario, transport, owner });
    if (ready.event !== 'ready') fail();
    return {
      origin: ready.origin, sessionId: ready.session_id, owner, request, stop,
      wait: (event, number) => wait(message => message.event === event && (message.gate ?? message.task) === number),
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
