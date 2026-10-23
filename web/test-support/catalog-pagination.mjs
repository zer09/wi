import { isDeepStrictEqual } from 'node:util';
import { validateSessionListView, validateSettingsView } from '../dist/api.js';

export function requireFact(value, stage) { if (!value) throw new Error(`C61:${stage}`); }
export const AS_OF = 'Catalog as of its last refresh. ID order, not activity order.';
export const SETTINGS = validateSettingsView({ api_version: 1, workspaces: ['/synthetic/project'],
  provider_id: 'synthetic', model: 'synthetic', provider_transport: 'websocket', enable_add_numbers: false });
// Reverse timestamps deliberately distinguish ID order from recent-activity order.
export const ROWS = Object.freeze(Array.from({ length: 33 }, (_, i) => Object.freeze({
  session_id: `61000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  title: `Catalog ${String(i + 1).padStart(2, '0')} <em>inert</em> 雪 https://external.invalid/`,
  workspace: '/synthetic/project', created_at_ms: String(i + 1), updated_at_ms: String(1000 - i),
  observed_head_sequence: String(i + 2), view: 'catalog', availability: 'ready', fault_code: null,
  last_run_id: `62000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  last_run_state: i % 2 === 0 ? 'completed' : 'interrupted',
})));
export const FIRST_PATH = '/v1/sessions?limit=32';
export const MORE_PATH = `${FIRST_PATH}&after_id=${ROWS[31].session_id}`;

// Export closed labels only. Extra or reordered queries must not look like an expected read.
export function classifyCatalogRoute(path, files) {
  if (path === '/v1/settings') return 'settings';
  if (path === FIRST_PATH) return 'catalog_first';
  if (path === MORE_PATH) return 'catalog_more';
  if (files.has(path)) return 'asset';
  return 'other';
}
export function classifyRequestError(text) {
  if (typeof text !== 'string' || text.length === 0) return 'unavailable';
  if (['net::ERR_ABORTED', 'net::ERR_FAILED', 'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED', 'net::ERR_EMPTY_RESPONSE'].includes(text)) return text;
  return 'other';
}

export function catalogPage(tail = false) {
  const entries = tail ? ROWS.slice(32) : ROWS.slice(0, 32);
  return { api_version: 1, entries, has_more: !tail, next_after_id: entries.at(-1).session_id };
}
export function pageProof(input, after) {
  const page = validateSessionListView(input);
  let last = after;
  for (const entry of page.entries) {
    requireFact(last === undefined || entry.session_id > last, 'cursor'); last = entry.session_id;
  }
  requireFact(page.entries.length <= 32 && page.next_after_id === (page.entries.at(-1)?.session_id ?? null)
    && (!page.has_more || page.entries.length > 0), 'cursor');
  return page;
}
export function expectedRows(tail = false) {
  return (tail ? ROWS : ROWS.slice(0, 32)).map(r => ({ title: r.title, current: 'false',
    metadata: `Observed head: ${r.observed_head_sequence}\nAvailability: ready\nObserved run: ${r.last_run_state}\nCode: none` }));
}
export function rowsProof(actual, tail = false) { requireFact(isDeepStrictEqual(actual, expectedRows(tail)), 'dom'); }

// An unexpected page or automatic tail fetch is fatal, not another canned success reply.
export function catalogPipeline() {
  const paths = ['/v1/settings', FIRST_PATH, MORE_PATH, FIRST_PATH];
  let count = 0;
  return {
    reply(method, path) {
      requireFact(method === 'GET' && path === paths[count], 'traffic');
      const index = count++;
      if (index === 0) return SETTINGS;
      const tail = index === 2;
      return pageProof(catalogPage(tail), tail ? ROWS[31].session_id : undefined);
    },
    count: () => count,
    complete() { requireFact(count === paths.length, 'traffic'); },
  };
}

// Run every registered close, but never replace the first body error with a later cleanup error.
export async function cleanupOwned(steps, original = null) {
  let error = original;
  const facts = [];
  for (const [stage, close] of steps) {
    try { await close(); facts.push({ stage, pass: true }); }
    catch (cause) { error ??= cause; facts.push({ stage, pass: false }); }
  }
  return { error, facts };
}
