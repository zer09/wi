import { readFile } from 'node:fs/promises';

export const data = JSON.parse(await readFile(new URL('./presentation.json', import.meta.url), 'utf8'));
export const answer = task => `Final ${task + 1}\r\n${data.text}${'W'.repeat(2048)}`;
export const skillOutput = JSON.stringify({ body: data.tool, frontmatter: { description: 'synthetic metadata', name: 'presentation' }, id: 'project:presentation' });
export const labels = ['short-selected', 'long-selected', 'stalled-reader'];
const timingFields = ['first_page_ms', 'durable_acceptance_ms', 'committed_visibility_ms', 'reducer_render_ms', 'rebuild_ms', 'stall_ms'];
const countFields = ['first_page_events', 'history_pages', 'selected_events', 'selected_dom_nodes', 'local_dom_nodes', 'live_updates', 'deltas'];
export function measurement(value) {
  const fail = () => { throw new Error('measurement rejected'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== ['label', ...timingFields, ...countFields].sort().join(',')
    || !labels.includes(value.label)) fail();
  // These bounds belong to the finite test watchdog and fixture, never the product.
  for (const key of timingFields) if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 180_000) fail();
  for (const key of countFields) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000) fail();
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, timingFields.includes(key) ? Math.round(number * 100) / 100 : number]));
}
