import { lstat, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateRenameView, validateSessionListView, validateTaskCommand } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage } from '../dist/display-api.js';
import { parseControl } from './fixture.mjs';
import { linuxProcess } from './skill-source-fidelity.mjs';

export const TASK = '  Add 17 and 25. 雪\n<em>task & inert</em>\n';
export const TITLE = '  Mutation 雪\n<em>first title</em>  ';
export const RENAMED = '  Active rename 雪\n<em>one</em>  ';
export const ANSWER = '42 雪\r\n<em>answer & inert</em>\n';
export const ARGUMENTS = '{"a":17,\r\n "b":25}';
export const OUTPUT = '{"sum":42}';
export const codes = ['catalog', 'native', 'page', 'rename', 'unchanged', 'ownership', 'absent', 'move', 'handshake', 'traffic', 'privacy', 'assets', 'acquire', 'cleanup', 'publication'];
export function requireProof(ok, code) {
  if (!ok) throw new Error(`C57:${codes.includes(code) ? code : 'page'}`);
}
export function equalProof(a, b, code = 'unchanged') { requireProof(isDeepStrictEqual(a, b), code); }
export function withoutId(input) { const { id: _id, ...facts } = parseControl(input); return facts; }

export function nativeProof(input, { sid, command, receipt, completed = false }) {
  const s = withoutId(input);
  validateTaskCommand(command);
  requireProof(command.text === TASK && s.event === 'inspect', 'native');
  equalProof([s.gate, s.requests, s.connections, s.auth_loads, s.auth_prepares, s.prepared_exact,
    s.fresh_parents, s.continuations, s.tool_results, s.completed, s.terminals, s.results],
  [completed ? null : 3, 2, 1, 1, 1, 2, 1, 1, 1, completed ? 1 : 0, completed ? 1 : 0, completed ? 1 : 0], 'native');
  requireProof(s.fresh_empty && !s.restored_history && !s.provider_failed && s.read_failure === null, 'native');
  equalProof(s.receipts, [receipt], 'native');
  equalProof(s.accepted, [{ run_id: command.run_id, accepted_sequence: receipt.first_sequence }], 'native');
  requireProof(receipt.session_id === sid && receipt.operation_id === command.operation_id && receipt.run_id === command.run_id
    && receipt.first_sequence === '2' && receipt.last_sequence === '3', 'native');
  requireProof(s.response_finishes.length === (completed ? 2 : 1)
    && s.response_finishes.every(f => f.provenance === 'native_terminal'), 'native');
  if (completed) {
    requireProof(s.provider_stage === 'finished' && s.sequence_count === s.result_sequences[0]
      && BigInt(s.response_finishes[0].sequence) < BigInt(s.response_finishes[1].sequence)
      && BigInt(s.response_finishes[1].sequence) < BigInt(s.terminal_sequences[0])
      && BigInt(s.terminal_sequences[0]) < BigInt(s.result_sequences[0]), 'native');
  }
  return s;
}

export function pageProof(input, { sid, workspace, title, native, command, receipt, completed = false }) {
  const p = validateConversationPage(input, { kind: 'latest' }, sid), b = p.block;
  requireProof(p.snapshot_head === native.sequence_count && p.session.head_sequence === p.snapshot_head
    && p.session.title === title && p.session.workspace === workspace && typeof workspace === 'string'
    && b !== null && b.run_id === command.run_id && b.accepted_sequence === receipt.first_sequence
    && b.state === (completed ? 'completed' : 'running') && b.result_recorded === completed
    && b.sink_error === null && b.events_complete === (completed ? true : null)
    && p.previous_block === null && p.earlier_activity === null && p.entries.length === 3, 'page');
  equalProof(b.outcome, completed ? { type: 'completed' } : null, 'page');
  if (completed) {
    requireProof(b.revision === native.result_sequences[0] && b.summary !== null, 'page');
    equalProof(['turns_started','turns_finished','model_requests_attempted','model_requests_admitted',
      'new_tool_dispatches','tool_results_prepared','reused_results'].map(k => b.summary[k]), ['2','2','2','2','1','1','0'], 'page');
  } else requireProof(b.summary === null, 'page');
  const cursor = parseDisplayCursor(p.live_after, 'live', sid);
  equalProof([cursor.sequence, cursor.rank, cursor.run_id, cursor.entry_id], [p.snapshot_head, '3', '', ''], 'page');
  const facts = [[['text', TASK]], [['function_name', 'add_numbers'], ['function_arguments', ARGUMENTS]],
    [['tool_name', 'add_numbers'], ['tool_result', OUTPUT]], [['text', completed ? ANSWER : '42 雪']]];
  let prior = 0n;
  for (const [i, e] of [b.human, ...p.entries].entries()) {
    const sequence = BigInt(e.position.sequence);
    const provisional = i === 3 && !completed;
    requireProof(e.run_id === b.run_id && e.entry_id === `e:${sequence}:0` && e.position.slot === '0'
      && sequence > prior && sequence <= BigInt(p.snapshot_head) && e.reference === null
      && e.kind === ['human','assistant','tool','assistant'][i]
      && e.recorded_state === (i === 0 ? 'accepted' : provisional ? 'in_progress' : 'completed')
      && e.provisional === provisional && e.content_complete && e.earlier_content === null, 'page');
    equalProof([e.result_recorded,e.finish_recorded,e.is_error], i === 2 ? [true,true,false] : [null,null,null], 'page');
    equalProof(e.fields.map(f => [f.kind,f.text]), facts[i], 'page');
    for (const f of e.fields) {
      const bytes = String(Buffer.byteLength(f.text));
      requireProof(bytes !== '0' && f.from_byte === '0' && f.to_byte === bytes && f.total_bytes === bytes
        && !f.has_earlier && !f.has_later && BigInt(f.generation) >= sequence
        && BigInt(f.generation) <= BigInt(e.revision) && BigInt(e.content_epoch) >= sequence, 'page');
    }
    prior = sequence;
  }
  requireProof(b.human.entry_id === `e:${receipt.first_sequence}:0`, 'page');
  return p;
}

export function catalogProof(input, dom, { sid, title, head, workspace, ids, runId = null, runState = null }) {
  const c = validateSessionListView(input);
  // A final page still carries the last returned ID as its keyset position.
  requireProof(c.entries.length === 2 && !c.has_more && c.next_after_id === c.entries.at(-1).session_id, 'catalog');
  const actualIds = c.entries.map(e => e.session_id);
  equalProof(actualIds, [...actualIds].sort(), 'catalog');
  if (ids) equalProof(actualIds, ids, 'catalog');
  const selected = c.entries.find(e => e.session_id === sid), seed = c.entries.find(e => e.session_id !== sid);
  requireProof(selected !== undefined && seed !== undefined && seed.title === 'Fixture barrier seed' && seed.workspace === null
    && seed.observed_head_sequence === '1' && seed.last_run_id === null && seed.last_run_state === null
    && selected.title === title && selected.workspace === workspace && selected.observed_head_sequence === head
    && selected.last_run_id === runId && selected.last_run_state === runState
    && c.entries.every(e => e.availability === 'ready' && e.fault_code === null), 'catalog');
  equalProof(dom, c.entries.map(e => ({ title: e.title, current: String(e.session_id === sid),
    metadata: `Observed head: ${e.observed_head_sequence}\nAvailability: ${e.availability}\nObserved run: ${e.last_run_state ?? 'none'}\nCode: ${e.fault_code ?? 'none'}` })), 'catalog');
  return { ids: actualIds, dom, catalog: c };
}

export function handshakeProof({ origin, sid, page, snapshots, streams }) {
  requireProof(snapshots.length === 1 && streams.length === 1, 'handshake');
  const cursor = parseDisplayCursor(page.live_after, 'live', sid);
  requireProof(cursor.sequence === page.snapshot_head && cursor.rank === '3', 'handshake');
  const latest = snapshots[0], stream = streams[0], url = `${origin}/v1/sessions/${sid}/conversation`;
  requireProof(latest.response.request() === latest.request && latest.response.status() === 200
    && latest.response.url() === url && latest.request.method() === 'GET' && latest.request.url() === url
    && stream.request !== latest.request && stream.index > latest.index
    && stream.response.request() === stream.request && stream.response.status() === 200
    && stream.request.method() === 'GET'
    && stream.request.url() === `${url}/events?after=${encodeURIComponent(page.live_after)}`, 'handshake');
  return true;
}

// These callbacks are the real case's ordered browser/native barriers, also exercised offline.
export async function proveActiveRename(io, expected) {
  const baseline = await io.refreshCatalog();
  const catalog = catalogProof(baseline.value, baseline.dom, { ...expected, title: TITLE, head: '1' });
  const { command, receipt } = await io.startTask();
  const args = { ...expected, command, receipt };
  const held = await io.capture(false, TITLE);
  nativeProof(held.native, args);
  pageProof(held.page, { ...args, title: TITLE, native: held.native });
  equalProof(await io.catalogDom(), catalog.dom, 'catalog');
  const mutation = await io.rename();
  const r = validateRenameView(mutation.value);
  requireProof(mutation.status === 200 && mutation.command.title === RENAMED && r.duplicate === false && r.warning_code === null
    && r.catalog_refresh === 'updated' && r.receipt.operation_id === mutation.command.operation_id
    && r.receipt.session_id === expected.sid && r.receipt.run_id === null
    && r.receipt.first_sequence === String(BigInt(held.native.sequence_count) + 1n)
    && r.receipt.last_sequence === r.receipt.first_sequence, 'rename');
  const after = await io.capture(false, RENAMED);
  nativeProof(after.native, args);
  const beforeNative = withoutId(held.native), afterNative = withoutId(after.native);
  equalProof(afterNative, { ...beforeNative, sequence_count: r.receipt.last_sequence }, 'native');
  pageProof(after.page, { ...args, title: RENAMED, native: after.native });
  equalProof([after.page.block,after.page.entries,after.page.previous_block,after.page.earlier_activity],
    [held.page.block,held.page.entries,held.page.previous_block,held.page.earlier_activity]);
  equalProof(after.page.session, { ...held.page.session, title: RENAMED,
    head_sequence: after.page.snapshot_head, updated_at_ms: after.page.session.updated_at_ms });
  requireProof(BigInt(after.page.session.updated_at_ms) >= BigInt(held.page.session.updated_at_ms), 'rename');
  equalProof(after.dom, held.dom);
  equalProof(await io.catalogDom(), catalog.dom, 'catalog');
  const refreshed = await io.refreshCatalog();
  catalogProof(refreshed.value, refreshed.dom, { ...expected, title: RENAMED, head: after.page.snapshot_head,
    ids: catalog.ids, runId: command.run_id, runState: 'running' });
  await io.finish();
  const final = await io.capture(true, RENAMED);
  nativeProof(final.native, { ...args, completed: true });
  pageProof(final.page, { ...args, title: RENAMED, native: final.native, completed: true });
  equalProof(withoutId(await io.inspect()), withoutId(final.native), 'native');
  return { final, command, receipt, catalogIds: catalog.ids, refreshedCatalog: refreshed.value, renameReceipt: r.receipt };
}

export async function proveSavedHistory(io, completed) {
  await io.move(completed.final.native);
  await io.absent();
  await io.closeOriginal();
  const fresh = await io.fresh();
  equalProof(fresh.page, completed.final.page);
  equalProof(fresh.dom, completed.final.dom);
  equalProof(withoutId(fresh.native), withoutId(completed.final.native), 'native');
  requireProof(fresh.posts === 0, 'traffic');
  await io.absent();
  return fresh;
}

const identity = s => ({ dev: String(s.dev), ino: String(s.ino), mode: String(s.mode) });
export async function ownedWorkspace({ fixture, root, workspace, executable, completed, tmpdir,
  fs = { lstat, realpath, rename }, probe = linuxProcess }) {
  requireProof(completed?.completed === 1 && completed.terminals === 1 && completed.results === 1
    && completed.gate === null && completed.provider_stage === 'finished', 'ownership');
  requireProof(root?.verified === true && root.pid === fixture.pid && root.path === resolve(root.path)
    && dirname(root.path) === tmpdir && /^wi-browser-[A-Za-z0-9]+$/.test(basename(root.path))
    && workspace === resolve(workspace) && basename(workspace) === 'workspace'
    && /^\.tmp[A-Za-z0-9]+$/.test(basename(dirname(workspace))) && dirname(dirname(workspace)) === root.path, 'ownership');
  const destination = join(dirname(workspace), 'workspace-c57-absent');
  const originals = new Map(), paths = [];
  for (let p = workspace; ; p = dirname(p)) { paths.unshift(p); if (p === sep) break; }
  const living = await probe(fixture.pid);
  function processMatches(p) {
    requireProof(p.pid === fixture.pid && p.ppid === process.pid && p.alive && p.start === root.start
      && p.cwd === root.path && p.tmpdir === root.path && p.exe === executable, 'ownership');
  }
  processMatches(living);
  async function absent(path) {
    try { await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    requireProof(false, 'absent');
  }
  async function validate(initial = false) {
    const current = await probe(fixture.pid); processMatches(current); equalProof(current, living, 'ownership');
    for (const path of paths) {
      const s = await fs.lstat(path, { bigint: true });
      requireProof(s.isDirectory() && !s.isSymbolicLink() && await fs.realpath(path) === path, 'ownership');
      if (initial) originals.set(path, identity(s));
      else equalProof(identity(s), originals.get(path), 'ownership');
    }
    equalProof([originals.get(root.path).dev, originals.get(root.path).ino], [root.dev, root.ino], 'ownership');
    await absent(destination);
  }
  await validate(true);
  let attempted = false, moved = false;
  return {
    facts: { root, process: living, workspace, destination, workspace_identity: originals.get(workspace) },
    async move() {
      requireProof(!attempted, 'move');
      await validate();
      // A post-effect failure cannot authorize another rename attempt.
      attempted = true;
      await fs.rename(workspace, destination);
      moved = true;
      await this.absent();
    },
    async absent() {
      requireProof(moved, 'move');
      await absent(workspace);
      const s = await fs.lstat(destination, { bigint: true });
      requireProof(s.isDirectory() && !s.isSymbolicLink() && await fs.realpath(destination) === destination, 'ownership');
      equalProof(identity(s), originals.get(workspace), 'ownership');
      return true;
    },
  };
}

// Register an acquired context before setup, so setup failure still closes it.
export async function runOwned(body, publish) {
  const resources = [], cleanup = [];
  let first = null, value;
  const own = (name, close) => {
    const record = { name, close, closed: false }; resources.push(record);
    return async () => { if (!record.closed) { await close(); record.closed = true; } };
  };
  try { value = await body(own); } catch (error) { first = error; }
  const bodyFailed = first !== null;
  for (const r of resources.reverse()) {
    try { if (!r.closed) { await r.close(); r.closed = true; } cleanup.push({ name: r.name, closed: true }); }
    catch (error) { first ??= error; cleanup.push({ name: r.name, closed: false }); }
  }
  try { await publish({ success: first === null, body_failed: bodyFailed, cleanup, value }); } catch (error) { first ??= error; }
  if (first) throw first;
  return value;
}
