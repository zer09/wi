export const sid = '01234567-89ab-4cde-8fab-0123456789ab';
export const otherSid = '11234567-89ab-4cde-8fab-0123456789ab';
export const rid = '21234567-89ab-4cde-8fab-0123456789ab';
export const oid = '31234567-89ab-4cde-8fab-0123456789ab';
export const eid = '41234567-89ab-4cde-8fab-0123456789ab';
export const exactText = '  <script>inert</script>\r\n\t雪🙂e\u0301\u0000\ufeff  ';

// Shapes mirror the public projection in src/http_api/dto, not provider-native objects.
export const receipt = { operation_id: oid, session_id: sid, run_id: null, first_sequence: '1', last_sequence: '1' };
export const taskReceipt = { ...receipt, run_id: rid, first_sequence: '9007199254740993', last_sequence: '9007199254740994' };
export const notice = { scope: 'project', source_label: 'skills/synthetic/SKILL.md', kind: 'skipped_symlink' };
export const error = { api_version: 1, code: 'storage.commit_unknown', stage: 'acceptance', certainty: 'unknown', acceptance: taskReceipt, notices: [notice] };
export const settings = { api_version: 1, workspaces: ['/synthetic/workspace'], provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: true };
export const create = { api_version: 1, session_id: sid, receipt, duplicate: false, warning_code: null };
export const rename = { api_version: 1, receipt, duplicate: true, warning_code: null, catalog_refresh: 'updated' };
export const refresh = { api_version: 1, session_id: sid, disposition: 'unchanged' };
export const accepted = { api_version: 1, receipt: taskReceipt, duplicate: false, warning_code: null, notices: [notice] };
export const cancel = { api_version: 1, session_id: sid, run_id: rid, disposition: 'requested' };
export const session = { api_version: 1, session_id: sid, title: exactText, workspace: null, created_at_ms: '9007199254740993', updated_at_ms: '9223372036854775807', head_sequence: '3', view: 'canonical' };
export const catalog = { session_id: sid, title: exactText, workspace: '/synthetic/workspace', created_at_ms: '0', updated_at_ms: '1', observed_head_sequence: '3', view: 'catalog', availability: 'ready', fault_code: null, last_run_id: rid, last_run_state: 'accepted' };
export const list = { api_version: 1, entries: [catalog], next_after_id: sid, has_more: false };
export const summary = { turns_started: '9007199254740993', turns_finished: '0', model_requests_attempted: '1', model_requests_admitted: '1', new_tool_dispatches: '0', tool_results_prepared: '0', reused_results: '18446744073709551615', last_request_id: null, last_upstream_outcome: 'terminal_received' };
export const outcome = { type: 'failed', code: 'upstream_error' };
export const turnOutcome = { type: 'stopped', reason: outcome };
export const result = { outcome, summary, events_complete: false, sink_error: 'full' };
export const run = { api_version: 1, run_id: rid, state: 'failed', user_text: exactText, accepted_sequence: '9007199254740993', terminal_sequence: '9007199254740994', result_sequence: '9007199254740995', result_recorded: true, result };
export const functionCall = { call_id: 'call', name: 'synthetic', arguments: exactText, origin: 'direct', namespace: null, complete: true };
export const textBlock = { kind: 'text', text: exactText };
export const item = { item_id: 'item', kind: 'message', function_call: null, content: [textBlock, { kind: 'refusal', text: exactText }], unsupported_content: false };
export const usage = { input_tokens: '9007199254740993', output_tokens: '1', total_tokens: '18446744073709551615', cached_input_tokens: null, reasoning_tokens: '0' };
export const responseOutcome = { status: 'incomplete', reason: 'unknown' };
export const response = { response_id: 'response', model: null, outcome: responseOutcome, output_provenance: 'native_terminal', text: exactText, items: [item], usage };
export const closed = { api_version: 1, reason: 'shutdown' };
export const createCommand = { operation_id: oid, title: exactText, workspace: '/synthetic/workspace' };
export const renameCommand = { operation_id: oid, title: exactText };
export const taskCommand = { operation_id: oid, run_id: rid, text: exactText };

export const eventData = {
  'checkpoint': {},
  'session.created': { title: exactText, workspace: null },
  'session.renamed': { title: exactText },
  'run.accepted': { user_text: exactText, provider_id: 'synthetic', model: 'synthetic', available_skills: ['project:synthetic'], active_skills: [] },
  'run.started': {},
  'turn.started': { turn_id: null, number: '18446744073709551615' },
  'turn.finished': { turn_id: 'turn', number: '9007199254740993', response_id: null, outcome: turnOutcome, upstream_outcome: 'unknown' },
  'run.finished': { outcome, summary },
  'tool.started': { call_id: 'call', tool_name: 'synthetic', request_id: null },
  'tool.finished': { call_id: 'call', tool_name: 'synthetic', request_id: 'request', is_error: false },
  'tool.reused': { call_id: 'call', tool_name: 'synthetic', request_id: null },
  'response.started': { response_id: 'response' },
  'response.status': { response_id: 'response', status: 'in_progress' },
  'response.item.started': { response_id: 'response', output_index: '9007199254740993', item },
  'response.item.finished': { response_id: 'response', output_index: '18446744073709551615', item },
  'response.delta': { response_id: 'response', item_id: 'item', output_index: '18446744073709551615', content_index: null, summary_index: '9007199254740993', kind: 'text', delta: exactText },
  'response.finished': response,
  'response.failed': { code: 'upstream_error', upstream_outcome: 'not_submitted' },
  'response.closed': {},
  'tool.result': { call_id: 'call', request_id: null, output: '{"error":"still success"}\r\n雪🙂', is_error: false },
  'run.result': result,
  'run.interrupted': { reason: 'process_restart' },
};
export function event(kind = 'checkpoint', sequence = kind === 'session.created' ? '1' : '2', sessionId = sid) {
  return {
    api_version: 1, session_id: sessionId, sequence, event_id: eid, created_at_ms: '9007199254740993',
    run_id: kind.startsWith('session.') ? null : rid, kind, data: structuredClone(eventData[kind]),
  };
}
export const history = { api_version: 1, session_id: sid, through_sequence: '3', next_after: `${sid}:3`, has_more: false, events: [event('session.created'), event('run.accepted', '2'), event('checkpoint', '3')] };
export function frame(view = event()) {
  return `event: wi.event\nid: ${view.session_id}:${view.sequence}\ndata: ${JSON.stringify(view)}\n\n`;
}
