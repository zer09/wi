import { validateUuid } from './api.js';
export function parseSessionHash(hash) {
    if (hash === '')
        return { kind: 'empty' };
    if (!hash.startsWith('#session='))
        return { kind: 'invalid' };
    try {
        return { kind: 'session', session_id: validateUuid(hash.slice(9)) };
    }
    catch {
        return { kind: 'invalid' };
    }
}
export function sessionHash(sessionId) { return `#session=${validateUuid(sessionId)}`; }
export function supportedOrigin(protocol, hostname) {
    if (protocol === 'https:')
        return true;
    if (protocol !== 'http:')
        return false;
    if (hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127'
        && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && BigInt(part) <= 255n);
}
export function errorText(error) {
    if (error === null)
        return '';
    switch (error.category) {
        case 'authentication': return 'Authorization failed. Local connection data was cleared. Connect again.';
        case 'invalid_token': return 'Enter exactly 64 lowercase hexadecimal characters. The token was not sent.';
        case 'network': return 'Network reply unavailable. This does not establish whether a command was accepted.';
        case 'aborted': return 'Local read stopped. This does not cancel server work or establish command acceptance.';
        case 'unsupported_client': return 'This browser does not provide the required secure client APIs.';
        case 'not_connected': return 'Connect before using this control.';
        case 'invalid_action': return 'This action is not available in the current state.';
        case 'workspace_forbidden': return 'Select a workspace returned by the authenticated service.';
        case 'conflict': return 'Command identity conflicts with the observed evidence. Do not submit it again as recovery.';
        case 'protocol': return `Observation rejected: ${error.detail}. The last valid prefix remains visible.`;
        case 'http': return `HTTP ${error.status}\nCode: ${error.server.code}\nStage: ${error.server.stage ?? 'none'}\nCertainty: ${error.server.certainty}`;
    }
}
export function receiptText(receipt) {
    return `Accepted receipt (not completion)\nOperation: ${receipt.operation_id}\nSession: ${receipt.session_id}\nRun: ${receipt.run_id ?? 'none'}\nSequences: ${receipt.first_sequence} to ${receipt.last_sequence}`;
}
export function commandControls(item, recovery = false) {
    const busy = item.phase === 'sending' || item.phase === 'reconciling';
    return {
        retry: !recovery && !busy && (item.phase === 'uncertain' || item.phase === 'rejected')
            && (item.command.kind !== 'task' || item.canonical_sequence === null),
        reconcile: !busy && item.command.kind === 'task' && item.phase !== 'conflict',
        discard: !recovery && !busy,
    };
}
export function nearBottom(scrollTop, clientHeight, scrollHeight) {
    return scrollHeight - clientHeight - scrollTop <= 64;
}
export function runStatus(run) {
    let recording = 'Final result not recorded';
    if (run.result_recorded)
        recording = 'Final result recorded';
    return `Execution: ${run.execution}. ${recording}.`;
}
function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}
function setText(node, text) {
    // Unchanged text must not replace focused descendants or retrigger live announcements.
    if (node.textContent !== text)
        node.textContent = text;
}
function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}
function submit(text) {
    const node = element('button', text);
    node.type = 'submit';
    return node;
}
function field(text, control) {
    const label = element('label', text);
    label.append(control);
    return label;
}
function details(label) {
    const node = element('details');
    node.append(element('summary', label));
    return node;
}
function noticesText(notices) {
    return notices.map(notice => `Notice: ${notice.kind}\nScope: ${notice.scope}\nSource: ${notice.source_label}`).join('\n\n');
}
function errorDetail(error) {
    let text = errorText(error);
    if (error?.category === 'http') {
        if (error.server.acceptance !== null)
            text += `\n${receiptText(error.server.acceptance)}`;
        if (error.server.notices.length > 0)
            text += `\n${noticesText(error.server.notices)}`;
    }
    return text;
}
function replyText(reply) {
    if (reply === null)
        return '';
    const lines = [];
    if ('duplicate' in reply)
        lines.push(`Duplicate receipt: ${reply.duplicate}`);
    if ('warning_code' in reply && reply.warning_code !== null)
        lines.push(`Warning: ${reply.warning_code}`);
    if ('catalog_refresh' in reply)
        lines.push(`Independent catalog refresh: ${reply.catalog_refresh}`);
    if ('disposition' in reply)
        lines.push(`Catalog refresh: ${reply.disposition}`);
    return lines.join('\n');
}
function resultText(result) {
    const outcome = result.outcome;
    return `Outcome: ${outcome.type}${outcome.type === 'failed' ? `\nCode: ${outcome.code}` : ''}\nEvents complete: ${result.events_complete}\nRecording sink error: ${result.sink_error ?? 'none'}\n${summaryText(result.summary)}`;
}
function summaryText(summary) {
    return Object.entries(summary).map(([name, value]) => `${name}: ${value ?? 'none'}`).join('\n');
}
// These lists retain their DOM nodes so streaming leaves focus and expanded details alone.
function keyedList(container, key, create) {
    const rows = new Map();
    return (values) => {
        const kept = new Set();
        let previous = null;
        for (const value of values) {
            const id = key(value);
            kept.add(id);
            let row = rows.get(id);
            if (row === undefined) {
                row = create(value);
                rows.set(id, row);
            }
            row.update(value);
            const next = previous === null ? container.firstElementChild : previous.nextElementSibling;
            if (next !== row.node)
                container.insertBefore(row.node, next);
            previous = row.node;
        }
        for (const [id, row] of rows) {
            if (!kept.has(id)) {
                row.node.remove();
                rows.delete(id);
            }
        }
    };
}
function sectionRow(section) {
    const collapsed = ['reasoning_summary', 'reasoning_text', 'function_arguments', 'custom_tool_input', 'tool_result'].includes(section.kind);
    const node = collapsed ? details(section.label) : element('section');
    const label = collapsed ? node.firstElementChild : element('h5');
    const metadata = element('p', '', 'metadata');
    const text = element('pre');
    if (!collapsed)
        node.append(label);
    node.append(metadata, text);
    return { node, update(value) {
            setText(label, `${value.label}${value.provisional ? ' (provisional)' : ''}`);
            const lines = [];
            if (value.is_error !== null)
                lines.push(`Result: ${value.is_error ? 'error' : 'success'}`);
            if (value.function_call !== null) {
                const call = value.function_call;
                lines.push(`Function: ${call.name}`, `Call: ${call.call_id}`, `Origin: ${call.origin}`, `Namespace: ${call.namespace ?? 'none'}`, `Arguments complete: ${call.complete}`);
            }
            setText(metadata, lines.join('\n'));
            metadata.hidden = lines.length === 0;
            setText(text, value.text);
        } };
}
function entryRow() {
    const node = element('section', '', 'entry');
    const heading = element('h4');
    const status = element('p', '', 'metadata');
    const content = element('div');
    const extra = details('Response metadata');
    const metadata = element('pre');
    extra.append(metadata);
    const sections = keyedList(content, value => JSON.stringify([value.kind, value.output_index, value.content_index, value.summary_index]), sectionRow);
    node.append(heading, status, content, extra);
    return { node, update(value) {
            sections(value.sections);
            extra.hidden = value.kind !== 'response';
            if (value.kind === 'tool') {
                const tool = value.tool;
                setText(heading, `Tool: ${tool.tool_name}`);
                let text = `Call: ${tool.call_id}\nExecution: started`;
                if (tool.finished !== null)
                    text += `; finished (${tool.finished.data.is_error ? 'error' : 'success'})`;
                text += tool.result === null ? '\nNo recorded result bytes.' : '\nResult bytes recorded.';
                if (tool.reuses.length > 0)
                    text += '\nReused recorded result; not another execution or result.';
                setText(status, text);
            }
            else {
                const response = value.response;
                const final = response.authoritative;
                setText(heading, 'Response');
                const lines = [`Response: ${response.response_id}`, `Status: ${final?.outcome.status ?? response.status ?? 'started'}`];
                if (final !== null) {
                    lines.push(`Output provenance: ${final.output_provenance}`, 'Response completion is not whole-run completion.');
                    if (final.outcome.status === 'incomplete')
                        lines.push(`Incomplete reason: ${final.outcome.reason ?? 'none'}`);
                }
                if (response.failure !== null)
                    lines.push(`Code: ${response.failure.data.code}`, `Upstream: ${response.failure.data.upstream_outcome}`);
                if (response.closed_sequence !== null)
                    lines.push('Response observation closed; not proof of completion.');
                setText(status, lines.join('\n'));
                let meta = `Model: ${final?.model ?? 'not supplied'}`;
                if (final?.usage != null)
                    meta += `\n${Object.entries(final.usage).map(([name, count]) => `${name}: ${count ?? 'none'}`).join('\n')}`;
                setText(metadata, meta);
            }
        } };
}
function runRow(value, client) {
    const node = element('article', '', 'run');
    const heading = element('h3', 'Run');
    const identity = element('p', '', 'metadata');
    const status = element('p');
    const user = element('pre', '', 'user-text');
    const content = element('div');
    const extra = details('Lifecycle and recording details');
    const metadata = element('pre');
    extra.append(metadata);
    const runId = value.run.run_id;
    const read = button('Read run status', () => { void client.readRun(runId); });
    const entries = keyedList(content, entry => `${entry.kind}:${entry.kind === 'response' ? entry.response.first_sequence : entry.tool.first_sequence}`, entryRow);
    node.append(heading, identity, status, element('h4', 'You'), user, content, extra, read);
    return { node, update(value) {
            setText(identity, `Run: ${value.run.run_id}\nAccepted at sequence: ${value.run.accepted_sequence}`);
            setText(status, runStatus(value));
            setText(user, value.user_text);
            entries(value.entries);
            const run = value.run;
            const lines = [`Provider: ${run.accepted.provider_id}`, `Model: ${run.accepted.model}`];
            for (const skill of run.accepted.active_skills)
                lines.push(`Active skill: ${skill}`);
            for (const [number, turn] of run.turns) {
                lines.push(`Turn ${number}: ${turn.finished === null ? 'started' : turn.finished.data.outcome.type}`);
                if (turn.finished !== null) {
                    lines.push(`Upstream: ${turn.finished.data.upstream_outcome ?? 'none'}`);
                    const outcome = turn.finished.data.outcome;
                    if (outcome.type === 'stopped')
                        lines.push(`Stopped: ${outcome.reason.type}${outcome.reason.type === 'failed' ? `; code: ${outcome.reason.code}` : ''}`);
                }
            }
            for (const observed of run.response_observations) {
                if (observed.kind === 'response.failed')
                    lines.push(`Response failure: ${observed.data.code}; upstream: ${observed.data.upstream_outcome}`);
                else
                    lines.push('Response observation closed; not proof of completion.');
            }
            if (run.finished !== null) {
                const outcome = run.finished.data.outcome;
                lines.push(`Terminal outcome: ${outcome.type}`);
                if (outcome.type === 'failed')
                    lines.push(`Code: ${outcome.code}`);
                lines.push(summaryText(run.finished.data.summary));
            }
            if (run.result !== null)
                lines.push(resultText(run.result.data));
            if (run.interrupted !== null)
                lines.push(`Stored interruption: ${run.interrupted.data.reason}. Partial output is retained.`);
            setText(metadata, lines.join('\n'));
        } };
}
export function mountView(root, client, navigate, originAllowed) {
    const heading = element('h1', 'Wi');
    const connection = element('p');
    connection.setAttribute('role', 'status');
    connection.setAttribute('aria-live', 'polite');
    const routeStatus = element('p');
    const error = element('pre', '', 'error');
    error.setAttribute('role', 'status');
    const top = element('header', '', 'topbar');
    const settings = element('p', '', 'metadata');
    const disconnect = button('Disconnect', () => client.disconnect());
    top.append(heading, connection, settings, disconnect);
    const login = element('section', '', 'login');
    const connectForm = element('form');
    connectForm.autocomplete = 'off';
    connectForm.noValidate = true;
    const token = element('input');
    token.type = 'password';
    token.autocomplete = 'off';
    token.spellcheck = false;
    token.setAttribute('autocapitalize', 'none');
    const connect = submit('Connect');
    connectForm.append(field('Owner token', token), connect);
    connectForm.addEventListener('submit', event => {
        event.preventDefault();
        if (connect.disabled)
            return;
        try {
            void client.connect(token.value);
        }
        finally {
            token.value = '';
        }
    });
    login.append(element('h2', 'Connect to Wi'), connectForm, element('p', 'Use the separate Wi owner token, not a provider credential. It stays in page memory only.'), element('p', 'Autocomplete suppression is best effort. Browser extensions and memory inspection are outside this protection.'));
    const layout = element('div', '', 'layout');
    const sessions = element('aside');
    sessions.setAttribute('aria-label', 'Sessions');
    const refreshList = button('Refresh list', () => { void client.refreshSessions(); });
    const loadMore = button('Load more sessions', () => { void client.loadMoreSessions(); });
    const catalogState = element('p', '', 'metadata');
    const catalog = element('ul', '', 'session-list');
    let catalogSelection = null;
    const updateCatalog = keyedList(catalog, value => value.session_id, value => {
        const node = element('li');
        const choose = button('', () => navigate(value.session_id));
        const info = element('p', '', 'metadata');
        node.append(choose, info);
        return { node, update(entry) {
                setText(choose, entry.title === '' ? '(Untitled session)' : entry.title);
                choose.setAttribute('aria-current', catalogSelection === entry.session_id ? 'true' : 'false');
                setText(info, `Session: ${entry.session_id}\nObserved head: ${entry.observed_head_sequence}\nAvailability: ${entry.availability}\nObserved run: ${entry.last_run_state ?? 'none'}${entry.fault_code === null ? '' : `\nCode: ${entry.fault_code}`}`);
            } };
    });
    const createForm = element('form');
    const title = element('textarea');
    title.rows = 2;
    const workspace = element('select');
    const create = submit('Create session');
    createForm.append(element('h3', 'New session'), field('Title', title), field('Workspace', workspace), create);
    createForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!create.disabled)
            void client.createSession(title.value, workspace.value);
    });
    sessions.append(element('h2', 'Sessions'), element('p', 'Catalog as of its last refresh. ID order, not activity order.'), refreshList, catalogState, catalog, loadMore, createForm);
    const conversation = element('section', '', 'conversation');
    const canonicalTitle = element('h2');
    canonicalTitle.setAttribute('aria-label', 'Canonical session title');
    const canonicalWorkspace = element('p', '', 'metadata');
    const selectedOnly = element('div');
    const renameForm = element('form');
    const renameTitle = element('textarea');
    renameTitle.rows = 2;
    let renameDirty = false;
    renameTitle.addEventListener('input', () => { renameDirty = true; });
    const rename = submit('Rename session');
    renameForm.append(field('Exact new title', renameTitle), rename);
    renameForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!rename.disabled)
            void client.renameSession(renameTitle.value);
    });
    const refreshCatalog = button('Refresh selected catalog entry', () => { void client.refreshCatalog(); });
    const reload = button('Reload history', () => { void client.reloadHistory(); });
    const reconnect = button('Reconnect observation', () => client.reconnectObservation());
    const reads = element('div', '', 'actions');
    reads.append(refreshCatalog, reload, reconnect);
    const observationError = element('pre', '', 'error');
    const cursor = element('p', '', 'metadata');
    const transcript = element('section', '', 'transcript');
    transcript.setAttribute('aria-label', 'Canonical conversation');
    transcript.tabIndex = 0;
    const empty = element('p');
    const runs = element('div');
    const updateRuns = keyedList(runs, value => value.run.run_id, value => runRow(value, client));
    transcript.append(empty, runs);
    const newContent = button('New content', () => {
        transcript.scrollTop = transcript.scrollHeight;
        newContent.hidden = true;
    });
    newContent.hidden = true;
    transcript.addEventListener('scroll', () => {
        if (nearBottom(transcript.scrollTop, transcript.clientHeight, transcript.scrollHeight))
            newContent.hidden = true;
    });
    const runRead = element('pre', '', 'metadata');
    const cancelReply = element('p', '', 'metadata');
    const composer = element('form');
    const draft = element('textarea');
    draft.rows = 5;
    const send = submit('Send');
    const cancel = button('Cancel current run', () => { void client.cancelCurrentRun(); });
    composer.append(field('Task', draft), element('p', 'Enter inserts a newline. Send or Ctrl/Cmd+Enter submits explicitly.'), send);
    draft.addEventListener('input', () => client.setDraft(draft.value));
    draft.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
            event.preventDefault();
            if (!event.repeat && !send.disabled)
                void client.sendTask();
        }
    });
    composer.addEventListener('submit', event => {
        event.preventDefault();
        if (!send.disabled)
            void client.sendTask();
    });
    selectedOnly.append(renameForm, reads, observationError, cursor, transcript, newContent, runRead, cancelReply, composer, cancel);
    conversation.append(canonicalTitle, canonicalWorkspace, selectedOnly);
    layout.append(sessions, conversation);
    const commands = element('section', '', 'commands');
    const pendingList = element('div');
    const recoveries = element('div');
    function commandRow(item, recovery) {
        const node = element('article', '', 'command');
        const label = element('h3');
        const identity = element('p', '', 'metadata');
        const captured = details('Captured command (not canonical transcript)');
        const body = element('pre');
        captured.append(body);
        const status = element('pre');
        const retry = button('Retry identical command', () => { void client.retryCommand(item.command.id); });
        const reconcile = button('Reconcile receipt (read only)', () => { void client.reconcileTask(item.command.id); });
        const discard = button('Discard local command', () => client.discardCommand(item.command.id));
        if (recovery)
            node.append(label, identity, status, reconcile);
        else
            node.append(label, identity, captured, status, retry, reconcile, discard);
        return { node, update(value) {
                const command = value.command;
                setText(label, recovery ? 'Canonical acceptance; receipt recovery' : `${command.kind}: ${value.phase}`);
                setText(identity, `Operation: ${command.id}\nSession: ${command.session_id ?? 'not yet known'}`);
                captured.hidden = recovery;
                let text = '';
                if (command.kind === 'task')
                    text = command.body.text;
                if (command.kind === 'create' || command.kind === 'rename')
                    text = command.body.title;
                if (!recovery)
                    setText(body, text);
                const lines = [errorDetail(value.error), replyText(value.reply), noticesText(value.notices)];
                if (command.kind === 'create')
                    lines.push(`Workspace: ${command.body.workspace}`);
                if (value.receipt !== null)
                    lines.push(receiptText(value.receipt));
                if (recovery)
                    lines.push('Canonical task already accepted. Only read-only reconciliation is available; do not execute again.');
                if (value.phase === 'uncertain')
                    lines.push('Acceptance is uncertain. A missing reply or receipt does not prove rollback.');
                if (value.phase === 'accepted')
                    lines.push('Accepted is not completed. Read canonical history for execution state.');
                setText(status, lines.filter(line => line !== '').join('\n\n'));
                const controls = commandControls(value, recovery);
                retry.hidden = !controls.retry;
                reconcile.hidden = !controls.reconcile;
                discard.hidden = !controls.discard;
            } };
    }
    const updatePending = keyedList(pendingList, value => value.command.id, value => commandRow(value, false));
    const updateRecoveries = keyedList(recoveries, value => value.command.id, value => commandRow(value, true));
    const lastOutcome = element('section');
    const outcomeText = element('pre');
    let outcomeSession = null;
    const openOutcome = button('Open receipt session', () => { if (outcomeSession !== null)
        navigate(outcomeSession); });
    lastOutcome.append(element('h3', 'Last command evidence'), outcomeText, openOutcome);
    commands.append(element('h2', 'Commands and receipts'), element('p', 'Pending commands are not saved messages. Retry sends the identical captured command. Discard only forgets local identity; it does not cancel or undo work.'), pendingList, recoveries, lastOutcome);
    const limits = element('p', 'Reload, session switches, or Disconnect lose unsent drafts. Reload or Disconnect also loses pending command memory. Server work continues. Selected history and DOM can grow; reloading rebuilds the selected history.', 'limits');
    root.replaceChildren(top, routeStatus, error, login, layout, commands, limits);
    let selectedId = null;
    let appliedCursor = null;
    let workspaces = [];
    function render(state) {
        const connected = state.connection === 'connected';
        login.hidden = connected;
        layout.hidden = !connected;
        commands.hidden = !connected;
        disconnect.hidden = state.connection === 'disconnected';
        settings.hidden = !connected;
        connect.disabled = state.connection === 'connecting' || !originAllowed;
        token.disabled = state.connection === 'connecting' || !originAllowed;
        const selected = state.selected;
        const observation = selected === null ? '' : `; observation: ${selected.observation}`;
        const lastRun = selected?.display.at(-1);
        const execution = lastRun === undefined ? '' : `; run: ${lastRun.execution}; result ${lastRun.result_recorded ? 'recorded' : 'not recorded'}`;
        setText(connection, `${state.connection}${observation}${execution}`);
        setText(error, originAllowed ? errorDetail(state.error) : 'Use HTTPS or literal-loopback HTTP to connect.');
        error.hidden = error.textContent === '';
        setText(settings, state.settings === null ? '' : `Provider: ${state.settings.provider_id}\nModel: ${state.settings.model}\nTransport: ${state.settings.provider_transport}`);
        if (!connected) {
            // Remove sensitive nodes as well as hiding them. No snapshot or form survives Disconnect/401.
            title.value = '';
            renameTitle.value = '';
            draft.value = '';
            token.value = '';
            workspace.replaceChildren();
            workspaces = [];
            renameDirty = false;
            updateCatalog([]);
            updateRuns([]);
            updatePending([]);
            updateRecoveries([]);
            outcomeSession = null;
            selectedId = null;
            catalogSelection = null;
            appliedCursor = null;
            for (const node of [canonicalTitle, canonicalWorkspace, observationError, cursor, runRead, cancelReply, outcomeText, catalogState, empty])
                setText(node, '');
            newContent.hidden = true;
            return;
        }
        if (JSON.stringify(workspaces) !== JSON.stringify(state.settings.workspaces)) {
            workspaces = state.settings.workspaces;
            workspace.replaceChildren(...workspaces.map(path => {
                const option = element('option', path);
                option.value = path;
                return option;
            }));
        }
        create.disabled = workspace.options.length === 0 || state.pending.some(item => item.command.kind === 'create' && item.phase === 'sending');
        refreshList.disabled = state.catalog_loading;
        loadMore.disabled = state.catalog_loading;
        loadMore.hidden = !state.catalog?.has_more;
        let catalogMessage = 'Catalog observation loaded.';
        if (state.catalog_loading)
            catalogMessage = 'Reading catalog…';
        else if (state.catalog?.entries.length === 0)
            catalogMessage = 'No sessions in this catalog observation.';
        setText(catalogState, catalogMessage);
        catalogSelection = selected?.session_id ?? null;
        updateCatalog(state.catalog?.entries ?? []);
        updatePending(state.pending);
        updateRecoveries(state.recoveries);
        const outcome = state.last_mutation;
        lastOutcome.hidden = outcome === null;
        outcomeSession = outcome?.session_id ?? null;
        setText(outcomeText, outcome === null ? '' : [
            `${outcome.kind} command`, outcome.receipt === null ? '' : receiptText(outcome.receipt), replyText(outcome.reply),
            noticesText(outcome.notices), errorDetail(outcome.canonical_read_error),
        ].filter(line => line !== '').join('\n\n'));
        selectedOnly.hidden = selected === null;
        let titleText = 'Select a session';
        if (selected !== null) {
            if (selected.title !== null)
                titleText = selected.title;
            else if (selected.observation === 'loading')
                titleText = 'Loading canonical session…';
            else
                titleText = 'Canonical session unavailable. Use Reload history to try again.';
        }
        setText(canonicalTitle, titleText);
        setText(canonicalWorkspace, selected === null ? '' : `Workspace: ${selected.workspace ?? 'not supplied'}\nSession: ${selected.session_id}`);
        if (selected === null)
            return;
        const switched = selectedId !== selected.session_id;
        if (switched) {
            selectedId = selected.session_id;
            renameDirty = false;
            updateRuns([]);
            newContent.hidden = true;
        }
        if (!renameDirty)
            renameTitle.value = selected.title ?? '';
        rename.disabled = selected.manifest === null || state.pending.some(item => item.command.kind === 'rename' && item.command.session_id === selectedId && item.phase === 'sending');
        refreshCatalog.disabled = state.pending.some(item => item.command.kind === 'refresh' && item.command.session_id === selectedId);
        reconnect.disabled = !selected.history_complete || selected.observation !== 'disconnected';
        setText(observationError, [errorDetail(selected.observation_error), selected.closed_reason === null ? '' : 'Server observation closed: shutdown. This is not task completion.'].filter(line => line !== '').join('\n'));
        observationError.hidden = observationError.textContent === '';
        setText(cursor, `Applied cursor: ${selected.applied_cursor}\nSnapshot head: ${selected.through_sequence ?? 'not yet read'}`);
        const follow = switched || nearBottom(transcript.scrollTop, transcript.clientHeight, transcript.scrollHeight);
        const oldTop = transcript.scrollTop;
        const changed = appliedCursor !== selected.applied_cursor;
        // Read failures can change status without advancing the applied cursor.
        let historyStatus = 'Canonical history incomplete. Loading stopped. Use Reload history to try again.';
        if (selected.history_complete)
            historyStatus = 'No messages yet.';
        else if (selected.observation === 'loading')
            historyStatus = 'Loading canonical history…';
        setText(empty, historyStatus);
        empty.hidden = selected.history_complete && selected.display.length !== 0;
        if (changed || switched) {
            updateRuns(selected.display);
            if (follow) {
                transcript.scrollTop = transcript.scrollHeight;
                newContent.hidden = true;
            }
            else {
                transcript.scrollTop = oldTop;
                newContent.hidden = false;
            }
            appliedCursor = selected.applied_cursor;
        }
        if (draft.value !== state.draft)
            draft.value = state.draft;
        send.disabled = selected.manifest === null || state.pending.some(item => item.command.kind === 'task'
            && item.command.session_id === selectedId && item.phase !== 'rejected');
        const active = selected.display.find(run => run.execution === 'accepted' || run.execution === 'running');
        const view = selected.run_view;
        cancel.disabled = active === undefined || selected.cancelling || (view !== null && view.run_id === active.run.run_id && view.state !== 'accepted' && view.state !== 'running');
        setText(cancel, selected.cancelling ? 'Requesting cancellation…' : 'Cancel current run');
        setText(cancelReply, selected.cancel === null ? '' : `Cancel disposition: ${selected.cancel.disposition}\nRun: ${selected.cancel.run_id}\nThis is a signal disposition, not terminal truth. Canonical run evidence determines the outcome.`);
        setText(runRead, view === null ? '' : `Read-only run view: ${view.run_id}\nExecution: ${view.state}\nResult recorded: ${view.result_recorded}\nTerminal sequence: ${view.terminal_sequence ?? 'none'}\nResult sequence: ${view.result_sequence ?? 'none'}${view.result === null ? '' : `\n${resultText(view.result)}`}`);
        runRead.hidden = view === null;
    }
    return { render, route(hash) {
            setText(routeStatus, hash.kind === 'invalid' ? 'Invalid session fragment ignored. Use only #session= followed by a lowercase session UUID.' : '');
            routeStatus.hidden = hash.kind !== 'invalid';
        } };
}
