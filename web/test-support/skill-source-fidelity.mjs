import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, basename, join, resolve, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateTaskCommand, validateUuid } from '../dist/api.js';
import { parseDisplayCursor, validateConversationPage } from '../dist/display-api.js';
import { parseControl } from './fixture.mjs';
import { data, answer, skillOutput } from './presentation.mjs';
import { richPartialFacts } from './rich-display-parity.mjs';

const reject = () => { throw new Error('Skill source fidelity rejected'); };
export const FRONTMATTER = '---\nname: presentation\ndescription: synthetic metadata\n---\n';
export const TEMPLATE = FRONTMATTER + data.tool;
export const CHANGED = FRONTMATTER + 'Synthetic C49 changed main body. 雪\r\nNever a saved result.\n';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = s => ({ dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), nlink: String(s.nlink) });
const equal = (a, b) => { if (!isDeepStrictEqual(a, b)) reject(); };

export async function executableBinding(path, suppliedHash) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || await realpath(path) !== path) reject();
  const hash = sha256(await readFile(path));
  if (suppliedHash !== undefined && suppliedHash !== hash) reject();
  return { path, sha256: hash, ...identity(s) };
}
export async function linuxProcess(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1) reject();
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const env = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
  return { pid, ppid: Number(fields[1]), start: fields[19], alive: !['Z', 'X'].includes(fields[0]),
    cwd: await readlink(`/proc/${pid}/cwd`), exe: await readlink(`/proc/${pid}/exe`),
    tmpdir: env.find(v => v.startsWith('TMPDIR='))?.slice(7) };
}

export function nativeCompletion(input, commands, receipts) {
  const { id: _id, ...s } = parseControl(input), tasks = commands.length;
  if (s.event !== 'inspect' || tasks < 1 || tasks > 2 || receipts.length !== tasks) reject();
  equal([s.gate,s.requests,s.connections,s.auth_loads,s.auth_prepares,s.prepared_exact,s.fresh_parents,s.continuations,
    s.tool_results,s.completed,s.terminals,s.results], [null,tasks*2,tasks,tasks,tasks,tasks*2,tasks,tasks,tasks*3,tasks,tasks,tasks]);
  if (!s.fresh_empty || s.restored_history !== (tasks === 2) || s.provider_failed || s.read_failure !== null
    || (tasks === 2 && s.provider_stage !== 'finished') || s.response_finishes.length !== tasks*2) reject();
  equal(s.receipts, receipts);
  equal(s.accepted, receipts.map(r => ({ run_id:r.run_id, accepted_sequence:r.first_sequence })));
  if (new Set(commands.map(c=>c.run_id)).size !== tasks || new Set(commands.map(c=>c.operation_id)).size !== tasks) reject();
  for (const [i,c] of commands.entries()) {
    validateTaskCommand(c);
    if (c.text !== data.user || receipts[i].operation_id !== c.operation_id || receipts[i].run_id !== c.run_id
      || receipts[i].session_id !== receipts[0].session_id || BigInt(receipts[i].last_sequence) !== BigInt(receipts[i].first_sequence)+1n) reject();
    const [first,last] = s.response_finishes.slice(i*2,i*2+2);
    if (first.provenance !== 'native_terminal' || last.provenance !== 'native_terminal'
      || !(BigInt(receipts[i].first_sequence)<BigInt(first.sequence) && BigInt(first.sequence)<BigInt(last.sequence)
        && BigInt(last.sequence)<BigInt(s.terminal_sequences[i]) && BigInt(s.terminal_sequences[i])<BigInt(s.result_sequences[i]))) reject();
    if (i && BigInt(receipts[i].first_sequence)<=BigInt(s.result_sequences[i-1])) reject();
  }
  if (s.sequence_count !== s.result_sequences.at(-1)) reject();
  return s;
}
export function unchangedNative(input, held) {
  const { id: _id, ...state } = parseControl(input); equal(state, held); return true;
}

// Only the fixture's main file is writable. Every check runs before the first file effect.
export async function ownedSkill({ fixture, workspace, tmpdir, executable, finished, probe = linuxProcess }) {
  if (process.platform !== 'linux' || finished?.completed !== 2 || finished.provider_stage !== 'finished' || finished.gate !== null
    || !Number.isSafeInteger(fixture?.pid) || fixture.pid <= 1 || typeof workspace !== 'string' || workspace !== resolve(workspace)
    || typeof tmpdir !== 'string' || tmpdir !== resolve(tmpdir)) reject();
  const sandbox = dirname(dirname(workspace));
  if (basename(workspace) !== 'workspace' || !/^\.tmp[A-Za-z0-9]+$/.test(basename(dirname(workspace)))
    || !/^wi-browser-[A-Za-z0-9]+$/.test(basename(sandbox)) || dirname(sandbox) !== tmpdir) reject();
  const path = join(workspace, '.agents/skills/presentation/SKILL.md');
  const dirs = [];
  for (let p = dirname(path); ; p = dirname(p)) { dirs.unshift(p); if (p === sep) break; }
  const originals = new Map();
  async function directories(initial = false) {
    for (const p of dirs) {
      const s = await lstat(p, { bigint:true });
      if (!s.isDirectory() || s.isSymbolicLink()) reject();
      if (initial) originals.set(p, identity(s)); else equal(identity(s), originals.get(p));
      if (await realpath(p) !== p) reject();
    }
  }
  await directories(true);
  const living = await probe(fixture.pid);
  function processMatches(value) {
    if (!value || value.pid !== fixture.pid || value.ppid !== process.pid || !value.alive || !value.start
      || value.cwd !== sandbox || value.tmpdir !== sandbox || value.exe !== executable) reject();
  }
  processMatches(living);
  let file;
  try {
    const s = await lstat(path, { bigint:true });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || await realpath(path) !== path) reject();
    file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    equal(identity(await file.stat({ bigint:true })), identity(s));
    const originalIdentity = identity(s);
    let expected = TEMPLATE, phase = 'bound';
    async function validate() {
      await directories();
      const current = await probe(fixture.pid); processMatches(current); equal(current, living);
      const named = await lstat(path, { bigint:true }), held = await file.stat({ bigint:true });
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n) reject();
      equal(identity(named), originalIdentity); equal(identity(held), originalIdentity);
      if (held.size !== BigInt(Buffer.byteLength(expected))) reject();
      const bytes = Buffer.alloc(Number(held.size));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length || !bytes.equals(Buffer.from(expected))) reject();
      return bytes;
    }
    await validate();
    const facts = { pid:fixture.pid, start:living.start, cwd:sandbox, workspace, path,
      relative:relative(sandbox,path), identity:originalIdentity, template_sha256:sha256(TEMPLATE) };
    return {
      facts,
      async change() {
        if (phase !== 'bound') reject(); await validate();
        const bytes = Buffer.from(CHANGED);
        const { bytesWritten } = await file.write(bytes, 0, bytes.length, 0);
        if (bytesWritten !== bytes.length) reject();
        await file.truncate(bytes.length); await file.sync(); expected = CHANGED;
        const readback = await validate(); phase = 'changed';
        return { ...facts, changed_sha256:sha256(readback), readback_exact:true, same_identity:true };
      },
      async observed() { if (phase !== 'changed') reject(); await validate(); phase = 'observed'; },
      async delete() {
        if (phase !== 'observed') reject(); await validate();
        await unlink(path);
        try { await lstat(path); reject(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        phase = 'deleted'; return { ...facts, absent:true, same_identity:true };
      },
      async close() { await file.close(); },
    };
  } catch { if (file) await file.close(); reject(); }
}

export function completeProof(input, { sid, head, command, receipt, task, workspace, resultSequence, query = { kind:'latest' } }) {
  const p = validateConversationPage(input, query, sid), b = p.block;
  validateTaskCommand(command);
  if (command.text !== data.user || p.snapshot_head !== head || p.session.head_sequence !== head || p.session.title !== data.title
    || p.session.workspace !== workspace || b === null || b.run_id !== command.run_id || receipt.run_id !== command.run_id
    || receipt.operation_id !== command.operation_id || receipt.session_id !== sid || b.accepted_sequence !== receipt.first_sequence
    || b.revision !== resultSequence || b.state !== 'completed' || !b.result_recorded || !b.events_complete || b.sink_error !== null
    || !isDeepStrictEqual(b.outcome,{type:'completed'}) || p.earlier_activity !== null || p.entries.length !== 5
    || (task === 0 ? p.previous_block !== null : p.previous_block === null)) reject();
  if (task === 1 && parseDisplayCursor(p.previous_block,'block',sid).sequence !== receipt.first_sequence) reject();
  if (query.kind === 'latest') {
    const c = parseDisplayCursor(p.live_after,'live',sid);
    if (c.sequence !== head || c.rank !== '3' || c.run_id !== '' || c.entry_id !== '') reject();
  } else if (p.live_after !== null) reject();
  const summary = b.summary;
  if (!summary || !isDeepStrictEqual(['turns_started','turns_finished','model_requests_attempted','model_requests_admitted',
    'new_tool_dispatches','tool_results_prepared','reused_results'].map(k=>summary[k]),['2','2','2','2','3','3','0'])
    || summary.last_upstream_outcome !== 'terminal_received') reject();
  validateUuid(summary.last_request_id);
  const rich = structuredClone(richPartialFacts); rich[5][1] = task === 0 ? '{"a":17,\r\n "b":25}' : '{"a":42,\r\n "b":8}';
  const facts = [[['text',data.user]],rich,[['tool_name','add_numbers'],['tool_result',task === 0 ? '{"sum":42}' : '{"sum":50}']],
    [['tool_name','load_skill'],['tool_result',skillOutput]],[['tool_name','add_numbers'],['tool_result','{"error":{"code":"gateway_error"}}']],
    [['text',answer(task)]]];
  let prior = 0n;
  for (const [i,e] of [b.human,...p.entries].entries()) {
    const sequence = BigInt(e.position.sequence);
    let state = 'completed';
    if (i === 0) state = 'accepted';
    else if (i === 4) state = 'failed';
    if (sequence <= prior || sequence > BigInt(resultSequence) || e.position.slot !== '0' || e.entry_id !== `e:${sequence}:0`
      || e.run_id !== command.run_id || e.kind !== ['human','assistant','tool','tool','tool','assistant'][i]
      || e.recorded_state !== state || e.provisional || e.reference !== null
      || !e.content_complete || e.earlier_content !== null) reject();
    equal(e.fields.map(f=>[f.kind,f.text]),facts[i]);
    equal(['result_recorded','finish_recorded','is_error'].map(k=>e[k]), i>=2 && i<=4 ? [true,true,i===4] : [null,null,null]);
    if (i === 0 && (e.position.sequence !== receipt.first_sequence || e.fields[0].field_id !== 'text')) reject();
    for (const f of e.fields) {
      const bytes=String(Buffer.byteLength(f.text));
      if (f.from_byte !== '0' || f.to_byte !== bytes || f.total_bytes !== bytes || f.has_earlier || f.has_later
        || BigInt(f.generation)<sequence || BigInt(f.generation)>BigInt(resultSequence)) reject();
    }
    prior=sequence;
  }
  return p;
}
export function savedProof(current, saved) { equal(current,saved); return true; }
export function observerOrder(events) {
  equal(events,['latest','newest-rendered','upward-intent','older-request','older-rendered']); return true;
}
export function strictStop(evidence) {
  if (!evidence || evidence.failure !== null || !evidence.stop.attempted || !evidence.stop.clean_acknowledgment
    || !evidence.stop.reap_complete || !evidence.stop.sandbox_removed || !evidence.stop.exit_observed || evidence.stop.exit_zero !== true
    || evidence.stop.error_latched || !evidence.stop.stderr_empty || evidence.stop.sigterm || evidence.stop.sigkill) reject();
  return true;
}
