import { isDeepStrictEqual } from 'node:util';
import { validateTaskCommand } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage, validateDisplayTaskAccepted } from '../dist/display-api.js';
import { parseControl } from './fixture.mjs';

export const TITLE = '  Browser 雪\n<em>title & inert</em>  ';
export const TASKS = ['  Add 17 and 25. 雪\n<em>task & inert</em>\n', 'Add 8 to the previous result. 雪\nSecond explicit task.\n'];
export const ANSWERS = ['42 雪\r\n<em>answer & inert</em>\n', '50 雪\r\nSecond answer.\n'];
export const ARGUMENTS = ['{"a":17,\r\n "b":25}', '{"a":42,\r\n "b":8}'];
export const OUTPUTS = ['{"sum":42}', '{"sum":50}'];
const reject = () => { throw new Error('Client handoff rejected'); };

export function acceptedTask(input, command, sid, task) {
  validateTaskCommand(command);
  if (command.text !== TASKS[task]) reject();
  const value = validateDisplayTaskAccepted(input, { ...command, session_id: sid });
  if (value.duplicate || value.warning_code !== null || value.notices.length !== 0) reject();
  return value.receipt;
}

export function nativeState(input) {
  const { id: _id, ...state } = parseControl(input);
  if (state.event !== 'inspect') reject();
  return state;
}
export function unchangedNative(input, held) {
  if (!isDeepStrictEqual(nativeState(input), held)) reject();
  return true;
}

export function nativeBarrier(input, commands, receipts, gate, completed) {
  const state = nativeState(input), tasks = commands.length;
  if (tasks < 1 || tasks > 2 || (gate === null ? completed !== tasks : ![tasks * 2 - 1, tasks * 2].includes(gate) || completed !== tasks - 1)
    || receipts.length !== tasks || !isDeepStrictEqual(state.receipts, receipts)
    || !isDeepStrictEqual(state.accepted, receipts.map(receipt => ({ run_id: receipt.run_id, accepted_sequence: receipt.first_sequence })))) reject();
  for (const [task, command] of commands.entries()) {
    validateTaskCommand(command);
    if (command.text !== TASKS[task] || receipts[task].operation_id !== command.operation_id || receipts[task].run_id !== command.run_id
      || receipts[task].session_id !== receipts[0].session_id) reject();
  }
  if (new Set(commands.map(c => c.run_id)).size !== tasks || new Set(commands.map(c => c.operation_id)).size !== tasks) reject();
  const requests = gate === null ? tasks * 2 : gate;
  const tools = gate === null ? tasks : Math.floor(gate / 2);
  const counts = [state.gate, state.requests, state.connections, state.auth_loads, state.auth_prepares, state.prepared_exact,
    state.fresh_parents, state.continuations, state.tool_results, state.completed, state.terminals, state.results];
  if (!isDeepStrictEqual(counts, [gate, requests, tasks, tasks, tasks, requests, tasks, tools, tools, completed, completed, completed])
    || !state.fresh_empty || state.restored_history !== (tasks === 2) || state.provider_failed || state.read_failure !== null
    || state.response_finishes.length !== (gate === null ? tasks * 2 : gate - 1)) reject();
  if (tasks === 2 && gate === null && state.provider_stage !== 'finished') reject();
  let priorResponse = 0n;
  for (const response of state.response_finishes) {
    if (response.provenance !== 'native_terminal' || BigInt(response.sequence) <= priorResponse) reject();
    priorResponse = BigInt(response.sequence);
  }
  if (tasks === 2 && BigInt(receipts[1].first_sequence) <= BigInt(state.result_sequences[0])) reject();
  for (let task = 0; task < completed; task++) {
    const response = state.response_finishes[task * 2 + 1].sequence, terminal = state.terminal_sequences[task], result = state.result_sequences[task];
    if (!(BigInt(response) < BigInt(terminal) && BigInt(terminal) < BigInt(result))) reject();
  }
  if (gate === null && state.sequence_count !== state.result_sequences.at(-1)) reject();
  return state;
}

// Constrain the independent public DTO before using it as the DOM oracle.
export function publicProof(input, { sid, head, command, receipt, task, completed, workspace }) {
  const page = validateConversationPage(input, { kind: 'latest' }, sid), block = page.block;
  if (page.snapshot_head !== head || page.session.head_sequence !== head || page.session.title !== TITLE || page.session.workspace !== workspace
    || block === null || block.run_id !== command.run_id || block.accepted_sequence !== receipt.first_sequence
    || block.state !== (completed ? 'completed' : 'running') || block.result_recorded !== completed
    || page.earlier_activity !== null || page.entries.length !== (completed ? 3 : 0)
    || (task === 0 ? page.previous_block !== null : page.previous_block === null)) reject();
  acceptedTask({ api_version: 1, receipt, duplicate: false, warning_code: null, notices: [] }, command, sid, task);
  const cursor = parseDisplayCursor(page.live_after, 'live', sid);
  if (cursor.sequence !== head || cursor.rank !== '3' || cursor.run_id !== '' || cursor.entry_id !== '') reject();
  if (task === 1 && parseDisplayCursor(page.previous_block, 'block', sid).sequence !== receipt.first_sequence) reject();
  if (completed) {
    const summary = block.summary;
    if (!isDeepStrictEqual(block.outcome, { type: 'completed' }) || block.events_complete !== true || block.sink_error !== null || summary === null
      || !isDeepStrictEqual(['turns_started','turns_finished','model_requests_attempted','model_requests_admitted','new_tool_dispatches','tool_results_prepared','reused_results'].map(key => summary[key]), ['2','2','2','2','1','1','0'])
      || summary.last_request_id === null || summary.last_upstream_outcome !== 'terminal_received' || block.revision !== head) reject();
  } else if ([block.outcome, block.summary, block.events_complete, block.sink_error].some(value => value !== null)) reject();
  const entries = [block.human, ...page.entries];
  const facts = [[['text', TASKS[task]]]];
  if (completed) facts.push([['function_name', 'add_numbers'], ['function_arguments', ARGUMENTS[task]]],
    [['tool_name', 'add_numbers'], ['tool_result', OUTPUTS[task]]], [['text', ANSWERS[task]]]);
  let previous = 0n;
  for (const [index, entry] of entries.entries()) {
    const position = BigInt(entry.position.sequence);
    if (position <= previous || position > BigInt(head) || entry.position.slot !== '0' || entry.entry_id !== `e:${entry.position.sequence}:0`
      || entry.run_id !== command.run_id || entry.kind !== ['human','assistant','tool','assistant'][index]
      || entry.recorded_state !== (index === 0 ? 'accepted' : 'completed') || entry.provisional || entry.reference !== null
      || !entry.content_complete || entry.earlier_content !== null || !isDeepStrictEqual(entry.fields.map(field => [field.kind, field.text]), facts[index])) reject();
    if (index === 0 && (entry.entry_id !== `e:${receipt.first_sequence}:0` || entry.fields[0].field_id !== 'text')) reject();
    const flags = ['result_recorded','finish_recorded','is_error'].map(key => entry[key]);
    if (!isDeepStrictEqual(flags, index === 2 ? [true,true,false] : [null,null,null])) reject();
    for (const field of entry.fields) {
      const bytes = String(Buffer.byteLength(field.text));
      if (bytes === '0' || field.from_byte !== '0' || field.to_byte !== bytes || field.total_bytes !== bytes || field.has_earlier || field.has_later) reject();
    }
    previous = position;
  }
  return page;
}

export function allowedRequest(method, url, sid, permission) {
  if (method === 'GET') {
    if (url.pathname === '/v1/settings') return url.search === '';
    if (url.pathname === '/v1/sessions') return true;
    if (sid === undefined) return false;
    const base = `/v1/sessions/${sid}`;
    if (url.pathname === base) return url.search === '';
    if (url.pathname === `${base}/conversation/events`) {
      const params = [...url.searchParams];
      return params.length === 1 && params[0][0] === 'after' && parseDisplayCursor(params[0][1], 'live', sid) !== null;
    }
    if (url.pathname === `${base}/conversation`) {
      if (url.search === '') return true;
      const params = [...url.searchParams];
      return params.length === 1 && params[0][0] === 'before' && parseDisplayCursor(params[0][1], 'block', sid) !== null;
    }
    return false;
  }
  return method === 'POST' && url.search === '' && ((permission === 'create' && url.pathname === '/v1/sessions')
    || (['first','second'].includes(permission) && sid !== undefined && url.pathname === `/v1/sessions/${sid}/runs`));
}

export function handoffOrder(events, contexts, commands, receipts) {
  if (!isDeepStrictEqual(events, ['send-a','gate1-ready','a-closed','b-connected','b-running','drive1','tool1-ready','drive2',
    'b-completed1','send-b','gate3-ready','drive3','tool2-ready','drive4','b-completed2','a-reopened','a-connected','final-parity'])
    || contexts.length !== 3 || new Set(contexts).size !== 3 || commands.length !== 2 || receipts.length !== 2
    || new Set(commands.map(command => command.run_id)).size !== 2 || new Set(receipts.map(receipt => receipt.operation_id)).size !== 2) reject();
  return true;
}
export function strictStop(evidence) {
  if (!evidence || evidence.failure !== null || !evidence.stop.attempted || !evidence.stop.clean_acknowledgment
    || !evidence.stop.reap_complete || !evidence.stop.sandbox_removed || !evidence.stop.exit_observed || evidence.stop.exit_zero !== true
    || evidence.stop.error_latched || !evidence.stop.stderr_empty || evidence.stop.sigterm || evidence.stop.sigkill) reject();
  return true;
}
