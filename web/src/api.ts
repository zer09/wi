export type ProtocolErrorCategory =
  | 'invalid_schema' | 'unsupported_version' | 'invalid_json' | 'unexpected_media_type'
  | 'invalid_identity' | 'identity_mismatch' | 'invalid_decimal' | 'invalid_cursor'
  | 'invalid_utf8' | 'invalid_sse' | 'consumer_failed' | 'invalid_token' | 'invalid_request';

// Only static categories cross the diagnostic boundary, never input or exception details.
export class ProtocolError extends Error {
  constructor(readonly category: ProtocolErrorCategory) {
    super(`protocol.${category}`);
    this.name = 'ProtocolError';
  }
}

export type Validator<T> = (value: unknown) => T;
type Shape = Record<string, Validator<unknown>>;
type Fields<S extends Shape> = { readonly [K in keyof S]: ReturnType<S[K]> };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_schema');
  }
  return value as Record<string, unknown>;
}

function object<S extends Shape>(fields: S): Validator<Fields<S>> {
  return value => {
    const input = record(value);
    const keys = Object.keys(fields);
    if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
      throw new ProtocolError('invalid_schema');
    }
    return Object.fromEntries(keys.map(key => [key, fields[key](input[key])])) as Fields<S>;
  };
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new ProtocolError('invalid_schema');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError('invalid_schema');
  return value;
}
function literal<const T extends string | number>(expected: T): Validator<T> {
  return value => {
    if (value !== expected) throw new ProtocolError('invalid_schema');
    return expected;
  };
}
function enumeration<const T extends readonly string[]>(...values: T): Validator<T[number]> {
  return value => {
    if (typeof value !== 'string' || !values.includes(value)) throw new ProtocolError('invalid_schema');
    return value;
  };
}
function nullable<T>(validate: Validator<T>): Validator<T | null> {
  return value => value === null ? null : validate(value);
}
function array<T>(validate: Validator<T>): Validator<readonly T[]> {
  return value => {
    if (!Array.isArray(value)) throw new ProtocolError('invalid_schema');
    return Array.from(value, validate);
  };
}
function tagged<S extends Record<string, Validator<unknown>>>(tag: string, variants: S): Validator<ReturnType<S[keyof S]>> {
  return value => {
    const key = record(value)[tag];
    if (typeof key !== 'string' || !Object.hasOwn(variants, key)) throw new ProtocolError('invalid_schema');
    return variants[key](value) as ReturnType<S[keyof S]>;
  };
}
function version(value: unknown): 1 {
  if (value !== 1) throw new ProtocolError('unsupported_version');
  return 1;
}

export const I64_MAX = 9223372036854775807n;
export const U64_MAX = 18446744073709551615n;

function decimal(value: unknown, max: bigint): string {
  // Reject oversized input before BigInt conversion; this is a representation bound, not a history limit.
  if (typeof value !== 'string' || value.length === 0 || value.length > max.toString().length
    || /[^0-9]/.test(value) || (value.length > 1 && value.startsWith('0')) || BigInt(value) > max) {
    throw new ProtocolError('invalid_decimal');
  }
  return value;
}
export function validateI64(value: unknown): string { return decimal(value, I64_MAX); }
export function validateU64(value: unknown): string { return decimal(value, U64_MAX); }
function positiveSequence(value: unknown): string {
  const sequence = validateI64(value);
  if (sequence === '0') throw new ProtocolError('invalid_decimal');
  return sequence;
}
export function nextSequence(value: unknown): string {
  return validateI64((BigInt(validateI64(value)) + 1n).toString());
}
export function validateUuid(value: unknown): string {
  // Rust accepts any non-nil UUID version, but only its lowercase hyphenated spelling.
  if (typeof value !== 'string' || value.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    || value === '00000000-0000-0000-0000-000000000000') {
    throw new ProtocolError('invalid_identity');
  }
  return value;
}
export interface Cursor { readonly session_id: string; readonly sequence: string }
export function parseCursor(value: unknown): Cursor {
  try {
    if (typeof value !== 'string') throw new ProtocolError('invalid_cursor');
    const parts = value.split(':');
    if (parts.length !== 2) throw new ProtocolError('invalid_cursor');
    return { session_id: validateUuid(parts[0]), sequence: validateI64(parts[1]) };
  } catch {
    throw new ProtocolError('invalid_cursor');
  }
}
export function validateCursor(value: unknown, sessionId: string, head: string = I64_MAX.toString()): Cursor {
  const cursor = parseCursor(value);
  if (cursor.session_id !== validateUuid(sessionId) || BigInt(cursor.sequence) > BigInt(validateI64(head))) {
    throw new ProtocolError('invalid_cursor');
  }
  return cursor;
}
export function cursorFor(sessionId: string, sequence: string): string {
  return `${validateUuid(sessionId)}:${validateI64(sequence)}`;
}

const gatewayCodes = [
  'unauthorized', 'forbidden', 'rate_limited', 'auth_expired', 'auth_account_changed', 'timeout',
  'transport_error', 'unexpected_content_type', 'locally_cancelled', 'slow_consumer', 'unexpected_end',
  'protocol_error', 'provider_error', 'invalid_request', 'output_limit', 'unsupported_output',
  'unsupported_feature', 'http_error', 'gateway_error',
] as const;
const safeCode = enumeration(...gatewayCodes, 'event_sink', 'counter_overflow', 'tool_execution',
  'provider_open', 'provider_request_failed', 'provider_correlation', 'history_identity', 'history_restore', 'upstream_error');
const storageCodes = [
  'storage.invalid_input', 'storage.busy', 'storage.closed', 'storage.not_found', 'storage.unavailable',
  'storage.unsupported_version', 'storage.integrity', 'storage.command_conflict', 'storage.invalid_transition',
  'storage.active_run_exists', 'storage.stale_history', 'storage.catalog_repair_required',
  'storage.creation_incomplete', 'storage.io', 'storage.commit_unknown',
] as const;
const errorCode = enumeration(...gatewayCodes, ...storageCodes,
  'api.unauthorized', 'api.origin_forbidden', 'api.workspace_forbidden', 'api.authority_invalid',
  'api.invalid_request', 'api.cursor_invalid', 'api.body_too_large', 'api.unsupported_media',
  'api.not_found', 'api.method_not_allowed', 'api.worker_lost', 'api.closed',
  'context.invalid_root', 'context.read_failed', 'context.invalid_frontmatter', 'context.duplicate_skill',
  'context.invalid_skill_id', 'context.unknown_skill', 'context.context_changed', 'context.invalid_body',
  'context.invalid_request', 'context.input_too_large');
const cleanupWarning = literal('storage.connection_cleanup_failed');
const taskWarning = enumeration('storage.connection_cleanup_failed', ...gatewayCodes, ...storageCodes);
const runState = enumeration('accepted', 'running', 'completed', 'failed', 'cancelled_locally', 'interrupted');
const upstreamOutcome = enumeration('not_submitted', 'unknown', 'terminal_received');
const responseStatus = enumeration('queued', 'in_progress', 'completed', 'incomplete', 'failed', 'cancelled', 'unknown');
const deltaKind = enumeration('text', 'refusal', 'reasoning_summary', 'reasoning_text', 'function_arguments', 'custom_tool_input');

export const validateNoticeView = object({
  scope: enumeration('global', 'project'), source_label: text,
  kind: enumeration('skipped_symlink', 'directory_name_mismatch', 'unsupported_behavioral_metadata',
    'excluded.invalid_root', 'excluded.read_failed', 'excluded.invalid_frontmatter', 'excluded.duplicate_skill',
    'excluded.invalid_skill_id', 'excluded.unknown_skill', 'excluded.context_changed', 'excluded.invalid_body',
    'excluded.invalid_request', 'excluded.input_too_large'),
});
export type NoticeView = ReturnType<typeof validateNoticeView>;

const receiptFields = {
  operation_id: validateUuid, session_id: validateUuid, run_id: nullable(validateUuid),
  first_sequence: positiveSequence, last_sequence: positiveSequence,
};
const receiptShape = object(receiptFields);
export type ReceiptView = ReturnType<typeof receiptShape>;
function receiptRange<T extends ReceiptView>(receipt: T): T {
  if (BigInt(receipt.first_sequence) > BigInt(receipt.last_sequence)) throw new ProtocolError('invalid_decimal');
  return receipt;
}
export function validateReceiptView(value: unknown): ReceiptView { return receiptRange(receiptShape(value)); }
export interface ReceiptIdentity {
  readonly session_id: string; readonly operation_id: string; readonly run_id: string | null;
}
export function validateReceiptIdentity(value: unknown, expected: ReceiptIdentity): ReceiptView {
  const receipt = validateReceiptView(value);
  if (receipt.session_id !== validateUuid(expected.session_id) || receipt.operation_id !== validateUuid(expected.operation_id)
    || receipt.run_id !== nullable(validateUuid)(expected.run_id)) throw new ProtocolError('identity_mismatch');
  return receipt;
}
function taskReceipt(value: unknown): ReceiptView {
  const receipt = validateReceiptView(value);
  if (receipt.run_id === null || BigInt(receipt.last_sequence) !== BigInt(receipt.first_sequence) + 1n) {
    throw new ProtocolError('identity_mismatch');
  }
  return receipt;
}
function metadataReceipt(value: unknown): ReceiptView {
  const receipt = validateReceiptView(value);
  if (receipt.run_id !== null || receipt.first_sequence !== receipt.last_sequence) throw new ProtocolError('identity_mismatch');
  return receipt;
}
// OperationView uses serde(flatten), unlike mutation responses with a nested receipt.
const operationShape = object({ api_version: version, ...receiptFields });
export type OperationView = ReturnType<typeof operationShape>;
export function validateOperationView(value: unknown): OperationView { return receiptRange(operationShape(value)); }

export const validateErrorView = object({
  api_version: version, code: errorCode,
  stage: nullable(enumeration('lookup', 'preflight', 'history', 'acceptance', 'provider_binding', 'runtime_event', 'tool_result', 'final_result')),
  certainty: enumeration('not_applicable', 'not_committed', 'unknown'),
  acceptance: nullable(validateReceiptView), notices: array(validateNoticeView),
});
export type ErrorView = ReturnType<typeof validateErrorView>;
export const validateSettingsView = object({
  api_version: version, workspaces: array(text), provider_id: text, model: text,
  provider_transport: enumeration('websocket', 'sse'), enable_add_numbers: boolean,
});
export type SettingsView = ReturnType<typeof validateSettingsView>;
const mutationFields = {
  api_version: version, receipt: metadataReceipt, duplicate: boolean, warning_code: nullable(cleanupWarning),
};
const createShape = object({ ...mutationFields, session_id: validateUuid });
export type CreateView = ReturnType<typeof createShape>;
export function validateCreateView(value: unknown): CreateView {
  const created = createShape(value);
  if (created.session_id !== created.receipt.session_id) throw new ProtocolError('identity_mismatch');
  return created;
}
export const validateRenameView = object({
  ...mutationFields, catalog_refresh: enumeration('updated', 'unchanged', 'not_attempted', 'failed'),
});
export type RenameView = ReturnType<typeof validateRenameView>;
export const validateRefreshView = object({
  api_version: version, session_id: validateUuid, disposition: enumeration('updated', 'unchanged'),
});
export type RefreshView = ReturnType<typeof validateRefreshView>;
export const validateTaskAcceptedView = object({
  ...mutationFields, receipt: taskReceipt, warning_code: nullable(taskWarning), notices: array(validateNoticeView),
});
export type TaskAcceptedView = ReturnType<typeof validateTaskAcceptedView>;
export const validateCancelView = object({
  api_version: version, session_id: validateUuid, run_id: validateUuid, disposition: enumeration('requested', 'not_tracked'),
});
export type CancelView = ReturnType<typeof validateCancelView>;

const sessionFields = {
  session_id: validateUuid, title: text, workspace: nullable(text), created_at_ms: validateI64, updated_at_ms: validateI64,
};
export const validateSessionView = object({
  api_version: version, ...sessionFields, head_sequence: positiveSequence, view: literal('canonical'),
});
export type SessionView = ReturnType<typeof validateSessionView>;
// CatalogEntryView is flat, but has neither api_version nor a canonical head_sequence.
const catalogShape = object({
  ...sessionFields, observed_head_sequence: validateI64, view: literal('catalog'),
  availability: enumeration('creating', 'ready', 'missing', 'unavailable'), fault_code: nullable(enumeration(...storageCodes)),
  last_run_id: nullable(validateUuid), last_run_state: nullable(runState),
});
export type CatalogEntryView = ReturnType<typeof catalogShape>;
export function validateCatalogEntryView(value: unknown): CatalogEntryView {
  const entry = catalogShape(value);
  if ((entry.last_run_id === null) !== (entry.last_run_state === null)
    || ((entry.availability === 'ready' || entry.availability === 'creating') && entry.fault_code !== null)
    || (entry.availability === 'ready' && entry.observed_head_sequence === '0')) throw new ProtocolError('invalid_schema');
  return entry;
}
export const validateSessionListView = object({
  api_version: version, entries: array(validateCatalogEntryView), next_after_id: nullable(validateUuid), has_more: boolean,
});
export type SessionListView = ReturnType<typeof validateSessionListView>;

export const validateOutcomeView = tagged('type', {
  completed: object({ type: literal('completed') }),
  cancelled_locally: object({ type: literal('cancelled_locally') }),
  failed: object({ type: literal('failed'), code: safeCode }),
});
export type OutcomeView = ReturnType<typeof validateOutcomeView>;
export const validateTurnOutcomeView = tagged('type', {
  model_completed: object({ type: literal('model_completed') }),
  tools_prepared: object({ type: literal('tools_prepared') }),
  stopped: object({ type: literal('stopped'), reason: validateOutcomeView }),
});
export type TurnOutcomeView = ReturnType<typeof validateTurnOutcomeView>;
export const validateSummaryView = object({
  turns_started: validateU64, turns_finished: validateU64, model_requests_attempted: validateU64,
  model_requests_admitted: validateU64, new_tool_dispatches: validateU64, tool_results_prepared: validateU64,
  reused_results: validateU64, last_request_id: nullable(text), last_upstream_outcome: nullable(upstreamOutcome),
});
export type SummaryView = ReturnType<typeof validateSummaryView>;
export const validateResultView = object({
  outcome: validateOutcomeView, summary: validateSummaryView, events_complete: boolean,
  sink_error: nullable(enumeration('full', 'closed', 'failed')),
});
export type ResultView = ReturnType<typeof validateResultView>;
const runShape = object({
  api_version: version, run_id: validateUuid, state: runState, user_text: text,
  accepted_sequence: positiveSequence, terminal_sequence: nullable(positiveSequence), result_sequence: nullable(positiveSequence),
  result_recorded: boolean, result: nullable(validateResultView),
});
export type RunView = ReturnType<typeof runShape>;
export function validateRunView(value: unknown): RunView {
  const run = runShape(value);
  const active = run.state === 'accepted' || run.state === 'running';
  if (active !== (run.terminal_sequence === null)
    || run.result_recorded !== (run.result !== null)
    || run.result_recorded !== (run.result_sequence !== null)) throw new ProtocolError('invalid_schema');
  if (run.terminal_sequence !== null && BigInt(run.terminal_sequence) <= BigInt(run.accepted_sequence)) {
    throw new ProtocolError('invalid_schema');
  }
  if (run.result !== null && run.result_sequence !== null) {
    if (run.terminal_sequence === null || run.result.outcome.type !== run.state
      || BigInt(run.result_sequence) < BigInt(run.terminal_sequence)) throw new ProtocolError('invalid_schema');
    // A result supplies its own terminal record only when runtime event recording was incomplete.
    if (run.result_sequence === run.terminal_sequence && run.result.events_complete) throw new ProtocolError('invalid_schema');
  }
  return run;
}

export const validateFunctionCallView = object({
  call_id: text, name: text, arguments: text, origin: enumeration('direct', 'programmatic', 'unknown'),
  namespace: nullable(text), complete: boolean,
});
export type FunctionCallView = ReturnType<typeof validateFunctionCallView>;
export const validateTextBlockView = object({ kind: enumeration('text', 'refusal', 'reasoning_summary', 'reasoning_text'), text });
export type TextBlockView = ReturnType<typeof validateTextBlockView>;
const itemShape = object({
  item_id: nullable(text),
  kind: enumeration('message', 'reasoning', 'function_call', 'custom_tool_call', 'tool_search_call', 'tool_search_output', 'program', 'program_output', 'unknown'),
  function_call: nullable(validateFunctionCallView), content: array(validateTextBlockView), unsupported_content: boolean,
});
export type ItemView = ReturnType<typeof itemShape>;
export function validateItemView(value: unknown): ItemView {
  const item = itemShape(value);
  switch (item.kind) {
    case 'message':
      if (item.function_call !== null || item.content.some(block => block.kind !== 'text' && block.kind !== 'refusal')) {
        throw new ProtocolError('invalid_schema');
      }
      break;
    case 'reasoning':
      if (item.function_call !== null || item.content.some(block => block.kind !== 'reasoning_summary' && block.kind !== 'reasoning_text')) {
        throw new ProtocolError('invalid_schema');
      }
      break;
    case 'function_call':
      if (item.content.length !== 0 || item.unsupported_content !== (item.function_call === null)) throw new ProtocolError('invalid_schema');
      break;
    default:
      if (item.function_call !== null || item.content.length !== 0 || !item.unsupported_content) throw new ProtocolError('invalid_schema');
  }
  return item;
}
export const validateResponseOutcomeView = tagged('status', {
  completed: object({ status: literal('completed') }),
  incomplete: object({ status: literal('incomplete'), reason: nullable(enumeration('max_output_tokens', 'content_filter', 'unknown')) }),
  failed: object({ status: literal('failed') }),
  cancelled: object({ status: literal('cancelled') }),
});
export type ResponseOutcomeView = ReturnType<typeof validateResponseOutcomeView>;
export const validateUsageView = object({
  input_tokens: validateU64, output_tokens: validateU64, total_tokens: validateU64,
  cached_input_tokens: nullable(validateU64), reasoning_tokens: nullable(validateU64),
});
export type UsageView = ReturnType<typeof validateUsageView>;
export const validateResponseView = object({
  response_id: text, model: nullable(text), outcome: validateResponseOutcomeView,
  output_provenance: enumeration('native_terminal', 'validated_output_item_done'), text, items: array(validateItemView), usage: nullable(validateUsageView),
});
export type ResponseView = ReturnType<typeof validateResponseView>;

const toolFields = { call_id: text, tool_name: text, request_id: nullable(text) };
const itemFields = { response_id: text, output_index: validateU64, item: validateItemView };
const eventData = {
  checkpoint: object({}),
  'session.created': object({ title: text, workspace: nullable(text) }),
  'session.renamed': object({ title: text }),
  'run.accepted': object({ user_text: text, provider_id: text, model: text, available_skills: array(text), active_skills: array(text) }),
  'run.started': object({}),
  'turn.started': object({ turn_id: nullable(text), number: validateU64 }),
  'turn.finished': object({ turn_id: nullable(text), number: validateU64, response_id: nullable(text), outcome: validateTurnOutcomeView, upstream_outcome: nullable(upstreamOutcome) }),
  'run.finished': object({ outcome: validateOutcomeView, summary: validateSummaryView }),
  'tool.started': object(toolFields),
  'tool.finished': object({ ...toolFields, is_error: boolean }),
  'tool.reused': object(toolFields),
  'response.started': object({ response_id: text }),
  'response.status': object({ response_id: text, status: responseStatus }),
  'response.item.started': object(itemFields),
  'response.item.finished': object(itemFields),
  'response.delta': object({ response_id: text, item_id: text, output_index: validateU64, content_index: nullable(validateU64), summary_index: nullable(validateU64), kind: deltaKind, delta: text }),
  'response.finished': validateResponseView,
  'response.failed': object({ code: safeCode, upstream_outcome: upstreamOutcome }),
  'response.closed': object({}),
  'tool.result': object({ call_id: text, request_id: nullable(text), output: text, is_error: boolean }),
  'run.result': validateResultView,
  'run.interrupted': object({ reason: literal('process_restart') }),
};
export type EventKind = keyof typeof eventData;
const eventShape = object({
  api_version: version, session_id: validateUuid, sequence: positiveSequence, event_id: validateUuid,
  created_at_ms: validateI64, run_id: nullable(validateUuid), kind: text, data: (value: unknown) => value,
});
export type EventView = {
  [K in EventKind]: Omit<ReturnType<typeof eventShape>, 'kind' | 'data'> & {
    readonly kind: K; readonly data: ReturnType<(typeof eventData)[K]>;
  }
}[EventKind];
export function validateEventView(value: unknown): EventView {
  const event = eventShape(value);
  if (!Object.hasOwn(eventData, event.kind)) throw new ProtocolError('invalid_schema');
  const kind = event.kind as EventKind;
  if ((event.sequence === '1') !== (kind === 'session.created')) throw new ProtocolError('invalid_schema');
  const metadata = kind === 'session.created' || kind === 'session.renamed';
  if ((event.run_id === null) !== metadata) throw new ProtocolError('identity_mismatch');
  return { ...event, kind, data: eventData[kind](event.data) } as EventView;
}
const historyShape = object({
  api_version: version, session_id: validateUuid, through_sequence: validateI64, next_after: text,
  has_more: boolean, events: array(validateEventView),
});
export type HistoryView = ReturnType<typeof historyShape>;
export function validateHistoryView(value: unknown): HistoryView {
  const page = historyShape(value);
  validateCursor(page.next_after, page.session_id, page.through_sequence);
  for (const event of page.events) {
    if (event.session_id !== page.session_id) throw new ProtocolError('identity_mismatch');
    if (BigInt(event.sequence) > BigInt(page.through_sequence)) throw new ProtocolError('invalid_cursor');
  }
  return page;
}
export const validateClosedView = object({ api_version: version, reason: literal('shutdown') });
export type ClosedView = ReturnType<typeof validateClosedView>;

export function requireMediaType(value: unknown, expected: 'application/json' | 'text/event-stream'): void {
  if (typeof value !== 'string' || /[^\t\x20-\x7e]/.test(value)) throw new ProtocolError('unexpected_media_type');
  const parts = value.split(';');
  if (parts.length > 2 || parts[0].trim().toLowerCase() !== expected) throw new ProtocolError('unexpected_media_type');
  if (parts.length === 2) {
    const parameter = parts[1].trim().toLowerCase();
    if (!/^charset\s*=\s*(?:utf-8|"utf-8")$/.test(parameter)) throw new ProtocolError('unexpected_media_type');
  }
}
export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new ProtocolError('invalid_json');
  try { return JSON.parse(value) as unknown; } catch { throw new ProtocolError('invalid_json'); }
}
export function decodeJson<T>(body: unknown, contentType: unknown, validate: Validator<T>): T {
  requireMediaType(contentType, 'application/json');
  return validate(parseJson(body));
}

export const validateCreateCommand = object({ operation_id: validateUuid, title: text, workspace: text });
export type CreateCommand = ReturnType<typeof validateCreateCommand>;
export const validateRenameCommand = object({ operation_id: validateUuid, title: text });
export type RenameCommand = ReturnType<typeof validateRenameCommand>;
export const validateTaskCommand = object({ operation_id: validateUuid, run_id: validateUuid, text });
export type TaskCommand = ReturnType<typeof validateTaskCommand>;
export type ApiCommand =
  | { readonly kind: 'create'; readonly body: CreateCommand }
  | { readonly kind: 'rename'; readonly body: RenameCommand }
  | { readonly kind: 'task'; readonly body: TaskCommand }
  | { readonly kind: 'refresh' | 'cancel' };
export type ApiRoute =
  | { readonly kind: 'settings' | 'create' }
  | { readonly kind: 'sessions'; readonly after_id?: string }
  | { readonly kind: 'session' | 'rename' | 'refresh' | 'task'; readonly session_id: string }
  | { readonly kind: 'history'; readonly session_id: string; readonly after: string; readonly through?: string }
  | { readonly kind: 'events'; readonly session_id: string; readonly after: string }
  | { readonly kind: 'run' | 'cancel'; readonly session_id: string; readonly run_id: string }
  | { readonly kind: 'operation'; readonly session_id: string; readonly operation_id: string };

// Root-relative paths plus mode:same-origin avoid accepting a backend URL from input.
export function apiPath(route: ApiRoute): string {
  switch (route.kind) {
    case 'settings': return '/v1/settings';
    case 'create': return '/v1/sessions';
    case 'sessions': {
      let path = '/v1/sessions?limit=32';
      if (route.after_id !== undefined) path += `&after_id=${validateUuid(route.after_id)}`;
      return path;
    }
  }
  const base = `/v1/sessions/${validateUuid(route.session_id)}`;
  switch (route.kind) {
    case 'session': return base;
    case 'rename': return `${base}/rename`;
    case 'refresh': return `${base}/refresh`;
    case 'task': return `${base}/runs`;
    case 'run': return `${base}/runs/${validateUuid(route.run_id)}`;
    case 'cancel': return `${base}/runs/${validateUuid(route.run_id)}/cancel`;
    case 'operation': return `${base}/operations/${validateUuid(route.operation_id)}`;
    case 'history': {
      validateCursor(route.after, route.session_id, route.through);
      let path = `${base}/history?after=${encodeURIComponent(route.after)}&limit=32`;
      if (route.through !== undefined) path += `&through=${validateI64(route.through)}`;
      return path;
    }
    case 'events':
      validateCursor(route.after, route.session_id);
      return `${base}/events?after=${encodeURIComponent(route.after)}`;
    default: throw new ProtocolError('invalid_request');
  }
}
export function readRequestInit(token: unknown, media: 'application/json' | 'text/event-stream' = 'application/json'): RequestInit {
  if (typeof token !== 'string' || token.length !== 64 || /[^0-9a-f]/.test(token)) throw new ProtocolError('invalid_token');
  if (media !== 'application/json' && media !== 'text/event-stream') throw new ProtocolError('unexpected_media_type');
  return {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: media },
    credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer',
  };
}
export function jsonRequestInit(token: unknown, command: ApiCommand): RequestInit {
  const init = readRequestInit(token);
  let body: CreateCommand | RenameCommand | TaskCommand | Record<string, never>;
  switch (command.kind) {
    case 'create': body = validateCreateCommand(command.body); break;
    case 'rename': body = validateRenameCommand(command.body); break;
    case 'task': body = validateTaskCommand(command.body); break;
    case 'refresh': case 'cancel': body = {}; break;
    default: throw new ProtocolError('invalid_request');
  }
  return { ...init, method: 'POST', headers: { ...init.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
