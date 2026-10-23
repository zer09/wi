// Closed shapes follow src/conversation/wire.rs:164-315 and the shared Rust constructors.
export const SID = '11111111-1111-4111-8111-111111111111';
export const RID = '22222222-2222-4222-8222-222222222222';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const OID = '44444444-4444-4444-8444-444444444444';
export const FID = 'a'.repeat(64), SECOND = 'b'.repeat(64);
export function cursor(kind, ...fields) {
  return `g11${kind}.` + Buffer.from(JSON.stringify([1, SID, ...fields])).toString('base64url');
}
export function order(rank = 2, output = 0n, content = 0n, summary = null) {
  const hex = n => BigInt(n).toString(16).padStart(16, '0');
  const optional = n => n === null ? '0' : '1' + hex(n);
  return [optional(output), hex([0, 1, 1, 2, 3, 4, 5, 6, 7][rank]), optional(summary), optional(content), hex(rank)].join(':');
}
export function field(overrides = {}) {
  return { field_id: FID, order_key: order(), kind: 'text', generation: '4', total_bytes: '3',
    from_byte: '0', to_byte: '3', text: 'abc', has_earlier: false, has_later: false, ...overrides };
}
export function fragment(text, from, total, overrides = {}) {
  const to = BigInt(from) + BigInt(Buffer.byteLength(text));
  return field({ text, from_byte: String(from), to_byte: String(to), total_bytes: String(total),
    has_earlier: BigInt(from) > 0n, has_later: to < BigInt(total), ...overrides });
}
export function entry(overrides = {}) {
  return { run_id: RID, entry_id: 'e:4:0', position: { sequence: '4', slot: '0' }, revision: '4', content_epoch: '4',
    kind: 'assistant', recorded_state: 'in_progress', provisional: true, reference: null,
    result_recorded: null, finish_recorded: null, is_error: null, fields: [field()], earlier_content: null,
    content_complete: true, ...overrides };
}
export function human(overrides = {}) {
  return entry({ entry_id: 'e:2:0', position: { sequence: '2', slot: '0' }, revision: '2', content_epoch: '2',
    kind: 'human', recorded_state: 'accepted', provisional: false,
    fields: [field({ field_id: 'text', order_key: '0', generation: '2', text: 'Task', total_bytes: '4', to_byte: '4' })], ...overrides });
}
export function block(overrides = {}) {
  return { run_id: RID, accepted_sequence: '2', revision: '4', state: 'running', result_recorded: false,
    outcome: null, summary: null, events_complete: null, sink_error: null, human: human(), ...overrides };
}
export function session(head = '4', overrides = {}) {
  return { api_version: 1, session_id: SID, title: 'Synthetic', workspace: '/synthetic/project',
    created_at_ms: '1', updated_at_ms: '2', head_sequence: head, view: 'canonical', ...overrides };
}
export function page(overrides = {}) {
  return { api_version: 1, conversation_version: 1, session_id: SID, snapshot_head: '4', session: session(),
    block: block(), entries: [entry()], earlier_activity: null, previous_block: cursor('b', '2'),
    live_after: cursor('l', '4', '3', '', ''), ...overrides };
}
export function addressed(e = entry(), b = block(), head = '4') {
  return { api_version: 1, conversation_version: 1, session_id: SID, snapshot_head: head, block: b, entry: e };
}
export function batch(changes = [], head = '5', next = cursor('l', head, '3', '', '')) {
  return { api_version: 1, conversation_version: 1, session_id: SID, observed_head: head, changes, next_after: next };
}
export function upsert(e, b = block({ revision: e.revision })) { return { kind: 'entry.upsert', block: b, entry: e }; }
export function reconciliation(state = 'accepted') {
  if (state === 'not_found') return { api_version: 1, state, acceptance: null, run: null };
  return { api_version: 1, state, acceptance: { operation_id: OID, session_id: SID, run_id: RID, first_sequence: '2', last_sequence: '3' },
    run: { api_version: 1, run_id: RID, state: 'running', user_text: 'Task', accepted_sequence: '2',
      terminal_sequence: null, result_sequence: null, result_recorded: false, result: null } };
}
export const command = { session_id: SID, operation_id: OID, run_id: RID, text: 'Task' };
