import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../dist/api.js';
import * as f from './wire-fixtures.mjs';

function rejects(action, category) {
  assert.throws(action, error => {
    assert.ok(error instanceof api.ProtocolError);
    if (category !== undefined) assert.equal(error.category, category);
    assert.equal(error.message, `protocol.${error.category}`);
    assert.equal(error.cause, undefined);
    return true;
  });
}
function at(object, path) { return path.reduce((value, key) => value[key], object); }
function paths(value, path = []) {
  const found = [path];
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) found.push(...paths(value[key], [...path, key]));
  }
  return found;
}
function validateClosedShape(validate, fixture) {
  const original = structuredClone(fixture);
  assert.deepEqual(validate(fixture), fixture);
  assert.deepEqual(fixture, original);
  for (const path of paths(fixture)) {
    const value = at(fixture, path);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const extra = structuredClone(fixture);
      at(extra, path).unknown_private_field = 'synthetic-canary';
      rejects(() => validate(extra));
      for (const key of Object.keys(value)) {
        const missing = structuredClone(fixture);
        delete at(missing, path)[key];
        rejects(() => validate(missing));
        const undefinedField = structuredClone(fixture);
        at(undefinedField, path)[key] = undefined;
        rejects(() => validate(undefinedField));
      }
    }
    const wrongType = structuredClone(fixture);
    const replacement = value !== null && typeof value === 'object' && !Array.isArray(value) ? [] : {};
    if (path.length === 0) rejects(() => validate(replacement));
    else {
      at(wrongType, path.slice(0, -1))[path.at(-1)] = replacement;
      rejects(() => validate(wrongType));
    }
  }
  rejects(() => validate(null));
  rejects(() => validate([]));
  rejects(() => validate('synthetic-canary'));
}

const dtos = [
  ['SettingsView', f.settings], ['ReceiptView', f.receipt], ['OperationView', { api_version: 1, ...f.taskReceipt }],
  ['NoticeView', f.notice], ['ErrorView', f.error], ['CreateView', f.create], ['RenameView', f.rename],
  ['RefreshView', f.refresh], ['TaskAcceptedView', f.accepted], ['CancelView', f.cancel],
  ['SessionView', f.session], ['CatalogEntryView', f.catalog], ['SessionListView', f.list],
  ['OutcomeView', f.outcome], ['TurnOutcomeView', f.turnOutcome], ['SummaryView', f.summary],
  ['ResultView', f.result], ['RunView', f.run], ['FunctionCallView', f.functionCall], ['TextBlockView', f.textBlock],
  ['ItemView', f.item], ['ResponseOutcomeView', f.responseOutcome], ['UsageView', f.usage], ['ResponseView', f.response],
  ['HistoryView', f.history], ['ClosedView', f.closed], ['CreateCommand', f.createCommand],
  ['RenameCommand', f.renameCommand], ['TaskCommand', f.taskCommand],
];
for (const [name, fixture] of dtos) {
  test(`${name}: exact recursive fields, types, omissions and unchanged strings`, () => {
    validateClosedShape(api[`validate${name}`], fixture);
  });
}
for (const kind of Object.keys(f.eventData)) {
  test(`EventView ${kind}: exact recursive public shape`, () => {
    const fixture = f.event(kind);
    validateClosedShape(api.validateEventView, fixture);
    assert.equal(api.validateEventView(fixture).sequence, kind === 'session.created' ? '1' : '2');
  });
}

test('version 1 is required on every versioned DTO and every history event', () => {
  for (const [name, fixture] of [...dtos, ['EventView', f.event()]]) {
    if (!Object.hasOwn(fixture, 'api_version')) continue;
    for (const api_version of [0, 2, '1', null, true, 1.5]) {
      rejects(() => api[`validate${name}`]({ ...fixture, api_version }), 'unsupported_version');
    }
  }
  const history = structuredClone(f.history);
  history.events[1].api_version = 2;
  rejects(() => api.validateHistoryView(history), 'unsupported_version');
});

test('Rust flat operation/error/catalog and canonical session reject invented envelopes and head fields', () => {
  rejects(() => api.validateOperationView({ api_version: 1, receipt: f.receipt }));
  rejects(() => api.validateErrorView({ api_version: 1, error: f.error }));
  rejects(() => api.validateSessionView({ api_version: 1, session: f.session }));
  rejects(() => api.validateCatalogEntryView({ ...f.catalog, head_sequence: '3' }));
  rejects(() => api.validateCatalogEntryView({ ...f.catalog, api_version: 1 }));
  rejects(() => api.validateSessionView({ ...f.session, view: 'catalog' }));
  rejects(() => api.validateCatalogEntryView({ ...f.catalog, view: 'canonical' }));
});

test('all source nullable fields accept explicit null but not omission', () => {
  const nullableCases = [
    ['ReceiptView', f.receipt, ['run_id']], ['ErrorView', f.error, ['stage', 'acceptance']],
    ['CreateView', f.create, ['warning_code']], ['RenameView', f.rename, ['warning_code']],
    ['TaskAcceptedView', f.accepted, ['warning_code']], ['SessionView', f.session, ['workspace']],
    ['CatalogEntryView', { ...f.catalog, last_run_id: null, last_run_state: null }, ['workspace', 'fault_code', 'last_run_id', 'last_run_state']],
    ['SessionListView', f.list, ['next_after_id']], ['SummaryView', f.summary, ['last_request_id', 'last_upstream_outcome']],
    ['RunView', { ...f.run, state: 'accepted', terminal_sequence: null, result_sequence: null, result_recorded: false, result: null }, ['terminal_sequence', 'result_sequence', 'result']],
    ['ResultView', f.result, ['sink_error']],
    ['FunctionCallView', f.functionCall, ['namespace']], ['ItemView', f.item, ['item_id', 'function_call']],
    ['ResponseOutcomeView', f.responseOutcome, ['reason']], ['UsageView', f.usage, ['cached_input_tokens', 'reasoning_tokens']],
    ['ResponseView', f.response, ['model', 'usage']],
  ];
  for (const [name, fixture, keys] of nullableCases) {
    const validate = api[`validate${name}`];
    for (const key of keys) {
      const value = { ...fixture, [key]: null };
      assert.equal(validate(value)[key], null);
      delete value[key];
      rejects(() => validate(value));
    }
  }
  for (const kind of ['turn.started', 'turn.finished', 'tool.started', 'tool.finished', 'tool.reused', 'response.delta', 'tool.result']) {
    const value = f.event(kind);
    for (const key of ['turn_id', 'response_id', 'request_id', 'content_index', 'summary_index']) {
      if (!Object.hasOwn(value.data, key)) continue;
      if (kind === 'response.delta' && key === 'response_id') continue;
      const copy = structuredClone(value);
      copy.data[key] = null;
      assert.equal(api.validateEventView(copy).data[key], null);
      delete copy.data[key];
      rejects(() => api.validateEventView(copy));
    }
  }
  for (const [name, fixture, key] of [['SettingsView', f.settings, 'model'], ['CreateCommand', f.createCommand, 'workspace'], ['TaskCommand', f.taskCommand, 'text']]) {
    rejects(() => api[`validate${name}`]({ ...fixture, [key]: null }));
  }
});

const enums = [
  ['transport', api.validateSettingsView, f.settings, ['provider_transport'], ['websocket', 'sse']],
  ['refresh', api.validateRefreshView, f.refresh, ['disposition'], ['updated', 'unchanged']],
  ['rename refresh', api.validateRenameView, f.rename, ['catalog_refresh'], ['updated', 'unchanged', 'not_attempted', 'failed']],
  ['cancel', api.validateCancelView, f.cancel, ['disposition'], ['requested', 'not_tracked']],
  ['catalog availability', api.validateCatalogEntryView, f.catalog, ['availability'], ['creating', 'ready', 'missing', 'unavailable']],
  ['catalog run state', api.validateCatalogEntryView, f.catalog, ['last_run_state'], ['accepted', 'running', 'completed', 'failed', 'cancelled_locally', 'interrupted']],
  ['certainty', api.validateErrorView, f.error, ['certainty'], ['not_applicable', 'not_committed', 'unknown']],
  ['stage', api.validateErrorView, f.error, ['stage'], ['lookup', 'preflight', 'history', 'acceptance', 'provider_binding', 'runtime_event', 'tool_result', 'final_result']],
  ['scope', api.validateNoticeView, f.notice, ['scope'], ['global', 'project']],
  ['notice kind', api.validateNoticeView, f.notice, ['kind'], ['skipped_symlink', 'directory_name_mismatch', 'unsupported_behavioral_metadata', ...['invalid_root', 'read_failed', 'invalid_frontmatter', 'duplicate_skill', 'invalid_skill_id', 'unknown_skill', 'context_changed', 'invalid_body', 'invalid_request', 'input_too_large'].map(kind => `excluded.${kind}`)]],
  ['upstream outcome', api.validateSummaryView, f.summary, ['last_upstream_outcome'], ['not_submitted', 'unknown', 'terminal_received']],
  ['sink error', api.validateResultView, f.result, ['sink_error'], ['full', 'closed', 'failed']],
  ['call origin', api.validateFunctionCallView, f.functionCall, ['origin'], ['direct', 'programmatic', 'unknown']],
  ['text block', api.validateTextBlockView, f.textBlock, ['kind'], ['text', 'refusal', 'reasoning_summary', 'reasoning_text']],
  ['incomplete reason', api.validateResponseOutcomeView, f.responseOutcome, ['reason'], ['max_output_tokens', 'content_filter', 'unknown']],
  ['provenance', api.validateResponseView, f.response, ['output_provenance'], ['native_terminal', 'validated_output_item_done']],
  ['response status', api.validateEventView, f.event('response.status'), ['data', 'status'], ['queued', 'in_progress', 'completed', 'incomplete', 'failed', 'cancelled', 'unknown']],
  ['delta kind', api.validateEventView, f.event('response.delta'), ['data', 'kind'], ['text', 'refusal', 'reasoning_summary', 'reasoning_text', 'function_arguments', 'custom_tool_input']],
  ['interruption', api.validateEventView, f.event('run.interrupted'), ['data', 'reason'], ['process_restart']],
];
for (const [name, validate, fixture, path, values] of enums) {
  test(`closed enum ${name}: every Rust spelling and unknown rejection`, () => {
    for (const value of values) {
      const copy = structuredClone(fixture);
      at(copy, path.slice(0, -1))[path.at(-1)] = value;
      assert.equal(at(validate(copy), path), value);
    }
    for (const value of ['new_protocol_variant', 'CancelledLocally', '', 1, {}]) {
      const copy = structuredClone(fixture);
      at(copy, path.slice(0, -1))[path.at(-1)] = value;
      rejects(() => validate(copy));
    }
  });
}

test('RunView accepts every state with producer-correlated terminal and result fields', () => {
  for (const state of ['accepted', 'running', 'completed', 'failed', 'cancelled_locally', 'interrupted']) {
    const terminal_sequence = state === 'accepted' || state === 'running' ? null : f.run.terminal_sequence;
    const value = { ...f.run, state, terminal_sequence, result_sequence: null, result_recorded: false, result: null };
    validateClosedShape(api.validateRunView, value);
  }
  for (const state of ['new_protocol_variant', 'CancelledLocally', '', 1, {}]) {
    rejects(() => api.validateRunView({ ...f.run, state }), 'invalid_schema');
  }
  for (const outcome of [{ type: 'completed' }, f.outcome, { type: 'cancelled_locally' }]) {
    for (const [accepted_sequence, terminal_sequence, later_sequence] of [
      ['2', '10', '11'],
      ['9007199254740992', '9007199254740993', '9007199254740994'],
      ['9223372036854775805', '9223372036854775806', '9223372036854775807'],
    ]) {
      for (const [result_sequence, events_complete] of [[terminal_sequence, false], [later_sequence, false], [later_sequence, true]]) {
        const value = {
          ...f.run, state: outcome.type, accepted_sequence, terminal_sequence, result_sequence,
          result: { ...f.result, outcome, events_complete },
        };
        assert.deepEqual(api.validateRunView(value), value);
      }
    }
  }
});

test('RunView rejects state/terminal and terminal/acceptance contradictions', () => {
  const withoutResult = { ...f.run, result_recorded: false, result_sequence: null, result: null };
  for (const state of ['accepted', 'running']) {
    rejects(() => api.validateRunView({ ...withoutResult, state }), 'invalid_schema');
  }
  for (const state of ['completed', 'failed', 'cancelled_locally', 'interrupted']) {
    rejects(() => api.validateRunView({ ...withoutResult, state, terminal_sequence: null }), 'invalid_schema');
  }
  for (const terminal_sequence of ['9007199254740992', f.run.accepted_sequence]) {
    rejects(() => api.validateRunView({ ...withoutResult, terminal_sequence }), 'invalid_schema');
  }
});

test('RunView rejects inconsistent result presence and results without terminals', () => {
  for (const result_recorded of [false, true]) {
    for (const result of [null, f.result]) {
      for (const result_sequence of [null, f.run.result_sequence]) {
        if (result_recorded === (result !== null) && result_recorded === (result_sequence !== null)) continue;
        rejects(() => api.validateRunView({ ...f.run, result_recorded, result, result_sequence }), 'invalid_schema');
      }
    }
  }
  for (const state of ['accepted', 'running']) {
    rejects(() => api.validateRunView({ ...f.run, state, terminal_sequence: null }), 'invalid_schema');
  }
});

test('RunView rejects mismatched result outcomes, interrupted results and impossible result order', () => {
  for (const state of ['completed', 'failed', 'cancelled_locally', 'interrupted']) {
    for (const outcome of [{ type: 'completed' }, f.outcome, { type: 'cancelled_locally' }]) {
      if (state === outcome.type) continue;
      rejects(() => api.validateRunView({ ...f.run, state, result: { ...f.result, outcome } }), 'invalid_schema');
    }
  }
  for (const value of [
    { ...f.run, result_sequence: f.run.accepted_sequence },
    { ...f.run, accepted_sequence: '2', terminal_sequence: '10', result_sequence: '9' },
    { ...f.run, accepted_sequence: '9007199254740991', terminal_sequence: '9007199254740993', result_sequence: '9007199254740992' },
    { ...f.run, result_sequence: f.run.terminal_sequence, result: { ...f.result, events_complete: true } },
  ]) rejects(() => api.validateRunView(value), 'invalid_schema');
});

test('tagged outcome unions accept every variant and reject fields from another variant', () => {
  for (const value of [{ type: 'completed' }, { type: 'cancelled_locally' }, f.outcome]) {
    validateClosedShape(api.validateOutcomeView, value);
    if (value.type !== 'failed') rejects(() => api.validateOutcomeView({ ...value, code: 'upstream_error' }));
  }
  for (const value of [{ type: 'model_completed' }, { type: 'tools_prepared' }, f.turnOutcome]) validateClosedShape(api.validateTurnOutcomeView, value);
  for (const value of [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }, f.responseOutcome]) {
    validateClosedShape(api.validateResponseOutcomeView, value);
    if (value.status !== 'incomplete') rejects(() => api.validateResponseOutcomeView({ ...value, reason: null }));
  }
  for (const validate of [api.validateOutcomeView, api.validateTurnOutcomeView, api.validateResponseOutcomeView]) {
    rejects(() => validate({ type: 'unknown', status: 'unknown' }));
    rejects(() => validate({ type: 'constructor' }));
  }
});

function itemProjections(item) {
  const response = { ...f.response, items: [item] };
  return [
    [api.validateItemView, item],
    [api.validateResponseView, response],
    [api.validateEventView, { ...f.event('response.finished'), data: response }],
    ...['response.item.started', 'response.item.finished'].map(kind => {
      const event = f.event(kind);
      return [api.validateEventView, { ...event, data: { ...event.data, item } }];
    }),
  ];
}

test('ItemView accepts every kind projection directly and in responses and item events', () => {
  const items = [];
  for (const [kind, blockKinds] of [['message', ['text', 'refusal']], ['reasoning', ['reasoning_summary', 'reasoning_text']]]) {
    for (const unsupported_content of [false, true]) {
      for (const content of [[], blockKinds.map(kind => ({ kind, text: f.exactText })), blockKinds.map(kind => ({ kind, text: '' }))]) {
        items.push({ ...f.item, item_id: '', kind, content, unsupported_content });
      }
    }
  }
  for (const function_call of [f.functionCall, { ...f.functionCall, call_id: '', name: '', arguments: '', namespace: '', complete: false }, null]) {
    items.push({ item_id: null, kind: 'function_call', function_call, content: [], unsupported_content: function_call === null });
  }
  for (const kind of ['custom_tool_call', 'tool_search_call', 'tool_search_output', 'program', 'program_output', 'unknown']) {
    items.push({ item_id: null, kind, function_call: null, content: [], unsupported_content: true });
  }
  for (const item of items) {
    for (const [validate, value] of itemProjections(item)) assert.deepEqual(validate(value), value);
  }
});

test('ItemView rejects cross-kind projections directly and in responses and item events', () => {
  const items = [];
  for (const [kind, wrongBlocks] of [['message', ['reasoning_summary', 'reasoning_text']], ['reasoning', ['text', 'refusal']]]) {
    for (const unsupported_content of [false, true]) {
      const base = { ...f.item, kind, content: [], unsupported_content };
      items.push({ ...base, function_call: f.functionCall });
      for (const block of wrongBlocks) {
        const validKind = kind === 'message' ? 'text' : 'reasoning_summary';
        items.push({ ...base, content: [{ kind: validKind, text: '' }, { kind: block, text: f.exactText }] });
      }
    }
  }
  const functionItem = { item_id: null, kind: 'function_call', function_call: f.functionCall, content: [], unsupported_content: false };
  items.push({ ...functionItem, unsupported_content: true }, { ...functionItem, function_call: null });
  const noTextItems = [functionItem, { ...functionItem, function_call: null, unsupported_content: true }];
  for (const kind of ['custom_tool_call', 'tool_search_call', 'tool_search_output', 'program', 'program_output', 'unknown']) {
    const base = { item_id: null, kind, function_call: null, content: [], unsupported_content: true };
    items.push({ ...base, function_call: f.functionCall }, { ...base, unsupported_content: false });
    noTextItems.push(base);
  }
  for (const base of noTextItems) {
    for (const kind of ['text', 'refusal', 'reasoning_summary', 'reasoning_text']) {
      items.push({ ...base, content: [{ kind, text: '' }] });
    }
  }
  for (const kind of ['new_protocol_variant', 'FunctionCall', '', 1, {}]) items.push({ ...f.item, kind });
  for (const item of items) {
    for (const [validate, value] of itemProjections(item)) rejects(() => validate(value), 'invalid_schema');
  }
});

test('provider function items and unsupported variants keep only projected data', () => {
  const functionItem = { item_id: null, kind: 'function_call', function_call: f.functionCall, content: [], unsupported_content: false };
  validateClosedShape(api.validateItemView, functionItem);
  for (const kind of ['custom_tool_call', 'tool_search_call', 'tool_search_output', 'program', 'program_output', 'unknown']) {
    const value = { item_id: null, kind, function_call: null, content: [], unsupported_content: true };
    validateClosedShape(api.validateItemView, value);
  }
  const reasoning = { ...f.item, kind: 'reasoning', content: [{ kind: 'reasoning_summary', text: f.exactText }, { kind: 'reasoning_text', text: f.exactText }] };
  assert.deepEqual(api.validateItemView(reasoning), reasoning);
  rejects(() => api.validateResponseView({ ...f.response, native: {} }));
  rejects(() => api.validateResultView({ ...f.result, last_response: f.response }));
});

test('safe codes and warnings use complete static producer allowlists', () => {
  const gateway = ['unauthorized', 'forbidden', 'rate_limited', 'auth_expired', 'auth_account_changed', 'timeout', 'transport_error', 'unexpected_content_type', 'locally_cancelled', 'slow_consumer', 'unexpected_end', 'protocol_error', 'provider_error', 'invalid_request', 'output_limit', 'unsupported_output', 'unsupported_feature', 'http_error', 'gateway_error'];
  const storage = ['invalid_input', 'busy', 'closed', 'not_found', 'unavailable', 'unsupported_version', 'integrity', 'command_conflict', 'invalid_transition', 'active_run_exists', 'stale_history', 'catalog_repair_required', 'creation_incomplete', 'io', 'commit_unknown'].map(code => `storage.${code}`);
  const codes = [...gateway, ...storage, ...['unauthorized', 'origin_forbidden', 'workspace_forbidden', 'authority_invalid', 'invalid_request', 'cursor_invalid', 'body_too_large', 'unsupported_media', 'not_found', 'method_not_allowed', 'worker_lost', 'closed'].map(code => `api.${code}`), ...['invalid_root', 'read_failed', 'invalid_frontmatter', 'duplicate_skill', 'invalid_skill_id', 'unknown_skill', 'context_changed', 'invalid_body', 'invalid_request', 'input_too_large'].map(code => `context.${code}`)];
  for (const code of codes) assert.equal(api.validateErrorView({ ...f.error, code }).code, code);
  for (const code of [...gateway, 'event_sink', 'counter_overflow', 'tool_execution', 'provider_open', 'provider_request_failed', 'provider_correlation', 'history_identity', 'history_restore', 'upstream_error']) {
    assert.equal(api.validateOutcomeView({ type: 'failed', code }).code, code);
    const view = f.event('response.failed');
    view.data.code = code;
    assert.equal(api.validateEventView(view).data.code, code);
  }
  for (const warning_code of [...gateway, ...storage, 'storage.connection_cleanup_failed']) assert.equal(api.validateTaskAcceptedView({ ...f.accepted, warning_code }).warning_code, warning_code);
  for (const validate of [api.validateCreateView, api.validateRenameView]) {
    const fixture = validate === api.validateCreateView ? f.create : f.rename;
    assert.equal(validate({ ...fixture, warning_code: 'storage.connection_cleanup_failed' }).warning_code, 'storage.connection_cleanup_failed');
    rejects(() => validate({ ...fixture, warning_code: 'provider_error' }));
  }
  for (const fault_code of storage) assert.equal(api.validateCatalogEntryView({ ...f.catalog, availability: 'unavailable', fault_code }).fault_code, fault_code);
  for (const code of ['private-canary', 'storage.new_code', 'api.new_code']) {
    rejects(() => api.validateErrorView({ ...f.error, code }));
    rejects(() => api.validateOutcomeView({ type: 'failed', code }));
    rejects(() => api.validateTaskAcceptedView({ ...f.accepted, warning_code: code }));
  }
});

test('decimal grammar and i64/u64 boundaries preserve values above 2^53', () => {
  for (const value of ['0', '1', '9007199254740992', '9007199254740993', '9223372036854775807']) {
    assert.equal(api.validateI64(value), value);
    assert.equal(api.validateU64(value), value);
  }
  for (const value of ['9223372036854775808', '18446744073709551615']) {
    assert.equal(api.validateU64(value), value);
    rejects(() => api.validateI64(value), 'invalid_decimal');
  }
  for (const value of ['', '00', '01', '-1', '+1', ' 1', '1 ', '1\n', '1\r', '1.0', '1e2', '１', '١', '18446744073709551616', '9'.repeat(1000), 1, 9007199254740992, null, true, [], {}]) {
    rejects(() => api.validateI64(value), 'invalid_decimal');
    rejects(() => api.validateU64(value), 'invalid_decimal');
  }
  assert.equal(api.nextSequence('9007199254740993'), '9007199254740994');
  assert.equal(api.nextSequence('9223372036854775806'), '9223372036854775807');
  rejects(() => api.nextSequence('9223372036854775807'), 'invalid_decimal');
});

test('each numeric DTO field uses its source range, not a JavaScript Number', () => {
  for (const [name, fixture] of [...dtos, ...Object.keys(f.eventData).map(kind => ['EventView', f.event(kind)])]) {
    for (const path of paths(fixture)) {
      const value = at(fixture, path);
      if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) continue;
      const validate = api[`validate${name}`];
      for (const replacement of ['18446744073709551616', 1, '01']) {
        const copy = structuredClone(fixture);
        at(copy, path.slice(0, -1))[path.at(-1)] = replacement;
        rejects(() => validate(copy));
      }
      const key = path.at(-1);
      if (key.endsWith('_sequence') || ['sequence', 'created_at_ms', 'updated_at_ms'].includes(key)) {
        const copy = structuredClone(fixture);
        at(copy, path.slice(0, -1))[key] = '9223372036854775808';
        rejects(() => validate(copy));
      }
    }
  }
  const delta = f.event('response.delta');
  delta.data.content_index = '18446744073709551615';
  delta.data.summary_index = '18446744073709551615';
  assert.deepEqual(api.validateEventView(delta), delta);
});

test('UUID identities match Rust canonical non-nil semantics without imposing version 4', () => {
  for (const value of [f.sid, 'ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-000000000001']) assert.equal(api.validateUuid(value), value);
  for (const value of ['', f.sid.toUpperCase(), f.sid.replaceAll('-', ''), `{${f.sid}}`, `urn:uuid:${f.sid}`, `${f.sid}\n`, '00000000-0000-0000-0000-000000000000', '../session', null, 1]) rejects(() => api.validateUuid(value), 'invalid_identity');
  for (const key of ['session_id', 'run_id', 'event_id']) rejects(() => api.validateEventView({ ...f.event(), [key]: 'not-uuid' }));
  for (const key of ['session_id', 'run_id', 'operation_id']) rejects(() => api.validateReceiptView({ ...f.taskReceipt, [key]: 'not-uuid' }));
});

test('qualified cursors reject cross-session, future, malformed and overflowing identities', () => {
  for (const sequence of ['0', '9007199254740993', '9223372036854775807']) {
    const value = api.cursorFor(f.sid, sequence);
    assert.deepEqual(api.parseCursor(value), { session_id: f.sid, sequence });
    assert.deepEqual(api.validateCursor(value, f.sid, sequence), { session_id: f.sid, sequence });
    rejects(() => api.validateCursor(value, f.otherSid), 'invalid_cursor');
    if (sequence !== '0') rejects(() => api.validateCursor(value, f.sid, (BigInt(sequence) - 1n).toString()), 'invalid_cursor');
  }
  for (const value of [f.sid, `${f.sid}:`, `${f.sid}:01`, `${f.sid}:-1`, `${f.sid}:1:2`, `${f.sid}:1\n`, `${f.sid}:9223372036854775808`, `bad:1`, null, 1]) rejects(() => api.parseCursor(value), 'invalid_cursor');
});

test('receipt ranges, B2 two-record acceptance and identity association remain exact', () => {
  assert.deepEqual(api.validateReceiptIdentity(f.taskReceipt, { session_id: f.sid, operation_id: f.oid, run_id: f.rid }), f.taskReceipt);
  for (const key of ['session_id', 'operation_id', 'run_id']) rejects(() => api.validateReceiptIdentity(f.taskReceipt, { session_id: f.sid, operation_id: f.oid, run_id: f.rid, [key]: f.otherSid }), 'identity_mismatch');
  rejects(() => api.validateReceiptView({ ...f.receipt, first_sequence: '0' }));
  rejects(() => api.validateReceiptView({ ...f.receipt, first_sequence: '2' }));
  rejects(() => api.validateCreateView({ ...f.create, session_id: f.otherSid }), 'identity_mismatch');
  rejects(() => api.validateCreateView({ ...f.create, receipt: f.taskReceipt }), 'identity_mismatch');
  rejects(() => api.validateRenameView({ ...f.rename, receipt: f.taskReceipt }), 'identity_mismatch');
  for (const receipt of [f.receipt, { ...f.taskReceipt, last_sequence: f.taskReceipt.first_sequence }, { ...f.taskReceipt, last_sequence: '9007199254740995' }, { ...f.taskReceipt, first_sequence: '9223372036854775807', last_sequence: '9223372036854775807' }]) rejects(() => api.validateTaskAcceptedView({ ...f.accepted, receipt }));
  const receipt = { ...f.taskReceipt, first_sequence: '9223372036854775806', last_sequence: '9223372036854775807' };
  assert.deepEqual(api.validateTaskAcceptedView({ ...f.accepted, receipt }).receipt, receipt);
});

test('EventView requires session.created exactly at sequence 1 directly and in history', () => {
  const prefix = api.validateHistoryView({ ...f.history, next_after: `${f.sid}:1`, has_more: true, events: [f.event('session.created')] });
  const originalPrefix = structuredClone(prefix);
  const invalid = [
    ...Object.keys(f.eventData).filter(kind => kind !== 'session.created').map(kind => f.event(kind, '1')),
    ...['2', '9007199254740993', '9223372036854775807'].map(sequence => f.event('session.created', sequence)),
  ];
  for (const event of invalid) {
    rejects(() => api.validateEventView(event), 'invalid_schema');
    const page = { ...f.history, through_sequence: '9223372036854775807', events: [...prefix.events, event] };
    const originalPage = structuredClone(page);
    rejects(() => api.validateHistoryView(page), 'invalid_schema');
    assert.deepEqual(page, originalPage);
    assert.deepEqual(prefix, originalPrefix);
  }
});

test('history session/cursor/head checks and event run nullability reject mismatches', () => {
  rejects(() => api.validateHistoryView({ ...f.history, next_after: `${f.otherSid}:3` }));
  rejects(() => api.validateHistoryView({ ...f.history, next_after: `${f.sid}:4` }));
  rejects(() => api.validateHistoryView({ ...f.history, events: [f.event('checkpoint', '4')] }));
  rejects(() => api.validateHistoryView({ ...f.history, events: [f.event('checkpoint', '2', f.otherSid)] }), 'identity_mismatch');
  rejects(() => api.validateEventView({ ...f.event('session.created'), run_id: f.rid }));
  rejects(() => api.validateEventView({ ...f.event(), run_id: null }));
  for (const kind of ['provider.native', 'constructor', '__proto__', 'run.new_kind']) rejects(() => api.validateEventView({ ...f.event(), kind }));
  rejects(() => api.validateCatalogEntryView({ ...f.catalog, last_run_id: null }));
  rejects(() => api.validateCatalogEntryView({ ...f.catalog, observed_head_sequence: '0' }));
  assert.equal(api.validateCatalogEntryView({ ...f.catalog, availability: 'creating', observed_head_sequence: '0' }).observed_head_sequence, '0');
});

test('JSON and media failures expose static categories without raw diagnostics', () => {
  for (const contentType of ['application/json', 'Application/Json; Charset="UTF-8"', 'application/json; charset = utf-8']) assert.deepEqual(api.decodeJson(JSON.stringify(f.error), contentType, api.validateErrorView), f.error);
  for (const contentType of [null, '', 'text/html', 'application/problem+json', 'application/json, application/json', 'application/json;', 'application/json; charset=latin1', 'application/json; charset=utf-8; charset=utf-8', 'application/json; private=canary', 'application/json\n', 'application/json\u0000', 'application/json; charset=\r\nutf-8', '\u00a0application/json']) rejects(() => api.decodeJson('private-body-canary', contentType, api.validateErrorView), 'unexpected_media_type');
  for (const body of ['private-body-canary', '{"token":"synthetic-canary",}', '', '\ufeff{}', '{}{}', undefined]) rejects(() => api.decodeJson(body, 'application/json', api.validateErrorView), 'invalid_json');
  for (const body of ['null', '[]', '"synthetic-canary"', '1']) rejects(() => api.decodeJson(body, 'application/json', api.validateErrorView));
  for (const value of ['text/event-stream', 'text/event-stream; charset=utf-8']) api.requireMediaType(value, 'text/event-stream');
  rejects(() => api.requireMediaType('application/json', 'text/event-stream'), 'unexpected_media_type');
});

test('fixed API paths permit no backend URL or path/query injection', () => {
  assert.equal(api.apiPath({ kind: 'settings' }), '/v1/settings');
  assert.equal(api.apiPath({ kind: 'create' }), '/v1/sessions');
  assert.equal(api.apiPath({ kind: 'sessions', after_id: f.sid }), `/v1/sessions?limit=32&after_id=${f.sid}`);
  for (const [kind, suffix] of [['session', ''], ['rename', '/rename'], ['refresh', '/refresh'], ['task', '/runs'], ['run', `/runs/${f.rid}`], ['cancel', `/runs/${f.rid}/cancel`], ['operation', `/operations/${f.oid}`]]) assert.equal(api.apiPath({ kind, session_id: f.sid, run_id: f.rid, operation_id: f.oid }), `/v1/sessions/${f.sid}${suffix}`);
  const after = `${f.sid}:9007199254740993`;
  assert.equal(api.apiPath({ kind: 'history', session_id: f.sid, after, through: '9007199254740994' }), `/v1/sessions/${f.sid}/history?after=${encodeURIComponent(after)}&limit=32&through=9007199254740994`);
  assert.equal(api.apiPath({ kind: 'events', session_id: f.sid, after }), `/v1/sessions/${f.sid}/events?after=${encodeURIComponent(after)}`);
  for (const session_id of ['//foreign.example', '../settings', `${f.sid}?token=synthetic-canary`, `${f.sid}/runs`]) rejects(() => api.apiPath({ kind: 'session', session_id }));
  rejects(() => api.apiPath({ kind: 'history', session_id: f.sid, after, through: '1' }));
  rejects(() => api.apiPath({ kind: 'events', session_id: f.otherSid, after }));
  rejects(() => api.apiPath({ kind: 'unknown', session_id: f.sid }));
});

test('pure request helpers keep synthetic owner auth only in headers and preserve command bytes', () => {
  // Generated synthetic input is never printed or stored in a fixture file.
  const token = 'a'.repeat(64);
  const read = api.readRequestInit(token, 'text/event-stream');
  assert.equal(read.headers.Authorization === `Bearer ${token}`, true);
  assert.equal(read.headers.Accept, 'text/event-stream');
  assert.equal(read.method, 'GET');
  assert.equal(read.credentials, 'omit');
  assert.equal(read.redirect, 'error');
  assert.equal(read.cache, 'no-store');
  assert.equal(read.mode, 'same-origin');
  assert.equal(read.referrerPolicy, 'no-referrer');
  assert.equal(read.body, undefined);
  for (const [kind, body] of [['create', f.createCommand], ['rename', f.renameCommand], ['task', f.taskCommand], ['refresh', undefined], ['cancel', undefined]]) {
    const init = api.jsonRequestInit(token, { kind, body });
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), body ?? {});
    assert.equal(init.body.includes(token), false);
  }
  for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${token}\n`, ` ${token}`, null, 1]) rejects(() => api.readRequestInit(value), 'invalid_token');
  rejects(() => api.jsonRequestInit(token, { kind: 'task', body: { ...f.taskCommand, native: {} } }));
  rejects(() => api.jsonRequestInit(token, { kind: 'unknown' }), 'invalid_request');
});
