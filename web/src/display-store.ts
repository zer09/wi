import { ProtocolError, type SessionView } from './api.js';
import {
  validateConversationPage, validateEntryPage, validateConversationChanges, parseDisplayCursor, comparePosition, utf8Bytes, compareLiveKeys, displayChangeKey,
  type ConversationQuery, type EntryView, type BlockView, type FieldFragment, type DisplayCursor,
} from './display-api.js';

export interface TextRange {
  readonly from_byte: string; readonly to_byte: string; readonly text: string;
}
export interface LoadedField {
  readonly field_id: string; readonly order_key: string; readonly kind: FieldFragment['kind'];
  readonly generation: string; readonly revision: string; readonly total_bytes: string; readonly ranges: readonly TextRange[];
}
export interface LoadedEntry {
  readonly view: Omit<EntryView, 'fields' | 'earlier_content' | 'content_complete'>;
  readonly fields: readonly LoadedField[];
  readonly earlier_content: string | null;
  readonly content_complete: boolean;
  readonly content_start_loaded: boolean;
  readonly content_traversal: { readonly earlier_content: string | null } | null;
}
type EntryRead = { readonly kind: 'entry' } | { readonly kind: 'content'; readonly cursor: string };
export interface LoadedBlock {
  readonly view: Omit<BlockView, 'human'>;
  readonly human: LoadedEntry; readonly entries: readonly LoadedEntry[];
  readonly earlier_activity: string | null;
  readonly activity_snapshot_head: string | null;
}
export interface DisplayStore {
  readonly session_id: string; readonly session: SessionView;
  readonly blocks: readonly LoadedBlock[];
  readonly previous_block: string | null; readonly live_after: string;
  readonly observed_head: string;
}
function conflict(): never { throw new ProtocolError('identity_mismatch'); }
function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function decimalCompare(a: string, b: string): number {
  if (BigInt(a) < BigInt(b)) return -1;
  if (BigInt(a) > BigInt(b)) return 1;
  return 0;
}
function equal(a: unknown, b: unknown): void { if (JSON.stringify(a) !== JSON.stringify(b)) conflict(); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot<T>(value: T): T { return freeze(structuredClone(value)); }
function localIndex(offset: bigint, length: number): number {
  if (offset < 0n || offset > BigInt(length)) conflict();
  return Number(offset);
}
function mergeRanges(ranges: readonly TextRange[], fragment: FieldFragment): readonly TextRange[] {
  const ordered = [...ranges, { from_byte: fragment.from_byte, to_byte: fragment.to_byte, text: fragment.text }]
    .sort((a, b) => decimalCompare(a.from_byte, b.from_byte));
  const merged: TextRange[] = [];
  for (const next of ordered) {
    const previous = merged.at(-1);
    if (!previous || BigInt(next.from_byte) > BigInt(previous.to_byte)) { merged.push(next); continue; }
    const left = utf8Bytes(previous.text), right = utf8Bytes(next.text);
    const offset = localIndex(BigInt(next.from_byte) - BigInt(previous.from_byte), left.length);
    const overlap = Math.min(left.length - offset, right.length);
    for (let i = 0; i < overlap; i++) if (left[offset + i] !== right[i]) conflict();
    // Decode the joined bytes, not independently sliced JS characters. Offsets are UTF8 bytes.
    if (right.length > overlap) {
      const bytes = new Uint8Array(left.length + right.length - overlap);
      bytes.set(left); bytes.set(right.subarray(overlap), left.length);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new ProtocolError('invalid_utf8'); }
      merged[merged.length - 1] = { from_byte: previous.from_byte, to_byte: next.to_byte, text };
    }
  }
  return merged;
}
function mergeField(previous: LoadedField | undefined, f: FieldFragment, revision: string): LoadedField {
  const revisionOrder = previous ? decimalCompare(revision, previous.revision) : 1;
  if (previous && revisionOrder === 0 && f.generation !== previous.generation) conflict();
  // An older descriptor cannot replace bytes from a newer observation with a higher generation.
  if (previous && revisionOrder < 0 && decimalCompare(f.generation, previous.generation) > 0) conflict();
  // A newer observation cannot roll the field's generation back within the same layout.
  if (previous && revisionOrder > 0 && decimalCompare(f.generation, previous.generation) < 0) conflict();
  if (previous && decimalCompare(f.generation, previous.generation) < 0) return previous;
  let ranges: readonly TextRange[] = [];
  let total = f.total_bytes;
  if (previous && previous.generation === f.generation) {
    if (previous.order_key !== f.order_key || previous.kind !== f.kind) conflict();
    const growth = decimalCompare(f.total_bytes, previous.total_bytes);
    if ((revisionOrder === 0 && growth !== 0) || (revisionOrder > 0 && growth < 0) || (revisionOrder < 0 && growth > 0)) conflict();
    total = growth > 0 ? f.total_bytes : previous.total_bytes;
    ranges = previous.ranges;
  }
  return { field_id: f.field_id, order_key: f.order_key, kind: f.kind, generation: f.generation,
    revision: previous && revisionOrder < 0 ? previous.revision : revision,
    total_bytes: total, ranges: mergeRanges(ranges, f) };
}
function earlierContent(a: string | null, b: string | null, fields: readonly LoadedField[]): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const left = parseDisplayCursor(a, 'content'), right = parseDisplayCursor(b, 'content');
  const lf = fields.find(f => f.field_id === left.field_id), rf = fields.find(f => f.field_id === right.field_id);
  if (!lf || !rf) return a;
  const order = compare(lf.order_key, rf.order_key) || decimalCompare(left.upper_byte!, right.upper_byte!);
  const early = order <= 0 ? left : right, late = order <= 0 ? right : left;
  const first = order <= 0 ? lf : rf, last = order <= 0 ? rf : lf;
  // A loaded segment consumes its frontier without proving the whole layout's beginning.
  // Keep the later token only if bytes between the two supplied boundaries are missing.
  const covered = fields.filter(f => f.order_key >= first.order_key && f.order_key <= last.order_key).every(f => {
    const from = f.field_id === early.field_id ? BigInt(early.upper_byte!) : 0n;
    const to = f.field_id === late.field_id ? BigInt(late.upper_byte!) : BigInt(f.total_bytes);
    return from === to || f.ranges.some(r => BigInt(r.from_byte) <= from && BigInt(r.to_byte) >= to);
  });
  if (covered) return order <= 0 ? a : b;
  return order <= 0 ? b : a;
}
function mergeEntry(previous: LoadedEntry | undefined, e: EntryView, read: EntryRead | undefined): LoadedEntry {
  const { fields: fragments, earlier_content, content_complete, ...view } = e;
  let revisionOrder = 1;
  if (previous) {
    if (previous.view.run_id !== e.run_id || previous.view.entry_id !== e.entry_id
      || previous.view.kind !== e.kind || comparePosition(previous.view.position, e.position) !== 0) conflict();
    revisionOrder = decimalCompare(e.revision, previous.view.revision);
    if (revisionOrder === 0) equal(previous.view, view);
    if (BigInt(e.content_epoch) < BigInt(previous.view.content_epoch)) {
      if (revisionOrder >= 0) conflict();
      return previous;
    }
    if (BigInt(e.content_epoch) > BigInt(previous.view.content_epoch)) {
      if (revisionOrder <= 0) conflict();
      previous = undefined;
    }
  }
  // A completed current traversal fixes the descriptor inventory, even with byte gaps.
  if (previous && previous.view.kind !== 'human' && revisionOrder <= 0
    && previous.content_traversal !== null && previous.content_traversal.earlier_content === null
    && fragments.some(f => !previous.fields.some(field => field.field_id === f.field_id))) conflict();
  if (previous && revisionOrder <= 0 && previous.content_traversal?.earlier_content != null) {
    const frontier = parseDisplayCursor(previous.content_traversal.earlier_content, 'content');
    const boundary = previous.fields.find(f => f.field_id === frontier.field_id && f.generation === frontier.generation);
    // The rooted tail also proves which descriptors are absent. Only prior current observations count.
    if (frontier.content_epoch === previous.view.content_epoch && boundary !== undefined
      && fragments.some(f => f.order_key >= boundary.order_key
        && !previous.fields.some(field => field.field_id === f.field_id && field.revision === previous.view.revision))) conflict();
  }
  const fields = [...(previous?.fields ?? [])];
  for (const f of fragments) {
    const index = fields.findIndex(field => field.field_id === f.field_id);
    const existing = fields[index];
    // An old compact response cannot introduce fields or generations newer than current metadata.
    if (previous && revisionOrder < 0 && BigInt(f.generation) > BigInt(previous.view.revision)) conflict();
    const field = mergeField(existing, f, e.revision);
    if (index < 0) fields.push(field); else fields[index] = field;
  }
  fields.sort((a, b) => compare(a.order_key, b.order_key));
  if (fields.some((f, i) => i > 0 && fields[i - 1].order_key === f.order_key)) conflict();
  let incomingContinuation = earlier_content;
  if (incomingContinuation !== null) {
    const c = parseDisplayCursor(incomingContinuation, 'content');
    const f = fields.find(f => f.field_id === c.field_id);
    if (f && f.generation !== c.generation) incomingContinuation = null;
  }
  let continuation = incomingContinuation;
  if (previous) {
    // A replaced field invalidates its old byte boundary, not other entries' continuations.
    const old = previous.earlier_content;
    const c = old === null ? null : parseDisplayCursor(old, 'content');
    const currentField = c === null ? undefined : fields.find(f => f.field_id === c.field_id);
    if (c !== null && currentField && currentField.generation !== c.generation) {
      continuation = revisionOrder >= 0 ? incomingContinuation : null;
    } else continuation = earlierContent(old, incomingContinuation, fields);
  }
  // A newer compact subset can introduce fields before the old loaded prefix.
  // Only a current-revision response can confirm that the layout's beginning is loaded.
  let startLoaded = content_complete || earlier_content === null;
  if (previous && revisionOrder < 0) startLoaded = previous.content_start_loaded;
  else if (previous && revisionOrder === 0) startLoaded ||= previous.content_start_loaded;
  if (continuation !== null && startLoaded) {
    const c = parseDisplayCursor(continuation, 'content');
    const boundary = fields.find(f => f.field_id === c.field_id);
    // Keep a higher boundary when a middle gap remains, even if the beginning is already loaded.
    if (boundary && fields.filter(f => f.order_key <= boundary.order_key).every(f => {
      const upper = f.field_id === c.field_id ? BigInt(c.upper_byte!) : BigInt(f.total_bytes);
      return upper === 0n || (f.ranges[0]?.from_byte === '0' && BigInt(f.ranges[0].to_byte) >= upper);
    })) continuation = null;
  }
  // Byte coverage cannot prove that a compact subset includes every descriptor.
  // Keep a separate current-revision chain, starting at a known tail read.
  let traversal = revisionOrder <= 0 && previous ? previous.content_traversal : null;
  const first = fragments[0], last = fragments.at(-1);
  const lower = earlier_content === null ? null : parseDisplayCursor(earlier_content, 'content');
  const contiguous = fragments.slice(1).every(f => !f.has_earlier)
    && fragments.slice(0, -1).every(f => !f.has_later)
    && (lower === null ? !first?.has_earlier : first !== undefined && lower.field_id === first.field_id
      && lower.generation === first.generation && lower.upper_byte === first.from_byte);
  let certified: { kind: 'entry' | 'content'; lower_order: string | null; upper_order: string | null; upper_inclusive: boolean } | null = null;
  if (revisionOrder >= 0 && contiguous) {
    if (read?.kind === 'entry' && !last?.has_later) {
      certified = { kind: 'entry', lower_order: lower === null ? null : first!.order_key, upper_order: null, upper_inclusive: true };
    } else if (read?.kind === 'content' && traversal?.earlier_content === read.cursor) {
      const c = parseDisplayCursor(read.cursor, 'content');
      // An opaque upper ID is not proof until its descriptor was already loaded.
      const boundary = previous?.fields.find(f => f.field_id === c.field_id);
      const linked = c.content_epoch === e.content_epoch && boundary !== undefined && boundary.generation === c.generation && last !== undefined
        && (c.upper_byte === '0' ? last.order_key < boundary.order_key && !last.has_later
          : last.field_id === c.field_id && last.generation === c.generation && last.to_byte === c.upper_byte);
      if (linked) certified = { kind: 'content', lower_order: lower === null ? null : first!.order_key,
        upper_order: boundary.order_key, upper_inclusive: c.upper_byte !== '0' };
    }
  }
  // A proved interval cannot omit a descriptor seen at this revision, even if its bytes have gaps.
  if (certified !== null && previous && revisionOrder === 0 && previous.fields.some(f => f.revision === e.revision
    && (certified.lower_order === null || f.order_key >= certified.lower_order)
    && (certified.upper_order === null || f.order_key < certified.upper_order
      || (certified.upper_inclusive && f.order_key === certified.upper_order))
    && !fragments.some(fragment => fragment.field_id === f.field_id))) conflict();
  if (certified?.kind === 'entry') {
    if (traversal === null) traversal = { earlier_content };
    else if (traversal.earlier_content !== null) {
      const upper = parseDisplayCursor(traversal.earlier_content, 'content');
      const boundary = fragments.find(f => f.field_id === upper.field_id);
      // A wider rooted tail can shorten the remaining chain. Redundant tails cannot undo its progress.
      if (earlier_content === null || (lower !== null && upper.content_epoch === e.content_epoch
        && boundary !== undefined && boundary.generation === upper.generation && first !== undefined
        && (first.order_key < boundary.order_key
          || (first.field_id === boundary.field_id && BigInt(lower.upper_byte!) < BigInt(upper.upper_byte!))))) {
        traversal = { earlier_content };
      }
    }
  } else if (certified?.kind === 'content') traversal = { earlier_content };
  const layoutLoaded = e.kind === 'human' ? startLoaded : traversal !== null && traversal.earlier_content === null;
  const complete = layoutLoaded
    && fields.every(f => f.ranges.length === 1 && f.ranges[0].from_byte === '0' && f.ranges[0].to_byte === f.total_bytes);
  return { view: revisionOrder < 0 && previous ? previous.view : view, fields,
    earlier_content: continuation, content_complete: complete, content_start_loaded: startLoaded, content_traversal: traversal };
}
function mergeBlock(previous: LoadedBlock | undefined, b: BlockView): LoadedBlock {
  const { human, ...view } = b;
  if (previous) {
    if (previous.view.run_id !== b.run_id || previous.view.accepted_sequence !== b.accepted_sequence) conflict();
    const order = decimalCompare(b.revision, previous.view.revision);
    if (order === 0) equal(previous.view, view);
    return { ...previous, view: order < 0 ? previous.view : view, human: mergeEntry(previous.human, human, { kind: 'entry' }) };
  }
  return { view, human: mergeEntry(undefined, human, { kind: 'entry' }), entries: [], earlier_activity: null, activity_snapshot_head: null };
}
function putBlock(blocks: readonly LoadedBlock[], b: BlockView, admit: boolean): readonly LoadedBlock[] {
  const index = blocks.findIndex(block => block.view.run_id === b.run_id);
  if (index < 0 && blocks.some(block => block.view.accepted_sequence === b.accepted_sequence)) conflict();
  if (index < 0 && !admit) return blocks;
  const next = [...blocks], block = mergeBlock(next[index], b);
  if (index < 0) next.push(block); else next[index] = block;
  return next.sort((a, b) => decimalCompare(a.view.accepted_sequence, b.view.accepted_sequence));
}
function putEntry(block: LoadedBlock, e: EntryView, admitOlder: boolean, read: EntryRead | undefined): LoadedBlock {
  if (e.kind === 'human') return { ...block, human: mergeEntry(block.human, e, read) };
  const index = block.entries.findIndex(entry => entry.view.entry_id === e.entry_id);
  // Live revisions can arrive out of creation order. Only the original page head separates new activity from unloaded history.
  if (index < 0 && !admitOlder && block.activity_snapshot_head !== null
    && BigInt(e.position.sequence) <= BigInt(block.activity_snapshot_head)) return block;
  const entries = [...block.entries], entry = mergeEntry(entries[index], e, read);
  if (index < 0) entries.push(entry); else entries[index] = entry;
  entries.sort((a, b) => comparePosition(a.view.position, b.view.position));
  return { ...block, entries };
}
function metadata(previous: SessionView, next: SessionView): SessionView {
  if (previous.session_id !== next.session_id || previous.workspace !== next.workspace || previous.created_at_ms !== next.created_at_ms) conflict();
  const order = decimalCompare(next.head_sequence, previous.head_sequence);
  if (order === 0) equal(previous, next);
  return order < 0 ? previous : next;
}
function activity(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const left = parseDisplayCursor(a, 'activity'), right = parseDisplayCursor(b, 'activity');
  return comparePosition({ sequence: left.sequence, slot: left.slot! }, { sequence: right.sequence, slot: right.slot! }) <= 0 ? a : b;
}
export function replaceLatest(value: unknown, sessionId?: string): DisplayStore {
  const p = validateConversationPage(value, { kind: 'latest' }, sessionId);
  let blocks: readonly LoadedBlock[] = [];
  if (p.block) {
    let block = mergeBlock(undefined, p.block);
    for (const e of p.entries) block = putEntry(block, e, true, { kind: 'entry' });
    blocks = [{ ...block, earlier_activity: p.earlier_activity, activity_snapshot_head: p.snapshot_head }];
  }
  return snapshot({ session_id: p.session_id, session: p.session, blocks, previous_block: p.previous_block,
    live_after: p.live_after!, observed_head: p.snapshot_head });
}
export function mergeConversationPage(state: DisplayStore, value: unknown, query: Exclude<ConversationQuery, { kind: 'latest' }>): DisplayStore {
  const p = validateConversationPage(value, query, state.session_id);
  let blocks = state.blocks, previous = state.previous_block;
  if (p.block) {
    const existing = blocks.find(b => b.view.run_id === p.block!.run_id);
    if (query.kind === 'within' && !existing) return state;
    const oldest = blocks[0]?.view.accepted_sequence;
    blocks = putBlock(blocks, p.block, true);
    blocks = blocks.map(b => {
      if (b.view.run_id !== p.block!.run_id) return b;
      for (const e of p.entries) b = putEntry(b, e, true, { kind: 'entry' });
      return { ...b, earlier_activity: existing ? activity(existing.earlier_activity, p.earlier_activity) : p.earlier_activity,
        activity_snapshot_head: existing ? existing.activity_snapshot_head : p.snapshot_head };
    });
    if (query.kind === 'before' && (oldest === undefined || BigInt(p.block.accepted_sequence) < BigInt(oldest))) previous = p.previous_block;
  } else if (query.kind === 'before' && query.cursor === state.previous_block) previous = null;
  return snapshot({ ...state, session: metadata(state.session, p.session), blocks, previous_block: previous });
}
export function mergeEntryPage(state: DisplayStore, value: unknown, expected?: { readonly session_id: string; readonly run_id: string; readonly entry_id: string }, read?: EntryRead): DisplayStore {
  const p = validateEntryPage(value, expected);
  if (p.session_id !== state.session_id) conflict();
  if (read?.kind === 'content') {
    const c = parseDisplayCursor(read.cursor, 'content', state.session_id);
    if (c.run_id !== p.entry.run_id || c.entry_id !== p.entry.entry_id) conflict();
  }
  const block = state.blocks.find(b => b.view.run_id === p.block.run_id);
  if (!block || (p.entry.kind !== 'human' && !block.entries.some(e => e.view.entry_id === p.entry.entry_id))) return state;
  const blocks = putBlock(state.blocks, p.block, false).map(b => b.view.run_id === p.block.run_id ? putEntry(b, p.entry, true, read) : b);
  return snapshot({ ...state, blocks });
}
function liveCompare(a: DisplayCursor, b: DisplayCursor): number {
  return compareLiveKeys(a, b);
}
export function applyConversationChanges(state: DisplayStore, value: unknown): DisplayStore {
  const batch = validateConversationChanges(value, state.session_id);
  const before = parseDisplayCursor(state.live_after, 'live', state.session_id);
  const after = parseDisplayCursor(batch.next_after, 'live', state.session_id);
  const progress = liveCompare(after, before);
  if (progress < 0 || (batch.changes.length > 0 && progress === 0)
    || BigInt(batch.observed_head) < BigInt(state.observed_head)) conflict();
  for (const change of batch.changes) {
    const key = displayChangeKey(change);
    if (key !== null && compareLiveKeys(key, before) <= 0) conflict();
  }
  let blocks = state.blocks, session = state.session;
  for (const change of batch.changes) {
    if (change.kind === 'session.upsert') { session = metadata(session, change.session); continue; }
    const latest = blocks.at(-1);
    const admit = latest === undefined || BigInt(change.block.accepted_sequence) > BigInt(latest.view.accepted_sequence);
    blocks = putBlock(blocks, change.block, admit);
    if (change.kind === 'entry.upsert') {
      blocks = blocks.map(b => b.view.run_id === change.block.run_id ? putEntry(b, change.entry, false, { kind: 'entry' }) : b);
    }
  }
  // Publication happens only after every entity and range has merged successfully.
  return snapshot({ ...state, session, blocks, observed_head: batch.observed_head, live_after: batch.next_after });
}
