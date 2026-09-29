import {
  ProtocolError, apiPath, cursorFor, decodeJson, jsonRequestInit, readRequestInit, requireMediaType,
  validateCancelView, validateCreateCommand, validateCreateView, validateErrorView, validateHistoryView,
  validateOperationView, validateReceiptIdentity, validateRefreshView, validateRenameCommand, validateRenameView,
  validateRunView, validateSessionListView, validateSessionView, validateSettingsView, validateTaskAcceptedView,
  validateTaskCommand, validateUuid,
  type ApiCommand, type ApiRoute, type CancelView, type CreateCommand, type CreateView, type ErrorView, type NoticeView,
  type ReceiptView, type RefreshView, type RenameCommand, type RenameView, type RunView, type SessionListView,
  type SessionView, type SettingsView, type TaskAcceptedView, type TaskCommand, type Validator,
} from './api.js';
import { WiSseParser } from './sse.js';
import {
  applyEvent, applyHistoryPage, captureEpoch, changeConnection, createEpochs, createHistory, historyRequest,
  eventFingerprint, isCurrentEpoch, selectDisplay, selectSessionEpoch, type DisplayRun, type EpochToken, type HistoryState,
} from './state.js';

export type ClientError =
  | { readonly category: 'authentication' | 'invalid_token' | 'network' | 'aborted' | 'unsupported_client'
      | 'not_connected' | 'invalid_action' | 'workspace_forbidden' | 'conflict' }
  | { readonly category: 'protocol'; readonly detail: ProtocolError['category'] }
  | { readonly category: 'http'; readonly status: number;
      readonly server: Pick<ErrorView, 'code' | 'stage' | 'certainty' | 'acceptance' | 'notices'> };

export type CapturedCommand = { readonly id: string } & (
  | { readonly kind: 'create'; readonly session_id: null; readonly body: CreateCommand }
  | { readonly kind: 'rename'; readonly session_id: string; readonly body: RenameCommand }
  | { readonly kind: 'task'; readonly session_id: string; readonly body: TaskCommand }
  | { readonly kind: 'refresh'; readonly session_id: string; readonly body: Readonly<Record<string, never>> });
export type CommandReply = CreateView | RenameView | TaskAcceptedView | RefreshView;
export interface PendingCommand {
  readonly command: CapturedCommand;
  readonly phase: 'sending' | 'uncertain' | 'rejected' | 'accepted' | 'conflict' | 'reconciling';
  readonly error: ClientError | null;
  readonly receipt: ReceiptView | null;
  readonly reply: CommandReply | null;
  readonly notices: readonly NoticeView[];
  readonly canonical_seen: boolean;
  readonly canonical_sequence: string | null;
}
export interface MutationOutcome {
  readonly id: string;
  readonly kind: CapturedCommand['kind'];
  readonly session_id: string;
  readonly receipt: ReceiptView | null;
  readonly reply: CommandReply | null;
  readonly notices: readonly NoticeView[];
  readonly canonical_read_error: ClientError | null;
}

// Frozen Maps still permit set/delete. Snapshots use frozen entry arrays instead.
export type SnapshotValue<T> = T extends ReadonlyMap<infer K, infer V>
  ? readonly (readonly [SnapshotValue<K>, SnapshotValue<V>])[]
  : T extends readonly unknown[] ? { readonly [K in keyof T]: SnapshotValue<T[K]> }
  : T extends object ? { readonly [K in keyof T]: SnapshotValue<T[K]> } : T;
function snapshotValue<T>(value: T): SnapshotValue<T> {
  if (value instanceof Map) return snapshotValue([...value]) as SnapshotValue<T>;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotValue)) as SnapshotValue<T>;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshotValue(entry)]))) as SnapshotValue<T>;
  }
  return value as SnapshotValue<T>;
}
function mergeNotices(previous: readonly NoticeView[], incoming: readonly NoticeView[]): readonly NoticeView[] {
  const notices = [...previous];
  for (const notice of incoming) {
    if (!notices.some(known => known.scope === notice.scope && known.source_label === notice.source_label && known.kind === notice.kind)) {
      notices.push(notice);
    }
  }
  return snapshotValue(notices);
}
// Keep canonical tasks available for receipt reads without repeating their pending text.
function isReceiptRecovery(item: PendingCommand): boolean {
  return item.command.kind === 'task' && item.phase === 'accepted' && item.canonical_seen && item.receipt === null;
}
export interface ClientSnapshot {
  readonly connection: 'disconnected' | 'connecting' | 'connected';
  readonly settings: SettingsView | null;
  readonly catalog: SessionListView | null;
  readonly catalog_loading: boolean;
  readonly error: ClientError | null;
  readonly draft: string;
  readonly pending: readonly PendingCommand[];
  readonly recoveries: readonly PendingCommand[];
  readonly last_mutation: MutationOutcome | null;
  readonly selected: {
    readonly session_id: string;
    readonly manifest: SessionView | null;
    readonly title: string | null;
    readonly workspace: string | null;
    readonly applied_cursor: string;
    readonly through_sequence: string | null;
    readonly history_complete: boolean;
    readonly display: SnapshotValue<readonly DisplayRun[]>;
    readonly observation: 'loading' | 'connecting' | 'streaming' | 'disconnected';
    readonly observation_error: ClientError | null;
    readonly closed_reason: 'shutdown' | null;
    readonly run_view: RunView | null;
    readonly cancel: CancelView | null;
    readonly cancelling: boolean;
  } | null;
}
export interface ClientDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly crypto?: Pick<Crypto, 'randomUUID'> | null;
}
class Failure extends Error {
  constructor(readonly safe: ClientError) { super(safe.category); }
}
function fail(category: Exclude<ClientError['category'], 'http' | 'protocol'>): never {
  throw new Failure({ category });
}
function safeError(error: unknown): ClientError {
  if (error instanceof Failure) return error.safe;
  if (error instanceof ProtocolError) return { category: 'protocol', detail: error.category };
  return { category: 'network' };
}
function httpError(status: number, view: ErrorView): ClientError {
  return { category: 'http', status, server: {
    code: view.code, stage: view.stage, certainty: view.certainty, acceptance: view.acceptance, notices: view.notices,
  } };
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Failure({ category: 'aborted' }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function discardBody(response: Response): void { void response.body?.cancel().catch(() => {}); }

export function createClient(dependencies: ClientDependencies = {}) {
  const fetcher = dependencies.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const crypto = dependencies.crypto === undefined ? globalThis.crypto : dependencies.crypto;
  let token: string | null = null;
  let epochs = createEpochs();
  let connection: ClientSnapshot['connection'] = 'disconnected';
  let settings: SettingsView | null = null;
  let catalog: SessionListView | null = null;
  let error: ClientError | null = null;
  let draft = '';
  let selected: {
    session_id: string; manifest: SessionView | null; history: HistoryState;
    observation: NonNullable<ClientSnapshot['selected']>['observation']; observation_error: ClientError | null;
    closed_reason: 'shutdown' | null; run_view: RunView | null; cancel: CancelView | null; cancelling: boolean;
  } | null = null;
  let lastMutation: MutationOutcome | null = null;
  const pending = new Map<string, PendingCommand>();
  const waiters = new Map<string, AbortController>();
  const requests = new Set<AbortController>();
  const selectionReads = new Set<AbortController>();
  const listeners = new Set<(state: ClientSnapshot) => void>();
  let catalogReader: AbortController | null = null;
  let streamReader: AbortController | null = null;

  function snapshot(): ClientSnapshot {
    let selection: ClientSnapshot['selected'] = null;
    if (selected !== null) {
      const { history, ...fields } = selected;
      const conversation = history.conversation;
      // An old replay page must not overwrite a newer canonical manifest title.
      const caughtUp = fields.manifest === null || BigInt(conversation.applied_cursor.split(':')[1]) >= BigInt(fields.manifest.head_sequence);
      const metadata = caughtUp ? conversation.metadata ?? fields.manifest : fields.manifest;
      selection = { ...fields, title: metadata?.title ?? null, workspace: metadata?.workspace ?? null,
        applied_cursor: conversation.applied_cursor, through_sequence: history.through_sequence, history_complete: history.complete,
        display: snapshotValue(selectDisplay(history.conversation)) };
    }
    const commands = [...pending.values()];
    return snapshotValue({ connection, settings, catalog, catalog_loading: catalogReader !== null, error, draft,
      pending: commands.filter(item => !isReceiptRecovery(item)), recoveries: commands.filter(isReceiptRecovery),
      last_mutation: lastMutation, selected: selection });
  }
  function emit(): void {
    const value = snapshot();
    for (const listener of listeners) {
      // A view failure must not break command bookkeeping or advance an observation cursor.
      try { listener(value); } catch { /* Do not expose consumer exceptions. */ }
    }
  }
  function clear(reason: ClientError | null = null): void {
    epochs = changeConnection(epochs, false);
    token = null;
    for (const controller of requests) controller.abort();
    requests.clear(); selectionReads.clear(); waiters.clear();
    catalogReader = null; streamReader = null;
    connection = 'disconnected'; settings = null; catalog = null; selected = null;
    draft = ''; pending.clear(); lastMutation = null; error = reason;
    emit();
  }
  function controller(selection = false): AbortController {
    const result = new AbortController();
    requests.add(result);
    if (selection) selectionReads.add(result);
    return result;
  }
  function release(control: AbortController): void { requests.delete(control); selectionReads.delete(control); }
  function current(stamp: EpochToken): boolean { return isCurrentEpoch(epochs, stamp); }
  function ready(): void { if (connection !== 'connected') fail('not_connected'); }
  function selectionId(): string {
    ready();
    if (selected === null) fail('invalid_action');
    return selected.session_id;
  }
  function uuid(): string {
    if (typeof crypto?.randomUUID !== 'function') fail('unsupported_client');
    try { return validateUuid(crypto.randomUUID()); } catch { return fail('unsupported_client'); }
  }
  function report(cause: unknown): void { error = safeError(cause); emit(); }

  async function response(route: ApiRoute, control: AbortController, command?: ApiCommand): Promise<Response> {
    if (token === null) fail('not_connected');
    const epoch = epochs.connection;
    const init = command === undefined ? readRequestInit(token, route.kind === 'events' ? 'text/event-stream' : 'application/json')
      : jsonRequestInit(token, command);
    const response = await abortable(Promise.resolve().then(() => {
      if (control.signal.aborted || epoch !== epochs.connection) fail('aborted');
      return fetcher(apiPath(route), { ...init, signal: control.signal });
    }).then(value => {
      if (control.signal.aborted || epoch !== epochs.connection) { discardBody(value); fail('aborted'); }
      if (value.status === 401) { discardBody(value); clear({ category: 'authentication' }); fail('authentication'); }
      return value;
    }), control.signal);
    return response;
  }
  async function readBody(reply: Response, control: AbortController): Promise<string> {
    if (reply.body === null) return '';
    const reader = reply.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    control.signal.addEventListener('abort', abort, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = '';
    try {
      while (!control.signal.aborted) {
        const chunk = await abortable(reader.read(), control.signal);
        try { body += decoder.decode(chunk.value, { stream: !chunk.done }); }
        catch { throw new ProtocolError('invalid_utf8'); }
        if (chunk.done) break;
      }
      if (control.signal.aborted) fail('aborted');
      return body;
    } finally {
      control.signal.removeEventListener('abort', abort);
      try { await reader.cancel(); } catch { /* Discard transport errors after the reader ends. */ }
      reader.releaseLock();
    }
  }
  async function json<T>(route: ApiRoute, control: AbortController, validate: Validator<T>, statuses = [200], command?: ApiCommand): Promise<{ status: number; value: T }> {
    const reply = await response(route, control, command);
    try {
      requireMediaType(reply.headers.get('Content-Type'), 'application/json');
      const body = await readBody(reply, control);
      if (control.signal.aborted) fail('aborted');
      if (reply.status >= 400 && reply.status <= 599) {
        throw new Failure(httpError(reply.status, decodeJson(body, reply.headers.get('Content-Type'), validateErrorView)));
      }
      if (!statuses.includes(reply.status)) throw new ProtocolError('invalid_schema');
      return { status: reply.status, value: decodeJson(body, reply.headers.get('Content-Type'), validate) };
    } finally { discardBody(reply); }
  }

  async function loadCatalog(append: boolean): Promise<void> {
    if (append && (catalog === null || !catalog.has_more || catalogReader !== null)) return;
    catalogReader?.abort();
    const control = controller(); catalogReader = control;
    const epoch = epochs.connection;
    const previous = append ? catalog : null;
    const after = previous?.next_after_id ?? undefined;
    error = null; emit();
    try {
      const { value } = await json({ kind: 'sessions', after_id: after }, control, validateSessionListView);
      let last = after;
      for (const entry of value.entries) {
        if (last !== undefined && entry.session_id <= last) throw new ProtocolError('invalid_cursor');
        last = entry.session_id;
      }
      const expected = value.entries.at(-1)?.session_id ?? null;
      if (value.entries.length > 32 || value.next_after_id !== expected || (value.has_more && expected === null)) {
        throw new ProtocolError('invalid_cursor');
      }
      if (epoch !== epochs.connection || catalogReader !== control) return;
      catalog = { ...value, entries: [...(previous?.entries ?? []), ...value.entries] };
    } catch (cause) {
      if (epoch === epochs.connection && catalogReader === control) error = safeError(cause);
    } finally {
      release(control);
      if (catalogReader === control) { catalogReader = null; emit(); }
    }
  }
  async function connect(secret: string): Promise<void> {
    clear();
    try { readRequestInit(secret); } catch { error = { category: 'invalid_token' }; emit(); return; }
    token = secret;
    epochs = changeConnection(epochs, true); connection = 'connecting';
    const epoch = epochs.connection;
    const control = controller(); emit();
    try {
      const { value } = await json({ kind: 'settings' }, control, validateSettingsView);
      if (epoch !== epochs.connection) return;
      settings = value;
      await loadCatalog(false);
      if (epoch !== epochs.connection) return;
      if (catalog === null) { clear(error); return; }
      connection = 'connected'; emit();
    } catch (cause) { if (epoch === epochs.connection) clear(safeError(cause)); }
    finally { release(control); }
  }

  function stopSelection(): void {
    for (const control of selectionReads) { control.abort(); release(control); }
    streamReader?.abort(); streamReader = null;
  }
  async function manifest(sid: string, stamp: EpochToken): Promise<void> {
    const control = controller(true);
    try {
      const { value } = await json({ kind: 'session', session_id: sid }, control, validateSessionView);
      if (value.session_id !== sid) throw new ProtocolError('identity_mismatch');
      if (current(stamp) && selected?.session_id === sid
        && (selected.manifest === null || BigInt(value.head_sequence) >= BigInt(selected.manifest.head_sequence))) {
        selected.manifest = value; emit();
      }
    } finally { release(control); }
  }
  async function selectSession(sid: string): Promise<void> {
    try { ready(); validateUuid(sid); } catch (cause) { report(cause); return; }
    stopSelection(); epochs = selectSessionEpoch(epochs, sid);
    const stamp = captureEpoch(epochs);
    selected = { session_id: sid, manifest: null, history: createHistory(sid), observation: 'loading',
      observation_error: null, closed_reason: null, run_view: null, cancel: null, cancelling: false };
    draft = ''; error = null; emit();
    const control = controller(true);
    try {
      await manifest(sid, stamp);
      while (current(stamp) && selected !== null && !selected.history.complete) {
        const request = historyRequest(selected.history);
        const { value } = await json({ kind: 'history', session_id: sid, after: request.after,
          through: request.through ?? undefined }, control, validateHistoryView);
        if (!current(stamp) || selected === null) return;
        selected.history = applyHistoryPage(selected.history, value);
        matchPending(); emit();
      }
      if (current(stamp)) startObservation();
    } catch (cause) {
      if (current(stamp) && selected !== null) {
        selected.observation = 'disconnected'; selected.observation_error = safeError(cause); emit();
      }
    } finally { release(control); }
  }
  function startObservation(): void {
    if (selected === null || !selected.history.complete) return;
    streamReader?.abort();
    const control = controller(true); streamReader = control;
    const stamp = captureEpoch(epochs);
    const sid = selected.session_id;
    const after = selected.history.conversation.applied_cursor;
    selected.observation = 'connecting'; selected.observation_error = null; selected.closed_reason = null; emit();
    void observe(sid, after, stamp, control);
  }
  async function observe(sid: string, after: string, stamp: EpochToken, control: AbortController): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const valid = () => current(stamp) && streamReader === control && !control.signal.aborted;
    const abort = () => { void reader?.cancel().catch(() => {}); };
    try {
      const reply = await response({ kind: 'events', session_id: sid, after }, control);
      if (reply.status !== 200) {
        try {
          requireMediaType(reply.headers.get('Content-Type'), 'application/json');
          const body = await readBody(reply, control);
          if (reply.status < 400 || reply.status > 599) throw new ProtocolError('invalid_schema');
          throw new Failure(httpError(reply.status, decodeJson(body, reply.headers.get('Content-Type'), validateErrorView)));
        } finally { discardBody(reply); }
      }
      try { requireMediaType(reply.headers.get('Content-Type'), 'text/event-stream'); }
      catch (cause) { discardBody(reply); throw cause; }
      if (reply.body === null) throw new ProtocolError('invalid_sse');
      reader = reply.body.getReader();
      control.signal.addEventListener('abort', abort, { once: true });
      if (!valid()) return;
      selected!.observation = 'streaming'; emit();
      const parser = new WiSseParser(sid, record => {
        if (!valid() || selected === null) return;
        if (record.kind === 'event') {
          const conversation = applyEvent(selected.history.conversation, record.event);
          selected.history = { ...selected.history, conversation };
          matchPending();
        } else if (record.kind === 'error') {
          if (record.error.code === 'api.unauthorized') { clear({ category: 'authentication' }); return; }
          selected.observation_error = httpError(200, record.error);
        } else selected.closed_reason = record.closed.reason;
        emit();
      });
      while (valid() && !parser.done) {
        const chunk = await abortable(reader.read(), control.signal);
        if (!valid()) return;
        if (chunk.done) { parser.finish(); break; }
        parser.push(chunk.value);
      }
    } catch (cause) {
      if (valid() && selected !== null) selected.observation_error = safeError(cause);
    } finally {
      control.signal.removeEventListener('abort', abort);
      if (reader !== null) { try { await reader.cancel(); } catch { /* Read cleanup is not run cancellation. */ } reader.releaseLock(); }
      release(control);
      if (valid() && selected !== null) { selected.observation = 'disconnected'; streamReader = null; emit(); }
    }
  }

  function matchPending(): void {
    if (selected === null) return;
    for (const [id, item] of pending) {
      const command = item.command;
      if (command.kind !== 'task' || command.session_id !== selected.session_id) continue;
      const run = selected.history.conversation.runs.get(command.body.run_id);
      if (run === undefined) continue;
      // Keep the first canonical sequence even when navigation replaces the selected history.
      const canonical_sequence = item.canonical_sequence ?? run.accepted_sequence;
      if (item.phase === 'conflict' || run.accepted.user_text !== command.body.text
        || run.accepted_sequence !== canonical_sequence
        || (item.receipt !== null && run.accepted_sequence !== item.receipt.first_sequence)) {
        pending.set(id, { ...item, canonical_sequence, phase: 'conflict', error: { category: 'conflict' } });
      } else {
        // Clear only on first acceptance so later records cannot erase a new equal draft.
        if (!item.canonical_seen && draft === command.body.text) draft = '';
        pending.set(id, { ...item, canonical_sequence, phase: 'accepted', canonical_seen: true, error: null });
        if (item.receipt !== null) finishTask(id);
      }
    }
  }
  function finishTask(id: string): void {
    const item = pending.get(id);
    if (item === undefined || item.command.kind !== 'task' || item.phase === 'conflict' || !item.canonical_seen
      || item.receipt === null || item.receipt.first_sequence !== item.canonical_sequence) return;
    lastMutation = { id, kind: 'task', session_id: item.command.session_id, receipt: item.receipt, reply: item.reply,
      notices: item.notices, canonical_read_error: null };
    pending.delete(id);
  }

  function taskReceipt(command: Extract<CapturedCommand, { kind: 'task' }>, receipt: ReceiptView): ReceiptView {
    try { validateReceiptIdentity(receipt, { ...command.body, session_id: command.session_id }); }
    catch { fail('conflict'); }
    if (receipt.first_sequence === '1' || BigInt(receipt.last_sequence) !== BigInt(receipt.first_sequence) + 1n) fail('conflict');
    return receipt;
  }
  function receiptMatches(item: PendingCommand, receipt: ReceiptView): boolean {
    return (item.canonical_sequence === null || receipt.first_sequence === item.canonical_sequence)
      && (item.receipt === null || (receipt.first_sequence === item.receipt.first_sequence
        && receipt.last_sequence === item.receipt.last_sequence));
  }
  function commandFailure(id: string, cause: unknown, readOnly = false, uncertainBefore = false): void {
    const item = pending.get(id);
    if (item === undefined) return;
    let failure = safeError(cause);
    // Keep diagnostics even when acceptance clears the error or a receipt conflict replaces it.
    const notices = failure.category === 'http' ? mergeNotices(item.notices, failure.server.notices) : item.notices;
    let receipt = item.receipt;
    if (failure.category === 'http' && failure.server.acceptance !== null && item.command.kind === 'task') {
      try {
        const actual = taskReceipt(item.command, failure.server.acceptance);
        receipt ??= actual;
        if (!receiptMatches(item, actual)) failure = { category: 'conflict' };
      } catch { failure = { category: 'conflict' }; }
    }
    let phase: PendingCommand['phase'] = 'uncertain';
    if (!readOnly && failure.category === 'http' && failure.server.certainty !== 'unknown'
      && !uncertainBefore) phase = 'rejected';
    if (receipt !== null || item.canonical_seen) phase = 'accepted';
    if (item.phase === 'conflict' || failure.category === 'conflict') {
      phase = 'conflict'; failure = { category: 'conflict' };
    }
    pending.set(id, { ...item, phase, receipt, notices, error: failure });
    if (phase !== 'conflict') finishTask(id);
    emit();
  }
  async function execute(id: string): Promise<void> {
    const item = pending.get(id);
    if (item === undefined || waiters.has(id)) return;
    if (item.command.kind === 'task' && (item.canonical_sequence !== null || item.phase === 'conflict')) fail('invalid_action');
    const command = item.command;
    const control = controller(); waiters.set(id, control);
    const stamp = captureEpoch(epochs);
    pending.set(id, { ...item, phase: 'sending', error: null }); emit();
    try {
      let reply: CommandReply;
      let receipt: ReceiptView | null = null;
      let sid: string;
      switch (command.kind) {
        case 'create': {
          const result = await json({ kind: 'create' }, control, validateCreateView, [200, 201], command);
          reply = result.value; sid = reply.session_id; receipt = reply.receipt;
          if (reply.duplicate !== (result.status === 200) || receipt.operation_id !== command.id
            || receipt.first_sequence !== '1') fail('conflict');
          break;
        }
        case 'rename': {
          const result = await json({ kind: 'rename', session_id: command.session_id }, control, validateRenameView, [200], command);
          reply = result.value; sid = command.session_id; receipt = reply.receipt;
          if (receipt.operation_id !== command.id || receipt.session_id !== sid) fail('conflict');
          break;
        }
        case 'refresh': {
          const result = await json({ kind: 'refresh', session_id: command.session_id }, control, validateRefreshView, [200], command);
          reply = result.value; sid = command.session_id;
          if (reply.session_id !== sid) fail('conflict');
          break;
        }
        case 'task': {
          const result = await json({ kind: 'task', session_id: command.session_id }, control, validateTaskAcceptedView, [202], command);
          if (stamp.connection !== epochs.connection || !pending.has(id)) return;
          const latest = pending.get(id)!;
          pending.set(id, { ...latest, notices: mergeNotices(latest.notices, result.value.notices) });
          reply = result.value; sid = command.session_id; receipt = taskReceipt(command, reply.receipt);
          break;
        }
      }
      if (stamp.connection !== epochs.connection || !pending.has(id)) return;
      if (command.kind === 'task') {
        const latest = pending.get(id)!;
        const conflict = latest.phase === 'conflict' || !receiptMatches(latest, receipt!);
        pending.set(id, { ...latest, phase: conflict ? 'conflict' : 'accepted', receipt: latest.receipt ?? receipt,
          reply, error: conflict ? { category: 'conflict' } : null });
        if (conflict) { emit(); return; }
        if (!latest.canonical_seen && current(stamp) && draft === command.body.text) draft = '';
        matchPending(); finishTask(id); emit();
      } else {
        // Keep the actual commit even if the independent canonical read fails or is aborted.
        const notices = pending.get(id)!.notices;
        pending.delete(id);
        lastMutation = { id, kind: command.kind, session_id: sid, receipt, reply, notices, canonical_read_error: null }; emit();
        try { await manifest(sid, stamp); }
        catch (cause) {
          if (stamp.connection === epochs.connection && lastMutation?.id === id) {
            lastMutation = { ...lastMutation, canonical_read_error: safeError(cause) }; emit();
          }
        }
      }
    } catch (cause) { if (stamp.connection === epochs.connection) commandFailure(id, cause, false, item.phase === 'uncertain'); }
    finally { release(control); if (waiters.get(id) === control) waiters.delete(id); }
  }
  function capture(command: CapturedCommand): Promise<void> {
    pending.set(command.id, { command: snapshotValue(command), phase: 'sending', error: null,
      receipt: null, reply: null, notices: Object.freeze([]), canonical_seen: false, canonical_sequence: null });
    return execute(command.id);
  }
  function duplicate(kind: CapturedCommand['kind'], sid: string | null, body: { title?: string; workspace?: string }): boolean {
    for (const [id, item] of pending) {
      const command = item.command;
      if (command.kind !== kind || command.session_id !== sid || isReceiptRecovery(item)) continue;
      if (item.phase === 'rejected') { pending.delete(id); continue; }
      if (kind === 'task' || kind === 'refresh') return true;
      if ((command.kind === 'create' || command.kind === 'rename') && command.body.title === body.title
        && (command.kind !== 'create' || command.body.workspace === body.workspace)) return true;
    }
    return false;
  }
  async function createSession(title: string, workspace: string): Promise<void> {
    try {
      ready();
      if (!settings!.workspaces.includes(workspace)) fail('workspace_forbidden');
      if (duplicate('create', null, { title, workspace })) return;
      const id = uuid(); const body = validateCreateCommand({ operation_id: id, title, workspace });
      await capture({ id, kind: 'create', session_id: null, body });
    } catch (cause) { report(cause); }
  }
  async function renameSession(title: string): Promise<void> {
    try {
      const sid = selectionId();
      if (duplicate('rename', sid, { title })) return;
      const id = uuid(); const body = validateRenameCommand({ operation_id: id, title });
      await capture({ id, kind: 'rename', session_id: sid, body });
    } catch (cause) { report(cause); }
  }
  async function refreshCatalog(): Promise<void> {
    try {
      const sid = selectionId();
      if (duplicate('refresh', sid, {})) return;
      await capture({ id: uuid(), kind: 'refresh', session_id: sid, body: {} });
    } catch (cause) { report(cause); }
  }
  async function sendTask(): Promise<void> {
    try {
      const sid = selectionId();
      if (duplicate('task', sid, {})) return;
      const id = uuid(); const body = validateTaskCommand({ operation_id: id, run_id: uuid(), text: draft });
      await capture({ id, kind: 'task', session_id: sid, body });
    } catch (cause) { report(cause); }
  }
  async function reconcileTask(id: string): Promise<void> {
    const item = pending.get(id);
    if (item === undefined || item.command.kind !== 'task' || item.phase === 'conflict' || waiters.has(id)) return;
    const command = item.command;
    const control = controller(true); waiters.set(id, control);
    const stamp = captureEpoch(epochs);
    pending.set(id, { ...item, phase: isReceiptRecovery(item) ? 'accepted' : 'reconciling', error: null }); emit();
    try {
      const operation = (await json({ kind: 'operation', session_id: command.session_id, operation_id: id }, control, validateOperationView)).value;
      const { api_version: _version, ...fields } = operation;
      const receipt = taskReceipt(command, fields);
      if (stamp.connection !== epochs.connection || !pending.has(id)) return;
      const observed = pending.get(id)!;
      if (observed.phase === 'conflict' || !receiptMatches(observed, receipt)) {
        pending.set(id, { ...observed, receipt: observed.receipt ?? receipt });
        fail('conflict');
      }
      const run = (await json({ kind: 'run', session_id: command.session_id, run_id: command.body.run_id }, control, validateRunView)).value;
      if (run.run_id !== command.body.run_id || run.user_text !== command.body.text || run.accepted_sequence !== receipt.first_sequence) fail('conflict');
      const history = (await json({ kind: 'history', session_id: command.session_id,
        after: cursorFor(command.session_id, (BigInt(receipt.first_sequence) - 1n).toString()), through: receipt.last_sequence }, control, validateHistoryView)).value;
      const [accepted, checkpoint] = history.events;
      if (history.session_id !== command.session_id || history.through_sequence !== receipt.last_sequence
        || history.next_after !== cursorFor(command.session_id, receipt.last_sequence) || history.has_more || history.events.length !== 2
        || accepted.kind !== 'run.accepted' || accepted.sequence !== receipt.first_sequence || accepted.run_id !== command.body.run_id
        || accepted.data.user_text !== command.body.text || checkpoint.kind !== 'checkpoint' || checkpoint.sequence !== receipt.last_sequence
        || checkpoint.run_id !== command.body.run_id || accepted.event_id === checkpoint.event_id) fail('conflict');
      if (stamp.connection !== epochs.connection || !pending.has(id)) return;
      const latest = pending.get(id)!;
      const canonical = { ...latest, canonical_sequence: latest.canonical_sequence ?? accepted.sequence };
      pending.set(id, canonical);
      // Canonical observation can arrive during any of the receipt reads.
      if (canonical.phase === 'conflict' || !receiptMatches(canonical, receipt)) {
        pending.set(id, { ...canonical, receipt: canonical.receipt ?? receipt });
        fail('conflict');
      }
      if (current(stamp) && selected?.session_id === command.session_id) {
        for (const event of history.events) {
          const known = selected.history.conversation.fingerprints.get(event.sequence);
          if (known !== undefined && known !== eventFingerprint(event)) fail('conflict');
        }
        selected.run_view = run;
        if (!pending.get(id)!.canonical_seen && draft === command.body.text) draft = '';
      }
      pending.set(id, { ...pending.get(id)!, phase: 'accepted', receipt, canonical_seen: true, error: null });
      finishTask(id); emit();
    } catch (cause) { if (stamp.connection === epochs.connection) commandFailure(id, cause, true); }
    finally { release(control); if (waiters.get(id) === control) waiters.delete(id); }
  }
  async function readRun(runId: string): Promise<void> {
    let sid: string;
    try { sid = selectionId(); validateUuid(runId); } catch (cause) { report(cause); return; }
    const stamp = captureEpoch(epochs); const control = controller(true);
    try {
      const { value } = await json({ kind: 'run', session_id: sid, run_id: runId }, control, validateRunView);
      if (value.run_id !== runId) fail('conflict');
      if (current(stamp) && selected !== null) {
        const known = selected.history.conversation.runs.get(runId);
        if (known !== undefined && (known.accepted_sequence !== value.accepted_sequence || known.accepted.user_text !== value.user_text)) fail('conflict');
        selected.run_view = value; emit();
      }
    } catch (cause) { if (current(stamp)) report(cause); }
    finally { release(control); }
  }
  async function cancelCurrentRun(): Promise<void> {
    let sid: string; let runId: string;
    try {
      sid = selectionId();
      if (selected!.cancelling) return;
      const run = selectDisplay(selected!.history.conversation).find(run => run.execution === 'accepted' || run.execution === 'running');
      if (run === undefined) fail('invalid_action');
      runId = run.run.run_id;
      const view = selected!.run_view;
      if (view?.run_id === runId && view.state !== 'accepted' && view.state !== 'running') fail('invalid_action');
    } catch (cause) { report(cause); return; }
    const stamp = captureEpoch(epochs); const control = controller();
    selected!.cancelling = true; emit();
    try {
      const { value, status } = await json({ kind: 'cancel', session_id: sid, run_id: runId }, control, validateCancelView, [200, 202], { kind: 'cancel' });
      if (value.session_id !== sid || value.run_id !== runId || (value.disposition === 'requested') !== (status === 202)) fail('conflict');
      if (current(stamp) && selected !== null) selected.cancel = value;
    } catch (cause) { if (current(stamp)) error = safeError(cause); }
    finally {
      release(control);
      if (current(stamp) && selected !== null) { selected.cancelling = false; emit(); }
    }
  }

  return {
    snapshot,
    createSession, renameSession, refreshCatalog, sendTask, reconcileTask, readRun, cancelCurrentRun,
    async retryCommand(id: string): Promise<void> {
      try {
        ready();
        const item = pending.get(id);
        if (item?.command.kind === 'task' && (item.canonical_sequence !== null || item.phase === 'conflict')) fail('invalid_action');
        await execute(id);
      } catch (cause) { report(cause); }
    },
    abortCommandWaiter(id: string): void { waiters.get(id)?.abort(); },
    discardCommand(id: string): void { waiters.get(id)?.abort(); pending.delete(id); emit(); },
    subscribe(listener: (state: ClientSnapshot) => void): () => void {
      listeners.add(listener);
      try { listener(snapshot()); } catch { /* A subscriber cannot change controller outcomes. */ }
      return () => { listeners.delete(listener); };
    },
    connect,
    disconnect: () => clear(),
    selectSession,
    async reloadHistory(): Promise<void> { if (selected !== null) await selectSession(selected.session_id); },
    reconnectObservation(): void {
      try { selectionId(); if (!selected!.history.complete) fail('invalid_action'); startObservation(); }
      catch (cause) { report(cause); }
    },
    async refreshSessions(): Promise<void> { try { ready(); await loadCatalog(false); } catch (cause) { report(cause); } },
    async loadMoreSessions(): Promise<void> { try { ready(); await loadCatalog(true); } catch (cause) { report(cause); } },
    setDraft(text: string): void {
      try { selectionId(); if (typeof text !== 'string') fail('invalid_action'); draft = text; emit(); }
      catch (cause) { report(cause); }
    },
  };
}

export type ClientController = ReturnType<typeof createClient>;
