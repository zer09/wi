import { ProtocolError, apiPath, readRequestInit, jsonRequestInit, requireMediaType, decodeJson, validateErrorView, validateUuid, validateSettingsView, validateSessionListView, validateSessionView, validateCreateCommand, validateRenameCommand, validateTaskCommand, validateCreateView, validateRenameView, validateRefreshView, validateRunView, validateCancelView, validateReceiptIdentity, } from './api.js';
import { displayPath, validateEntryId, validateConversationPage, validateEntryPage, validateDisplayTaskAccepted, validateTaskReconciliation, } from './display-api.js';
import { replaceLatest, mergeConversationPage, mergeEntryPage, applyConversationChanges, } from './display-store.js';
import { WiConversationSseParser } from './sse.js';
class Failure extends Error {
    safe;
    constructor(safe) {
        super(safe.category);
        this.safe = safe;
    }
}
function fail(category) { throw new Failure({ category }); }
function safeError(error) {
    if (error instanceof Failure)
        return error.safe;
    if (error instanceof ProtocolError)
        return { category: 'protocol', detail: error.category };
    return { category: 'network' };
}
function httpError(status, view) {
    return { category: 'http', status, server: {
            code: view.code, stage: view.stage, certainty: view.certainty, acceptance: view.acceptance, notices: view.notices,
        } };
}
function freeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
function snapshotValue(value) { return freeze(structuredClone(value)); }
function notices(previous, incoming) {
    const result = [...previous];
    for (const notice of incoming)
        if (!result.some(n => n.scope === notice.scope && n.source_label === notice.source_label && n.kind === notice.kind))
            result.push(notice);
    return result;
}
function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Failure({ category: 'aborted' }));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
function discardBody(response) { void response.body?.cancel().catch(() => { }); }
function routePath(route) {
    if (route.kind === 'conversation' || route.kind === 'entry' || route.kind === 'content'
        || route.kind === 'display_events' || route.kind === 'reconcile')
        return displayPath(route);
    return apiPath(route);
}
function olderRead(store) {
    const block = store.blocks[0];
    if (!block)
        return null;
    for (const entry of [block.human, ...block.entries]) {
        if (entry.content_complete)
            continue;
        // Byte coverage alone does not finish a rooted descriptor-layout chain.
        const cursor = entry.earlier_content ?? entry.content_traversal?.earlier_content;
        if (cursor != null)
            return { kind: 'content', run_id: entry.view.run_id, entry_id: entry.view.entry_id, cursor };
        return { kind: 'entry', run_id: entry.view.run_id, entry_id: entry.view.entry_id };
    }
    if (block.earlier_activity !== null)
        return { kind: 'within', cursor: block.earlier_activity };
    if (store.previous_block !== null)
        return { kind: 'before', cursor: store.previous_block };
    return null;
}
function loadedEntry(store, run, entry) {
    const block = store.blocks.find(b => b.view.run_id === run);
    if (block?.human.view.entry_id === entry)
        return block.human;
    return block?.entries.find(e => e.view.entry_id === entry);
}
function contentProgress(entry) {
    if (!entry)
        return '';
    return JSON.stringify({ epoch: entry.view.content_epoch, fields: entry.fields.map(({ revision: _revision, ...f }) => f),
        earlier: entry.earlier_content, start: entry.content_start_loaded, complete: entry.content_complete });
}
export function createDisplayClient(dependencies = {}) {
    const fetcher = dependencies.fetch ?? ((...args) => globalThis.fetch(...args));
    const crypto = dependencies.crypto === undefined ? globalThis.crypto : dependencies.crypto;
    let token = null, connectionEpoch = 0, selectionEpoch = 0, observationEpoch = 0;
    let connection = 'disconnected';
    let settings = null, catalog = null;
    let error = null, draft = '';
    let selected = null;
    const pending = new Map(), waiters = new Map();
    const requests = new Set(), selectionReads = new Set();
    const listeners = new Set();
    let catalogReader = null, streamReader = null, olderReader = null;
    const stamp = () => ({ connection: connectionEpoch, selection: selectionEpoch, observation: observationEpoch });
    const current = (s) => s.connection === connectionEpoch && s.selection === selectionEpoch && s.observation === observationEpoch;
    function snapshot() {
        return snapshotValue({ connection, settings, catalog, catalog_loading: catalogReader !== null, error, draft, pending: [...pending.values()], selected });
    }
    let publication = 0;
    function emit() {
        const identity = ++publication, value = snapshot();
        for (const listener of listeners) {
            // A nested publication already gave later views newer state.
            if (identity !== publication)
                break;
            try {
                listener(value);
            }
            catch { /* A view cannot change command or cursor publication. */ }
        }
    }
    function control(selection = false) { const c = new AbortController(); requests.add(c); if (selection)
        selectionReads.add(c); return c; }
    function release(c) { requests.delete(c); selectionReads.delete(c); }
    function clear(reason = null) {
        connectionEpoch++;
        selectionEpoch++;
        observationEpoch++;
        token = null;
        for (const c of requests)
            c.abort();
        requests.clear();
        selectionReads.clear();
        waiters.clear();
        pending.clear();
        catalogReader = null;
        streamReader = null;
        olderReader = null;
        connection = 'disconnected';
        settings = null;
        catalog = null;
        selected = null;
        draft = '';
        error = reason;
        emit();
    }
    function ready() { if (connection !== 'connected')
        fail('not_connected'); }
    function selectionId() { ready(); if (!selected)
        fail('invalid_action'); return selected.session_id; }
    function uuid() { if (typeof crypto?.randomUUID !== 'function')
        fail('unsupported_client'); try {
        return validateUuid(crypto.randomUUID());
    }
    catch {
        return fail('unsupported_client');
    } }
    function report(cause) { error = safeError(cause); emit(); }
    async function response(route, c, command) {
        if (token === null)
            fail('not_connected');
        const epoch = connectionEpoch, path = routePath(route);
        const init = command === undefined ? readRequestInit(token, route.kind === 'display_events' ? 'text/event-stream' : 'application/json') : jsonRequestInit(token, command);
        return abortable(Promise.resolve().then(() => {
            if (c.signal.aborted || epoch !== connectionEpoch)
                fail('aborted');
            return fetcher(path, { ...init, signal: c.signal });
        }).then(reply => {
            if (c.signal.aborted || epoch !== connectionEpoch) {
                discardBody(reply);
                fail('aborted');
            }
            if (reply.status === 401) {
                discardBody(reply);
                clear({ category: 'authentication' });
                fail('authentication');
            }
            return reply;
        }), c.signal);
    }
    async function readBody(reply, c) {
        if (reply.body === null)
            return '';
        const reader = reply.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
        const abort = () => { void reader.cancel().catch(() => { }); };
        c.signal.addEventListener('abort', abort, { once: true });
        let body = '';
        try {
            while (!c.signal.aborted) {
                const chunk = await abortable(reader.read(), c.signal);
                try {
                    body += decoder.decode(chunk.value, { stream: !chunk.done });
                }
                catch {
                    throw new ProtocolError('invalid_utf8');
                }
                if (chunk.done)
                    break;
            }
            if (c.signal.aborted)
                fail('aborted');
            return body;
        }
        finally {
            c.signal.removeEventListener('abort', abort);
            void reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
    async function json(route, c, validate, statuses = [200], command) {
        const reply = await response(route, c, command);
        try {
            requireMediaType(reply.headers.get('Content-Type'), 'application/json');
            const body = await readBody(reply, c);
            if (c.signal.aborted)
                fail('aborted');
            if (reply.status >= 400 && reply.status <= 599)
                throw new Failure(httpError(reply.status, decodeJson(body, reply.headers.get('Content-Type'), validateErrorView)));
            if (!statuses.includes(reply.status))
                throw new ProtocolError('invalid_schema');
            return { value: decodeJson(body, reply.headers.get('Content-Type'), validate), status: reply.status };
        }
        finally {
            discardBody(reply);
        }
    }
    async function loadCatalog(append) {
        if (append && (catalog === null || !catalog.has_more || catalogReader !== null))
            return;
        catalogReader?.abort();
        const c = control();
        catalogReader = c;
        const epoch = connectionEpoch, previous = append ? catalog : null, after = previous?.next_after_id ?? undefined;
        error = null;
        emit();
        try {
            const { value } = await json({ kind: 'sessions', after_id: after }, c, validateSessionListView);
            let last = after;
            for (const entry of value.entries) {
                if (last !== undefined && entry.session_id <= last)
                    throw new ProtocolError('invalid_cursor');
                last = entry.session_id;
            }
            const expected = value.entries.at(-1)?.session_id ?? null;
            if (value.entries.length > 32 || value.next_after_id !== expected || (value.has_more && expected === null))
                throw new ProtocolError('invalid_cursor');
            if (epoch === connectionEpoch && catalogReader === c)
                catalog = { ...value, entries: [...(previous?.entries ?? []), ...value.entries] };
        }
        catch (cause) {
            if (epoch === connectionEpoch && catalogReader === c)
                error = safeError(cause);
        }
        finally {
            release(c);
            if (catalogReader === c) {
                catalogReader = null;
                emit();
            }
        }
    }
    async function connect(secret) {
        // Bind ownership before clear publishes and a subscriber can replace this action.
        const epoch = connectionEpoch + 1;
        clear();
        if (epoch !== connectionEpoch)
            return;
        try {
            readRequestInit(secret);
        }
        catch {
            error = { category: 'invalid_token' };
            emit();
            return;
        }
        token = secret;
        connection = 'connecting';
        const c = control();
        emit();
        try {
            const { value } = await json({ kind: 'settings' }, c, validateSettingsView);
            if (epoch !== connectionEpoch)
                return;
            settings = value;
            await loadCatalog(false);
            if (epoch !== connectionEpoch)
                return;
            if (catalog === null) {
                clear(error);
                return;
            }
            connection = 'connected';
            emit();
        }
        catch (cause) {
            if (epoch === connectionEpoch)
                clear(safeError(cause));
        }
        finally {
            release(c);
        }
    }
    function stopSelection() {
        observationEpoch++;
        for (const c of selectionReads) {
            c.abort();
            release(c);
        }
        streamReader = null;
        olderReader = null;
        if (selected) {
            selected.older_loading = false;
            selected.cancelling = false;
        }
    }
    async function latest(sid, s) {
        if (!current(s) || selected?.session_id !== sid)
            return;
        const c = control(true);
        try {
            const { value } = await json({ kind: 'conversation', session_id: sid, query: { kind: 'latest' } }, c, v => validateConversationPage(v, { kind: 'latest' }, sid));
            const store = replaceLatest(value, sid);
            if (!current(s) || selected?.session_id !== sid)
                return;
            selected.store = store;
            selected.manifest = null;
            selected.content_operations = [];
            selected.older_error = null;
            selected.run_view = null;
            selected.cancel = null;
            // Publish B before even starting observation. No older read is admitted here.
            emit();
            startObservation(s);
        }
        catch (cause) {
            if (current(s) && selected?.session_id === sid) {
                selected.observation = 'disconnected';
                selected.observation_error = safeError(cause);
                emit();
            }
        }
        finally {
            release(c);
        }
    }
    async function selectSession(sid) {
        try {
            ready();
            validateUuid(sid);
        }
        catch (cause) {
            report(cause);
            return;
        }
        stopSelection();
        selectionEpoch++;
        selected = { session_id: sid, store: null, manifest: null, observation: 'loading', observation_error: null, closed_reason: null,
            older_loading: false, older_error: null, content_operations: [], run_view: null, cancel: null, cancelling: false };
        // A loading subscriber can select or rebase again before this action starts its read.
        const s = stamp();
        draft = '';
        error = null;
        emit();
        if (!current(s) || selected?.session_id !== sid)
            return;
        await latest(sid, s);
    }
    async function reconnectLatest() {
        let sid;
        try {
            sid = selectionId();
        }
        catch (cause) {
            report(cause);
            return;
        }
        stopSelection();
        const s = stamp();
        selected.observation = 'loading';
        selected.observation_error = null;
        selected.closed_reason = null;
        emit();
        if (!current(s) || selected?.session_id !== sid)
            return;
        await latest(sid, s);
    }
    function startObservation(s) {
        if (!current(s) || !selected?.store)
            return;
        const c = control(true);
        streamReader = c;
        const sid = selected.session_id, after = selected.store.live_after;
        selected.observation = 'connecting';
        selected.observation_error = null;
        emit();
        void observe(sid, after, s, c);
    }
    async function observe(sid, after, s, c) {
        let reader = null;
        const valid = () => current(s) && streamReader === c && !c.signal.aborted;
        const abort = () => { void reader?.cancel().catch(() => { }); };
        try {
            const reply = await response({ kind: 'display_events', session_id: sid, after }, c);
            if (reply.status !== 200) {
                try {
                    requireMediaType(reply.headers.get('Content-Type'), 'application/json');
                    const body = await readBody(reply, c);
                    if (reply.status < 400 || reply.status > 599)
                        throw new ProtocolError('invalid_schema');
                    throw new Failure(httpError(reply.status, decodeJson(body, reply.headers.get('Content-Type'), validateErrorView)));
                }
                finally {
                    discardBody(reply);
                }
            }
            try {
                requireMediaType(reply.headers.get('Content-Type'), 'text/event-stream');
            }
            catch (cause) {
                discardBody(reply);
                throw cause;
            }
            if (reply.body === null)
                throw new ProtocolError('invalid_sse');
            reader = reply.body.getReader();
            c.signal.addEventListener('abort', abort, { once: true });
            if (!valid())
                return;
            selected.observation = 'streaming';
            emit();
            const parser = new WiConversationSseParser(sid, record => {
                if (!valid() || !selected?.store)
                    return;
                if (record.kind === 'conversation')
                    selected.store = applyConversationChanges(selected.store, record.changes);
                else if (record.kind === 'error') {
                    if (record.error.code === 'api.unauthorized') {
                        clear({ category: 'authentication' });
                        return;
                    }
                    selected.observation_error = httpError(200, record.error);
                }
                else
                    selected.closed_reason = record.closed.reason;
                emit();
            });
            while (valid() && !parser.done) {
                const chunk = await abortable(reader.read(), c.signal);
                if (!valid())
                    return;
                if (chunk.done) {
                    parser.finish();
                    break;
                }
                parser.push(chunk.value);
            }
        }
        catch (cause) {
            if (valid() && selected)
                selected.observation_error = safeError(cause);
        }
        finally {
            c.signal.removeEventListener('abort', abort);
            if (reader) {
                void reader.cancel().catch(() => { });
                reader.releaseLock();
            }
            release(c);
            if (valid() && selected) {
                streamReader = null;
                selected.observation = 'disconnected';
                emit();
            }
        }
    }
    async function older(read, refresh = false) {
        const sid = selectionId();
        if (!selected?.store || olderReader !== null)
            return;
        const s = stamp(), c = control(true);
        olderReader = c;
        selected.older_loading = true;
        selected.older_error = null;
        emit();
        const valid = () => current(s) && olderReader === c && !c.signal.aborted;
        try {
            if (read.kind === 'before' || read.kind === 'within') {
                const { value } = await json({ kind: 'conversation', session_id: sid, query: read }, c, v => validateConversationPage(v, read, sid));
                if (!valid() || !selected?.store)
                    return;
                const before = selected.store, next = mergeConversationPage(before, value, read);
                const progress = read.kind === 'before' ? before.previous_block !== next.previous_block || before.blocks.length !== next.blocks.length
                    : before.blocks[0].earlier_activity !== next.blocks[0].earlier_activity || before.blocks[0].entries.length !== next.blocks[0].entries.length;
                if (!progress)
                    throw new ProtocolError('identity_mismatch');
                selected.store = next;
            }
            else {
                const expected = { session_id: sid, run_id: read.run_id, entry_id: read.entry_id };
                const route = read.kind === 'entry' ? { kind: 'entry', ...expected } : { kind: 'content', session_id: sid, cursor: read.cursor };
                const { value } = await json(route, c, v => validateEntryPage(v, expected));
                if (!valid() || !selected?.store)
                    return;
                const before = loadedEntry(selected.store, read.run_id, read.entry_id);
                const next = mergeEntryPage(selected.store, value, expected, read);
                const after = loadedEntry(next, read.run_id, read.entry_id);
                // Losing layout proof at a newer revision is not progress through an older boundary.
                const layoutProgress = after?.content_traversal != null
                    && JSON.stringify(before?.content_traversal) !== JSON.stringify(after.content_traversal);
                if (!refresh && before && BigInt(value.entry.revision) >= BigInt(before.view.revision)
                    && contentProgress(before) === contentProgress(after) && !layoutProgress)
                    throw new ProtocolError('identity_mismatch');
                selected.store = next;
                selected.content_operations = selected.content_operations.filter(op => op.run_id !== read.run_id || op.entry_id !== read.entry_id);
            }
        }
        catch (cause) {
            if (valid() && selected) {
                const failure = safeError(cause);
                if (read.kind === 'entry' || read.kind === 'content') {
                    const changed = failure.category === 'http' && failure.status === 409 && failure.server.code === 'api.conversation_cursor_stale';
                    selected.content_operations = [...selected.content_operations.filter(op => op.run_id !== read.run_id || op.entry_id !== read.entry_id),
                        { run_id: read.run_id, entry_id: read.entry_id, state: changed ? 'changed' : 'failed', error: failure }];
                }
                else
                    selected.older_error = failure;
            }
        }
        finally {
            release(c);
            if (valid() && selected) {
                olderReader = null;
                selected.older_loading = false;
                emit();
            }
        }
    }
    async function loadOlder() {
        try {
            selectionId();
            if (!selected?.store || olderReader !== null)
                return;
            const read = olderRead(selected.store);
            if (read === null)
                return;
            if ((read.kind === 'entry' || read.kind === 'content') && selected.content_operations.some(op => op.run_id === read.run_id && op.entry_id === read.entry_id && op.state === 'changed'))
                return;
            await older(read);
        }
        catch (cause) {
            report(cause);
        }
    }
    async function refreshEntry(runId, entryId) {
        try {
            selectionId();
            validateUuid(runId);
            validateEntryId(entryId);
            if (!selected?.store || !loadedEntry(selected.store, runId, entryId))
                fail('invalid_action');
            await older({ kind: 'entry', run_id: runId, entry_id: entryId }, true);
        }
        catch (cause) {
            report(cause);
        }
    }
    async function manifest(sid, s) {
        const c = control(true);
        try {
            const { value } = await json({ kind: 'session', session_id: sid }, c, validateSessionView);
            if (value.session_id !== sid)
                fail('conflict');
            if (current(s) && selected?.session_id === sid && (selected.manifest === null || BigInt(value.head_sequence) >= BigInt(selected.manifest.head_sequence))) {
                selected.manifest = value;
                emit();
            }
        }
        finally {
            release(c);
        }
    }
    function commandFailure(id, cause, readOnlyPhase = null, uncertainBefore = false) {
        const item = pending.get(id);
        if (!item)
            return;
        let failure = safeError(cause), receipt = item.receipt;
        const incoming = failure.category === 'http' ? failure.server.notices : [];
        if (failure.category === 'http' && failure.server.acceptance !== null && item.command.kind === 'task') {
            try {
                const actual = validateReceiptIdentity(failure.server.acceptance, { ...item.command.body, session_id: item.command.session_id });
                if (receipt !== null && JSON.stringify(receipt) !== JSON.stringify(actual))
                    fail('conflict');
                receipt = actual;
            }
            catch {
                failure = { category: 'conflict' };
            }
        }
        // A failed read changes diagnostics, not what we know about the original write.
        let phase = readOnlyPhase ?? 'uncertain';
        if (item.phase === 'accepted' || receipt !== null)
            phase = 'accepted';
        else if (readOnlyPhase === null && failure.category === 'http' && failure.server.certainty !== 'unknown' && !uncertainBefore)
            phase = 'rejected';
        if (item.phase === 'conflict' || failure.category === 'conflict'
            || (failure.category === 'http' && failure.server.code === 'storage.command_conflict'))
            phase = 'conflict';
        pending.set(id, { ...item, phase, receipt, notices: notices(item.notices, incoming), error: failure });
        emit();
    }
    function accepted(id, receipt, reply, incoming, s) {
        const item = pending.get(id);
        if (!item)
            return;
        if (item.phase === 'conflict' || (item.receipt !== null && JSON.stringify(item.receipt) !== JSON.stringify(receipt)))
            fail('conflict');
        pending.set(id, { ...item, phase: 'accepted', receipt, reply, notices: notices(item.notices, incoming), error: null });
        if (item.command.kind === 'task' && current(s) && selected?.session_id === item.command.session_id && draft === item.command.body.text && item.phase !== 'accepted')
            draft = '';
        emit();
    }
    async function execute(id) {
        const item = pending.get(id);
        if (!item || waiters.has(id))
            return;
        if (item.phase === 'accepted' || item.phase === 'conflict')
            fail('invalid_action');
        const command = item.command, c = control(), s = stamp();
        waiters.set(id, c);
        pending.set(id, { ...item, phase: 'sending', error: null });
        emit();
        const valid = () => s.connection === connectionEpoch && waiters.get(id) === c && pending.has(id);
        try {
            if (!valid())
                return;
            let reply, receipt = null, sid;
            let incoming = [];
            switch (command.kind) {
                case 'create': {
                    const result = await json({ kind: 'create' }, c, validateCreateView, [200, 201], command);
                    reply = result.value;
                    receipt = reply.receipt;
                    sid = reply.session_id;
                    if (reply.duplicate !== (result.status === 200) || receipt.operation_id !== command.id || receipt.first_sequence !== '1')
                        fail('conflict');
                    break;
                }
                case 'rename': {
                    const result = await json({ kind: 'rename', session_id: command.session_id }, c, validateRenameView, [200], command);
                    reply = result.value;
                    receipt = validateReceiptIdentity(reply.receipt, { session_id: command.session_id, operation_id: command.id, run_id: null });
                    sid = command.session_id;
                    break;
                }
                case 'refresh': {
                    const result = await json({ kind: 'refresh', session_id: command.session_id }, c, validateRefreshView, [200], command);
                    reply = result.value;
                    sid = command.session_id;
                    if (reply.session_id !== sid)
                        fail('conflict');
                    break;
                }
                case 'task': {
                    const result = await json({ kind: 'task', session_id: command.session_id }, c, v => validateDisplayTaskAccepted(v, { ...command.body, session_id: command.session_id }), [202], command);
                    reply = result.value;
                    receipt = reply.receipt;
                    incoming = reply.notices;
                    sid = command.session_id;
                    break;
                }
            }
            if (!valid())
                return;
            accepted(id, receipt, reply, incoming, s);
            if (!valid())
                return;
            if (command.kind !== 'task' && current(s) && selected?.session_id === sid) {
                try {
                    await manifest(sid, s);
                }
                catch (cause) {
                    if (valid() && current(s))
                        commandFailure(id, cause, 'accepted');
                }
            }
        }
        catch (cause) {
            if (valid())
                commandFailure(id, cause, null, item.phase === 'uncertain');
        }
        finally {
            release(c);
            if (waiters.get(id) === c)
                waiters.delete(id);
        }
    }
    function capture(command) {
        pending.set(command.id, { command: snapshotValue(command), phase: 'sending', receipt: null, reply: null, notices: [], error: null, reconciliation: null });
        return execute(command.id);
    }
    function duplicate(kind, sid, body) {
        for (const item of pending.values()) {
            const c = item.command;
            if (c.kind !== kind || c.session_id !== sid || item.phase === 'accepted' || item.phase === 'rejected')
                continue;
            if (kind === 'task' || kind === 'refresh')
                return true;
            if ((c.kind === 'create' || c.kind === 'rename') && c.body.title === body.title && (c.kind !== 'create' || c.body.workspace === body.workspace))
                return true;
        }
        return false;
    }
    async function createSession(title, workspace) {
        try {
            ready();
            if (!settings.workspaces.includes(workspace))
                fail('workspace_forbidden');
            if (duplicate('create', null, { title, workspace }))
                return;
            const id = uuid();
            await capture({ id, kind: 'create', session_id: null, body: validateCreateCommand({ operation_id: id, title, workspace }) });
        }
        catch (cause) {
            report(cause);
        }
    }
    async function renameSession(title) {
        try {
            const sid = selectionId();
            if (duplicate('rename', sid, { title }))
                return;
            const id = uuid();
            await capture({ id, kind: 'rename', session_id: sid, body: validateRenameCommand({ operation_id: id, title }) });
        }
        catch (cause) {
            report(cause);
        }
    }
    async function refreshCatalog() {
        try {
            const sid = selectionId();
            if (!duplicate('refresh', sid, {}))
                await capture({ id: uuid(), kind: 'refresh', session_id: sid, body: {} });
        }
        catch (cause) {
            report(cause);
        }
    }
    async function sendTask() {
        try {
            const sid = selectionId();
            if (duplicate('task', sid, {}))
                return;
            const id = uuid();
            await capture({ id, kind: 'task', session_id: sid, body: validateTaskCommand({ operation_id: id, run_id: uuid(), text: draft }) });
        }
        catch (cause) {
            report(cause);
        }
    }
    async function reconcileTask(id) {
        const item = pending.get(id);
        if (!item || item.command.kind !== 'task' || item.phase === 'conflict' || waiters.has(id))
            return;
        try {
            ready();
        }
        catch (cause) {
            report(cause);
            return;
        }
        const command = item.command, c = control(), s = stamp();
        waiters.set(id, c);
        pending.set(id, { ...item, phase: 'reconciling', error: null });
        emit();
        const valid = () => s.connection === connectionEpoch && waiters.get(id) === c && pending.has(id);
        try {
            if (!valid())
                return;
            const { value } = await json({ kind: 'reconcile', session_id: command.session_id }, c, v => validateTaskReconciliation(v, { ...command.body, session_id: command.session_id }), [200], command);
            if (!valid())
                return;
            const latest = pending.get(id);
            if (value.state === 'not_found') {
                // Point-in-time absence cannot revoke a known receipt or prove an unknown write rolled back.
                pending.set(id, { ...latest, phase: latest.receipt !== null ? 'accepted' : item.phase, reconciliation: 'not_found' });
            }
            else {
                accepted(id, value.acceptance, latest.reply, [], s);
                if (!valid())
                    return;
                pending.set(id, { ...pending.get(id), reconciliation: 'accepted' });
                if (current(s) && selected?.session_id === command.session_id)
                    selected.run_view = value.run;
            }
            emit();
        }
        catch (cause) {
            if (valid())
                commandFailure(id, cause, item.phase);
        }
        finally {
            release(c);
            if (waiters.get(id) === c)
                waiters.delete(id);
        }
    }
    async function readRun(runId) {
        let sid;
        try {
            sid = selectionId();
            validateUuid(runId);
        }
        catch (cause) {
            report(cause);
            return;
        }
        const s = stamp(), c = control(true);
        try {
            const { value } = await json({ kind: 'run', session_id: sid, run_id: runId }, c, validateRunView);
            if (value.run_id !== runId)
                fail('conflict');
            for (const item of pending.values())
                if (item.command.kind === 'task' && item.command.session_id === sid && item.command.body.run_id === runId && item.command.body.text !== value.user_text)
                    fail('conflict');
            if (current(s) && selected) {
                selected.run_view = value;
                emit();
            }
        }
        catch (cause) {
            if (current(s))
                report(cause);
        }
        finally {
            release(c);
        }
    }
    async function cancelCurrentRun() {
        let sid, runId;
        try {
            sid = selectionId();
            if (selected.cancelling)
                return;
            const run = selected.store?.blocks.find(b => b.view.state === 'accepted' || b.view.state === 'running');
            if (!run)
                fail('invalid_action');
            runId = run.view.run_id;
            const view = selected.run_view;
            if (view?.run_id === runId && view.state !== 'accepted' && view.state !== 'running')
                fail('invalid_action');
        }
        catch (cause) {
            report(cause);
            return;
        }
        const s = stamp(), c = control(true);
        selected.cancelling = true;
        emit();
        try {
            const { value, status } = await json({ kind: 'cancel', session_id: sid, run_id: runId }, c, validateCancelView, [200, 202], { kind: 'cancel' });
            if (value.session_id !== sid || value.run_id !== runId || (value.disposition === 'requested') !== (status === 202))
                fail('conflict');
            if (current(s) && selected)
                selected.cancel = value;
        }
        catch (cause) {
            if (current(s))
                error = safeError(cause);
        }
        finally {
            release(c);
            if (current(s) && selected) {
                selected.cancelling = false;
                emit();
            }
        }
    }
    return {
        snapshot, connect, disconnect: () => clear(), selectSession, reconnectLatest, loadOlder, refreshEntry,
        createSession, renameSession, refreshCatalog, sendTask, reconcileTask, readRun, cancelCurrentRun,
        async retryCommand(id) { try {
            ready();
            await execute(id);
        }
        catch (cause) {
            report(cause);
        } },
        abortCommandWaiter(id) { waiters.get(id)?.abort(); },
        discardCommand(id) { waiters.get(id)?.abort(); pending.delete(id); emit(); },
        async refreshSessions() { try {
            ready();
            await loadCatalog(false);
        }
        catch (cause) {
            report(cause);
        } },
        async loadMoreSessions() { try {
            ready();
            await loadCatalog(true);
        }
        catch (cause) {
            report(cause);
        } },
        setDraft(text) { try {
            selectionId();
            if (typeof text !== 'string')
                fail('invalid_action');
            draft = text;
            emit();
        }
        catch (cause) {
            report(cause);
        } },
        subscribe(listener) {
            listeners.add(listener);
            try {
                listener(snapshot());
            }
            catch { /* A subscriber cannot change controller outcomes. */ }
            return () => { listeners.delete(listener); };
        },
    };
}
