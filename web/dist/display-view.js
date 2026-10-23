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
export function sessionHash(sid) { return `#session=${validateUuid(sid)}`; }
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
function receiptText(r) {
    return `Accepted receipt (not completion)\nOperation: ${r.operation_id}\nSession: ${r.session_id}\nRun: ${r.run_id ?? 'none'}\nSequences: ${r.first_sequence} to ${r.last_sequence}`;
}
function noticesText(notices) {
    return notices.map(n => `Notice: ${n.kind}\nScope: ${n.scope}\nSource: ${n.source_label}`).join('\n\n');
}
export function errorText(error) {
    if (error === null)
        return '';
    switch (error.category) {
        case 'http': return [`HTTP ${error.status}`, `Code: ${error.server.code}`, `Stage: ${error.server.stage ?? 'none'}`,
            `Certainty: ${error.server.certainty}`, error.server.acceptance === null ? '' : receiptText(error.server.acceptance),
            noticesText(error.server.notices)].filter(Boolean).join('\n');
        case 'authentication': return 'Authorization failed. Local connection data was cleared. Connect again.';
        case 'invalid_token': return 'Invalid owner token format.';
        case 'network': return 'Network read or reply failed. This does not prove rollback.';
        case 'aborted': return 'Local wait stopped. Server work can continue.';
        case 'protocol': return `Protocol: ${error.detail}. Retained display is not proof of current state.`;
        case 'conflict': return 'Command or receipt identity conflict. Do not retry this command.';
        case 'unsupported_client': return 'Required browser capability unavailable.';
        case 'not_connected': return 'Connect first.';
        case 'invalid_action': return 'Action unavailable in the current selection.';
        case 'workspace_forbidden': return 'Workspace is not currently authorized.';
    }
}
export function hasOlder(store) {
    const block = store?.blocks[0];
    return block !== undefined && (store.previous_block !== null || block.earlier_activity !== null
        || [block.human, ...block.entries].some(e => !e.content_complete || !e.content_start_loaded || e.earlier_content !== null));
}
function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}
function text(node, value) {
    if (node.textContent === value)
        return false;
    node.textContent = value;
    return true;
}
function scrub(node) {
    // Blank held descendants before detachment makes them unreachable from the row.
    for (const child of [...node.children])
        scrub(child);
    if ('value' in node)
        node.value = '';
    for (let child = node.firstChild; child !== null; child = child.nextSibling)
        if (child.nodeType === 3)
            child.textContent = '';
    node.textContent = '';
}
function keyed(container, key, create) {
    const rows = new Map();
    return (values) => {
        let changed = false;
        const kept = new Set(values.map(key)), ordered = [];
        // Retire obsolete predecessors before they can cause a retained row to move.
        for (const [id, row] of rows)
            if (!kept.has(id)) {
                row.dispose();
                scrub(row.node);
                row.node.remove();
                rows.delete(id);
                changed = true;
            }
        for (const value of values) {
            const id = key(value);
            let row = rows.get(id);
            if (!row) {
                row = create(value);
                rows.set(id, row);
                changed = true;
            }
            changed = row.update(value) || changed;
            ordered.push(row.node);
        }
        // Moving the focused subtree blurs native controls and loses retained text selection.
        // Keep that row stationary and put its desired siblings on either side instead.
        const protectedIndex = ordered.findIndex(node => node.contains(container.ownerDocument.activeElement));
        let next = protectedIndex < 0 ? null : ordered[protectedIndex];
        for (let i = protectedIndex - 1; i >= 0; i--) {
            const node = ordered[i];
            if (node.nextElementSibling !== next)
                container.insertBefore(node, next);
            next = node;
        }
        let previous = protectedIndex < 0 ? null : ordered[protectedIndex];
        for (let i = protectedIndex + 1; i < ordered.length; i++) {
            const node = ordered[i];
            next = previous === null ? container.firstElementChild : previous.nextElementSibling;
            if (next !== node)
                container.insertBefore(node, next);
            previous = node;
        }
        return changed;
    };
}
const bytes = (value) => new TextEncoder().encode(value).length;
function characterAtByte(value, target) {
    let offset = 0n, index = 0;
    for (const scalar of value) {
        if (offset >= target)
            break;
        offset += BigInt(bytes(scalar));
        index += scalar.length;
    }
    return index;
}
function characterRect(node, index) {
    if (!node.firstChild || typeof document.createRange !== 'function')
        return null;
    const range = document.createRange();
    range.setStart(node.firstChild, Math.min(index, node.textContent.length));
    const scalar = node.textContent.codePointAt(index);
    range.setEnd(node.firstChild, Math.min(node.textContent.length, index + (scalar !== undefined && scalar > 0xffff ? 2 : 1)));
    const rect = range.getBoundingClientRect();
    return rect.height > 0 ? rect : null;
}
export function mountDisplayView(root, client, navigate, originAllowed, layout = { request: cb => requestAnimationFrame(cb), cancel: id => cancelAnimationFrame(id) }) {
    let disposed = false;
    const listeners = new Set();
    function on(node, name, callback, owned) {
        let active = true;
        const remove = () => {
            if (!active)
                return;
            active = false;
            node.removeEventListener(name, callback);
            // Removing the DOM listener alone would leave its element rooted by this mount.
            listeners.delete(remove);
            owned?.delete(remove);
        };
        node.addEventListener(name, callback);
        listeners.add(remove);
        owned?.add(remove);
        return remove;
    }
    function button(label, action, owned) {
        const node = element('button', label);
        node.type = 'button';
        on(node, 'click', () => { if (!disposed && !node.disabled)
            action(); }, owned);
        return node;
    }
    function label(name, control) { const node = element('label', name); node.append(control); return node; }
    function form(name, controls, action) {
        const node = element('form'), submit = element('button', name);
        submit.type = 'submit';
        node.append(...controls, submit);
        on(node, 'submit', event => { event.preventDefault(); if (!disposed && !submit.disabled)
            action(); });
        return { node, submit };
    }
    function details(name) { const node = element('details'); node.append(element('summary', name)); return node; }
    const rangeNodes = new Map();
    // Field nodes retain their disclosures; text ranges stay separate across missing bytes.
    function makeField(value, fieldKey) {
        const collapsed = ['reasoning_summary', 'reasoning_text', 'function_arguments', 'tool_result'].includes(value.kind);
        const node = collapsed ? details(value.kind) : element('section');
        node.dataset.field = value.field_id;
        const heading = collapsed ? node.firstElementChild : element('h5');
        const metadata = element('p', '', 'metadata'), content = element('div');
        if (!collapsed)
            node.append(heading);
        node.append(metadata, content);
        const partsList = keyed(content, p => p.key, part => {
            const node = part.gap ? element('p', '', 'metadata') : element('pre');
            node.dataset.range = part.key;
            return { node, dispose() { if (!part.gap)
                    rangeNodes.delete(node); }, update(p) {
                    if (!p.gap)
                        rangeNodes.set(node, { node: node, key: fieldKey, generation: p.generation, from: p.from, to: p.to, value: p.value });
                    return text(node, p.value);
                } };
        });
        return { node, dispose() { partsList([]); }, update(field) {
                text(heading, field.kind === 'unsupported' ? 'Unsupported content' : field.kind);
                heading.hidden = field.order_key === '0';
                text(metadata, `Recorded bytes: ${field.total_bytes}; generation: ${field.generation}`);
                const parts = [];
                let end = 0n;
                const add = (key, gap, value, from = '', to = '') => parts.push({ key, gap, value, from, to, generation: field.generation });
                for (const range of field.ranges) {
                    if (BigInt(range.from_byte) > end)
                        add(`gap:${end}`, true, `Missing bytes [${end}, ${range.from_byte})`);
                    add(`text:${range.from_byte}`, false, range.text, range.from_byte, range.to_byte);
                    end = BigInt(range.to_byte);
                }
                if (end < BigInt(field.total_bytes))
                    add(`gap:${end}`, true, `Missing bytes [${end}, ${field.total_bytes})`);
                if (field.total_bytes === '0')
                    add('empty', true, 'Recorded empty content.');
                return partsList(parts);
            } };
    }
    function entryRow(value) {
        const node = element('section', '', 'entry');
        node.dataset.entry = value.view.entry_id;
        const heading = element('h4'), status = element('p', '', 'metadata'), content = element('div'), partial = element('p', '', 'metadata');
        const failure = element('pre', '', 'error');
        const run = value.view.run_id, id = value.view.entry_id;
        const owned = new Set();
        const refresh = button('Refresh this entry', () => { stopFill(); void client.refreshEntry(run, id); }, owned);
        const fields = keyed(content, f => f.field_id, f => makeField(f, JSON.stringify([run, id, f.field_id])));
        node.append(heading, status, partial, content, failure, refresh);
        return { node, dispose() { for (const remove of owned)
                remove(); fields([]); }, update(e) {
                text(heading, e.view.kind === 'human' ? 'Human' : e.view.kind);
                const facts = [`Recorded state: ${e.view.recorded_state}`, `Provisional: ${e.view.provisional}`];
                for (const name of ['result_recorded', 'finish_recorded', 'is_error'])
                    if (e.view[name] !== null)
                        facts.push(`${name}: ${e.view[name]}`);
                if (e.view.reference !== null)
                    facts.push(`Recorded reuse reference: ${e.view.reference.run_id}/${e.view.reference.entry_id}. Not another execution.`);
                text(status, facts.join('; '));
                text(partial, e.content_complete ? 'Content complete.' : 'Content or field descriptors incomplete. Reads do not imply execution completion.');
                if (!e.content_start_loaded)
                    text(partial, `${partial.textContent} Earlier field descriptors are not loaded.`);
                if (e.fields.length === 0)
                    text(partial, `${partial.textContent} No recorded content loaded.`);
                partial.hidden = e.content_complete && e.content_start_loaded && e.fields.length > 0;
                const op = current?.selected?.content_operations.find(o => o.run_id === run && o.entry_id === id);
                text(failure, op ? `${op.state === 'changed' ? 'Content changed. Refresh this entry explicitly.' : 'Content read failed.'}\n${errorText(op.error)}` : '');
                failure.hidden = !op;
                refresh.hidden = !op;
                refresh.disabled = current?.selected?.older_loading ?? true;
                return fields(e.fields);
            } };
    }
    function blockRow(value) {
        const node = element('article', '', 'run');
        node.dataset.run = value.view.run_id;
        const status = element('p', '', 'metadata'), human = element('div'), entries = element('div');
        const extra = details('Lifecycle and recording details'), facts = element('pre');
        extra.append(facts);
        const runId = value.view.run_id;
        const owned = new Set();
        const read = button('Read run status', () => { void client.readRun(runId); }, owned);
        const updateHuman = keyed(human, e => e.view.entry_id, entryRow), updateEntries = keyed(entries, e => e.view.entry_id, entryRow);
        node.append(status, human, entries, extra, read);
        return { node, dispose() { for (const remove of owned)
                remove(); updateHuman([]); updateEntries([]); }, update(b) {
                text(status, `Execution: ${b.view.state}. Final result ${b.view.result_recorded ? 'recorded' : 'not recorded'}.`);
                const outcome = b.view.outcome;
                text(facts, [`Run: ${b.view.run_id}`, `Accepted sequence: ${b.view.accepted_sequence}`, `Outcome: ${outcome?.type ?? 'not recorded'}`,
                    outcome?.type === 'failed' ? `Code: ${outcome.code}` : '', `Events complete: ${b.view.events_complete ?? 'not recorded'}`,
                    `Sink error: ${b.view.sink_error ?? 'none'}`, b.view.summary === null ? 'Summary not recorded.' : Object.entries(b.view.summary).map(([k, v]) => `${k}: ${v ?? 'none'}`).join('\n')].filter(Boolean).join('\n'));
                const changed = updateHuman([b.human]);
                return updateEntries(b.entries) || changed;
            } };
    }
    const connection = element('p');
    connection.setAttribute('role', 'status');
    connection.setAttribute('aria-live', 'polite');
    const error = element('pre', '', 'error'), routeStatus = element('p'), settings = element('p', '', 'metadata');
    const disconnect = button('Disconnect', () => client.disconnect()), top = element('header', '', 'topbar');
    top.append(element('h1', 'Wi'), connection, settings, disconnect);
    const token = element('input');
    token.type = 'password';
    token.autocomplete = 'off';
    token.spellcheck = false;
    token.setAttribute('autocapitalize', 'none');
    const login = element('section', '', 'login');
    const connect = form('Connect', [label('Owner token', token)], () => { try {
        void client.connect(token.value);
    }
    finally {
        token.value = '';
    } });
    connect.node.autocomplete = 'off';
    connect.node.noValidate = true;
    login.append(connect.node, element('p', 'Use the Wi owner token, not a provider credential. Full page refresh needs Connect again; the token stays in memory only.'));
    const layoutNode = element('div', '', 'layout'), sessions = element('aside'), catalog = element('ul', '', 'session-list');
    sessions.setAttribute('aria-label', 'Sessions');
    const refreshList = button('Refresh list', () => { void client.refreshSessions(); }), more = button('Load more sessions', () => { void client.loadMoreSessions(); });
    const catalogState = element('p', '', 'metadata');
    const catalogRows = keyed(catalog, e => e.session_id, e => {
        const sid = e.session_id, owned = new Set();
        const node = element('li'), choose = button('', () => navigate(sid), owned), facts = element('p', '', 'metadata');
        node.append(choose, facts);
        return { node, dispose() { for (const remove of owned)
                remove(); }, update(value) {
                text(choose, value.title || '(Untitled session)');
                choose.setAttribute('aria-current', current?.selected?.session_id === value.session_id ? 'true' : 'false');
                text(facts, `Observed head: ${value.observed_head_sequence}\nAvailability: ${value.availability}\nObserved run: ${value.last_run_state ?? 'none'}\nCode: ${value.fault_code ?? 'none'}`);
                return false;
            } };
    });
    const title = element('textarea'), workspace = element('select');
    title.rows = 2;
    const create = form('Create session', [label('Title', title), label('Workspace', workspace)], () => { void client.createSession(title.value, workspace.value); });
    sessions.append(element('h2', 'Sessions'), element('p', 'Catalog as of its last refresh. ID order, not activity order.'), refreshList, catalogState, catalog, more, create.node);
    const conversation = element('section', '', 'conversation'), canonicalTitle = element('h2'), canonicalWorkspace = element('p', '', 'metadata'), selectedOnly = element('div');
    canonicalTitle.setAttribute('aria-label', 'Canonical session title');
    const renameTitle = element('textarea');
    renameTitle.rows = 2;
    let renameDirty = false;
    on(renameTitle, 'input', () => { renameDirty = true; });
    const rename = form('Rename session', [label('Exact new title', renameTitle)], () => { void client.renameSession(renameTitle.value); });
    const refreshCatalog = button('Refresh selected catalog entry', () => { void client.refreshCatalog(); });
    const reconnect = button('Reconnect latest', () => { void client.reconnectLatest(); });
    const older = button('Load older', () => requestOlder()), observation = element('p', '', 'metadata'), olderStatus = element('pre', '', 'error');
    observation.setAttribute('role', 'status');
    observation.setAttribute('aria-live', 'polite');
    const observationError = element('pre', '', 'error'), transcript = element('section', '', 'transcript');
    transcript.setAttribute('aria-label', 'Canonical conversation');
    transcript.tabIndex = 0;
    const empty = element('p'), blocks = element('div');
    transcript.append(empty, blocks);
    const blockRows = keyed(blocks, b => b.view.run_id, blockRow);
    const newContent = button('New content', () => { transcript.scrollTop = transcript.scrollHeight; newContent.hidden = true; });
    newContent.hidden = true;
    const draft = element('textarea');
    draft.rows = 5;
    const composer = form('Send', [label('Task', draft), element('p', 'Enter inserts a newline. Ctrl/Cmd+Enter sends once.')], () => { void client.sendTask(); });
    on(draft, 'input', () => client.setDraft(draft.value));
    on(draft, 'keydown', event => {
        const e = event;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            if (!e.repeat && !composer.submit.disabled)
                void client.sendTask();
        }
    });
    const cancel = button('Cancel current run', () => { void client.cancelCurrentRun(); }), runRead = element('pre', '', 'metadata'), cancelReply = element('p');
    const actions = element('div', '', 'actions');
    actions.append(refreshCatalog, reconnect, older);
    selectedOnly.append(rename.node, actions, observation, transcript, newContent, observationError, olderStatus, runRead, cancelReply, composer.node, cancel);
    conversation.append(canonicalTitle, canonicalWorkspace, selectedOnly);
    layoutNode.append(sessions, conversation);
    const commands = element('section', '', 'commands'), commandList = element('div');
    commands.append(element('h2', 'Commands and receipts'), element('p', 'Pending Tasks are not saved messages. Retry keeps the exact captured body. Discard does not cancel or undo server work.'), commandList);
    const commandRows = keyed(commandList, p => p.command.id, p => {
        const id = p.command.id, node = element('article', '', 'command'), heading = element('h3'), identity = element('p', '', 'metadata');
        const captured = details('Captured command (not canonical transcript)'), body = element('pre'), status = element('pre');
        captured.append(body);
        const owned = new Set();
        const retry = button('Retry identical command', () => { void client.retryCommand(id); }, owned);
        const reconcile = button('Reconcile receipt (read only)', () => { void client.reconcileTask(id); }, owned);
        const discard = button('Discard local command', () => client.discardCommand(id), owned);
        const open = button('Open receipt session', () => { const sid = current?.pending.find(p => p.command.id === id)?.receipt?.session_id; if (sid)
            navigate(sid); }, owned);
        node.append(heading, identity, captured, status, retry, reconcile, discard, open);
        return { node, dispose() { for (const remove of owned)
                remove(); }, update(item) {
                text(heading, `${item.command.kind}: ${item.phase}`);
                text(identity, `Operation: ${id}\nSession: ${item.command.session_id ?? 'not yet known'}`);
                const c = item.command;
                let capturedText = '';
                if (c.kind === 'task')
                    capturedText = c.body.text;
                else if (c.kind !== 'refresh')
                    capturedText = c.body.title;
                text(body, capturedText);
                const lines = [errorText(item.error), noticesText(item.notices), item.receipt === null ? '' : receiptText(item.receipt)];
                if (item.reply && 'warning_code' in item.reply)
                    lines.push(`Warning: ${item.reply.warning_code ?? 'none'}; duplicate: ${item.reply.duplicate}`);
                if (item.reply && 'catalog_refresh' in item.reply)
                    lines.push(`Independent catalog refresh: ${item.reply.catalog_refresh}`);
                if (item.reply && 'disposition' in item.reply)
                    lines.push(`Catalog refresh: ${item.reply.disposition}`);
                if (item.reconciliation)
                    lines.push(`Reconciliation: ${item.reconciliation}${item.reconciliation === 'not_found' ? '. Point-in-time absence, not rollback proof.' : ''}`);
                if (item.phase === 'uncertain')
                    lines.push('Acceptance is uncertain. No automatic retry.');
                if (item.phase === 'accepted')
                    lines.push('Accepted is not completed.');
                text(status, lines.filter(Boolean).join('\n\n'));
                const busy = item.phase === 'sending' || item.phase === 'reconciling';
                retry.hidden = busy || item.receipt !== null || !['uncertain', 'rejected'].includes(item.phase);
                reconcile.hidden = busy || c.kind !== 'task' || item.phase === 'conflict';
                discard.hidden = busy;
                open.hidden = item.receipt === null;
                return false;
            } };
    });
    root.replaceChildren(top, routeStatus, error, login, layoutNode, commands);
    let current = null, owner = 0, frame = null, filling = false, upward = 0, intent = false;
    let touchY = null;
    function cancelLayout() { if (frame !== null)
        layout.cancel(frame); frame = null; intent = false; upward = 0; }
    function stopFill() { filling = false; cancelLayout(); }
    function requestOlder() { stopFill(); if (!disposed && current?.selected?.store && !current.selected.older_loading && hasOlder(current.selected.store))
        void client.loadOlder(); }
    function schedule() {
        if (disposed || frame !== null)
            return;
        const stamp = owner, sid = current?.selected?.session_id;
        const id = layout.request(() => {
            if (frame !== id)
                return;
            frame = null;
            if (disposed || stamp !== owner || sid !== current?.selected?.session_id || !current?.selected?.store || current.selected.observation === 'loading')
                return;
            const selected = current.selected;
            if (selected.older_error || selected.content_operations.length > 0) {
                stopFill();
                return;
            }
            if (!hasOlder(selected.store)) {
                stopFill();
                return;
            }
            if (selected.older_loading)
                return;
            // Only initial installation can chain. Later human intent admits one read.
            if (filling) {
                if (transcript.scrollHeight > transcript.clientHeight) {
                    stopFill();
                    return;
                }
                void client.loadOlder();
            }
            else if (intent) {
                intent = false;
                if (upward >= 96 && transcript.scrollTop <= 96)
                    requestOlder();
            }
        });
        frame = id;
    }
    function movement(amount) {
        if (amount <= 0) {
            upward = 0;
            return;
        }
        filling = false;
        upward += amount;
        intent = true;
        schedule();
    }
    on(transcript, 'wheel', event => { const e = event; if (e.isTrusted)
        movement(-e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? transcript.clientHeight : 1)); });
    on(transcript, 'touchstart', event => { const e = event; if (e.isTrusted)
        touchY = e.touches[0]?.clientY ?? null; });
    on(transcript, 'touchmove', event => { const e = event; const y = e.touches[0]?.clientY; if (e.isTrusted && touchY !== null && y !== undefined) {
        movement(y - touchY);
        touchY = y;
    } });
    on(transcript, 'keydown', event => {
        const e = event;
        if (!e.isTrusted || e.target !== transcript || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat)
            return;
        if (e.key === 'ArrowUp')
            movement(40);
        else if (e.key === 'PageUp')
            movement(transcript.clientHeight);
        else if (e.key === 'Home')
            movement(96);
    });
    on(transcript, 'scroll', () => { if (transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 24)
        newContent.hidden = true; });
    function anchor() {
        const top = transcript.getBoundingClientRect().top;
        for (const pre of transcript.querySelectorAll('pre')) {
            const r = rangeNodes.get(pre), rect = pre.getBoundingClientRect();
            if (!r || rect.bottom <= top || rect.top >= top + transcript.clientHeight || rect.height === 0)
                continue;
            // Find a visible scalar in actual laid-out text, including a loaded suffix later expanded above it.
            let index = 0;
            if (rect.top < top && typeof document.createRange === 'function') {
                let low = 0, high = r.value.length;
                while (low < high) {
                    let mid = Math.floor((low + high) / 2);
                    if (mid > 0 && /[\uDC00-\uDFFF]/.test(r.value[mid]))
                        mid--;
                    const box = characterRect(pre, mid);
                    if (box && box.bottom <= top)
                        low = mid + (r.value.codePointAt(mid) > 0xffff ? 2 : 1);
                    else
                        high = mid;
                }
                index = low;
            }
            const box = characterRect(pre, index);
            return { node: pre, key: r.key, generation: r.generation, byte: BigInt(r.from) + BigInt(bytes(r.value.slice(0, index))), y: (box?.top ?? rect.top) - top };
        }
        for (const node of transcript.querySelectorAll('.entry, .run')) {
            const rect = node.getBoundingClientRect();
            if (rect.bottom > top && rect.height > 0)
                return { node, y: rect.top - top };
        }
        return null;
    }
    function restore(a, oldTop) {
        const top = transcript.getBoundingClientRect().top;
        if (a?.key !== undefined)
            for (const r of rangeNodes.values()) {
                if (!transcript.contains(r.node) || r.key !== a.key || r.generation !== a.generation || a.byte < BigInt(r.from) || a.byte >= BigInt(r.to))
                    continue;
                const rect = characterRect(r.node, characterAtByte(r.value, a.byte - BigInt(r.from))) ?? r.node.getBoundingClientRect();
                transcript.scrollTop += rect.top - top - a.y;
                return;
            }
        if (a && transcript.contains(a.node)) {
            transcript.scrollTop += a.node.getBoundingClientRect().top - top - a.y;
            return;
        }
        transcript.scrollTop = oldTop;
    }
    function render(state) {
        if (disposed)
            return;
        const previous = current, selected = state.selected;
        const switched = selected?.session_id !== previous?.selected?.session_id;
        const loading = selected?.observation === 'loading' && (switched || previous?.selected?.observation !== 'loading');
        const installed = !!selected?.store && (switched || !previous?.selected?.store || (selected.observation === 'connecting' && previous?.selected?.observation === 'loading'));
        if (switched || loading || state.connection !== 'connected') {
            owner++;
            stopFill();
        }
        const oldTop = transcript.scrollTop, atBottom = transcript.scrollHeight - transcript.clientHeight - oldTop <= 24, saved = anchor();
        current = state;
        const connected = state.connection === 'connected';
        login.hidden = connected;
        layoutNode.hidden = !connected;
        commands.hidden = !connected;
        disconnect.hidden = state.connection === 'disconnected';
        connect.submit.disabled = state.connection === 'connecting' || !originAllowed;
        token.disabled = connect.submit.disabled;
        text(connection, `${state.connection}${selected ? `; observation: ${selected.observation}` : ''}`);
        text(error, originAllowed ? errorText(state.error) : 'Use HTTPS or literal-loopback HTTP to connect.');
        error.hidden = error.textContent === '';
        text(settings, state.settings ? `Provider: ${state.settings.provider_id}\nModel: ${state.settings.model}\nTransport: ${state.settings.provider_transport}` : '');
        if (!connected) {
            for (const control of [token, title, renameTitle, draft])
                control.value = '';
            scrub(workspace);
            catalogRows([]);
            blockRows([]);
            commandRows([]);
            rangeNodes.clear();
            renameDirty = false;
            for (const node of [canonicalTitle, canonicalWorkspace, catalogState, observation, observationError, olderStatus, empty, runRead, cancelReply])
                text(node, '');
            newContent.hidden = true;
            touchY = null;
            return;
        }
        if (switched) {
            renameDirty = false;
            blockRows([]);
            rangeNodes.clear();
            newContent.hidden = true;
        }
        const paths = state.settings.workspaces;
        if (JSON.stringify([...workspace.options].map(o => o.value)) !== JSON.stringify(paths)) {
            scrub(workspace);
            workspace.replaceChildren(...paths.map(p => { const o = element('option', p); o.value = p; return o; }));
        }
        refreshList.disabled = state.catalog_loading;
        more.disabled = state.catalog_loading;
        more.hidden = !state.catalog?.has_more;
        let catalogMessage = 'Catalog observation loaded.';
        if (state.catalog_loading)
            catalogMessage = 'Reading catalog…';
        else if (state.catalog?.entries.length === 0)
            catalogMessage = 'No sessions in this catalog observation.';
        text(catalogState, catalogMessage);
        catalogRows(state.catalog?.entries ?? []);
        commandRows(state.pending);
        create.submit.disabled = workspace.options.length === 0 || state.pending.some(p => p.command.kind === 'create' && p.phase === 'sending');
        selectedOnly.hidden = selected === null;
        let manifest = selected?.store?.session;
        if (selected?.manifest && (!manifest || BigInt(selected.manifest.head_sequence) >= BigInt(manifest.head_sequence)))
            manifest = selected.manifest;
        text(canonicalTitle, manifest?.title ?? (selected ? 'Preparing conversation…' : 'Select a session'));
        text(canonicalWorkspace, selected ? `Workspace: ${manifest?.workspace ?? 'not supplied'}\nSession: ${selected.session_id}` : '');
        if (!selected) {
            draft.value = '';
            return;
        }
        if (!renameDirty && renameTitle.value !== manifest?.title)
            renameTitle.value = manifest?.title ?? '';
        rename.submit.disabled = !manifest || state.pending.some(p => p.command.kind === 'rename' && p.command.session_id === selected.session_id && p.phase === 'sending');
        refreshCatalog.disabled = state.pending.some(p => p.command.kind === 'refresh' && p.command.session_id === selected.session_id && p.phase === 'sending');
        reconnect.disabled = selected.observation === 'loading';
        text(observation, selected.observation === 'loading' ? 'Preparing conversation… Retained content is stale.' : `Observation: ${selected.observation}${selected.observation === 'disconnected' ? '. Retained window is stale; Reconnect latest reads fresh canonical state.' : ''}`);
        text(observationError, [errorText(selected.observation_error), selected.closed_reason ? 'Server observation closed: shutdown. Not task completion.' : ''].filter(Boolean).join('\n'));
        observationError.hidden = observationError.textContent === '';
        text(olderStatus, selected.older_loading ? 'Reading one older unit…' : errorText(selected.older_error));
        olderStatus.hidden = olderStatus.textContent === '';
        older.disabled = selected.older_loading || selected.observation === 'loading' || !hasOlder(selected.store);
        text(empty, selected.store === null ? 'Preparing conversation…' : 'No messages yet.');
        empty.hidden = (selected.store?.blocks.length ?? 0) > 0;
        const changed = blockRows(selected.store?.blocks ?? []);
        for (const pre of rangeNodes.keys())
            if (!transcript.contains(pre))
                rangeNodes.delete(pre);
        if (installed) {
            filling = true;
            transcript.scrollTop = transcript.scrollHeight;
            newContent.hidden = true;
        }
        else if (changed || saved) {
            const backward = previous?.selected?.older_loading;
            if (atBottom && (!backward || filling) && changed)
                transcript.scrollTop = transcript.scrollHeight;
            else {
                restore(saved, oldTop);
                if (changed && previous?.selected?.store?.live_after !== selected.store?.live_after)
                    newContent.hidden = false;
            }
        }
        if (draft.value !== state.draft)
            draft.value = state.draft;
        composer.submit.disabled = !selected.store || state.pending.some(p => p.command.kind === 'task' && p.command.session_id === selected.session_id && p.phase !== 'rejected' && p.phase !== 'accepted');
        const active = selected.store?.blocks.find(b => ['accepted', 'running'].includes(b.view.state)), view = selected.run_view;
        cancel.disabled = !active || selected.cancelling || (view?.run_id === active.view.run_id && !['accepted', 'running'].includes(view.state));
        text(cancelReply, selected.cancel ? `Cancel disposition: ${selected.cancel.disposition}. Signal only, not terminal truth.` : '');
        text(runRead, view ? `Read-only run view: ${view.run_id}\nExecution: ${view.state}\nResult recorded: ${view.result_recorded}\nTerminal sequence: ${view.terminal_sequence ?? 'none'}\nResult sequence: ${view.result_sequence ?? 'none'}` : '');
        runRead.hidden = !view;
        if (selected.older_error || selected.content_operations.length > 0)
            stopFill();
        if (filling && selected.observation !== 'loading')
            schedule();
    }
    const unsubscribe = client.subscribe(render);
    return { render, get listenerCount() { return listeners.size; }, route(hash) { if (!disposed) {
            text(routeStatus, hash.kind === 'invalid' ? 'Invalid session fragment ignored. Use #session= followed by a lowercase session UUID.' : '');
            routeStatus.hidden = hash.kind !== 'invalid';
        } },
        dispose() { if (disposed)
            return; disposed = true; owner++; stopFill(); unsubscribe(); catalogRows([]); blockRows([]); commandRows([]); for (const remove of listeners)
            remove(); current = null; rangeNodes.clear(); scrub(root); } };
}
