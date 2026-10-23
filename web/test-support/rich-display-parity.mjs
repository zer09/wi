import { isDeepStrictEqual } from 'node:util';
import { parseDisplayCursor, validateConversationPage } from '../dist/display-api.js';
import { data } from './presentation.mjs';

const reject = () => { throw new Error('Rich display parity rejected'); };
export const richPartialFacts = [
  ['reasoning_summary', data.summary], ['reasoning_text', data.reasoning], ['text', data.text], ['refusal', data.refusal],
  ['function_name', 'add_numbers'], ['function_arguments', data.arguments],
  ['function_name', 'load_skill'], ['function_arguments', '{"id":"project:presentation"}'],
  ['function_name', 'add_numbers'], ['function_arguments', '{"a":9223372036854775807,"b":1}'],
  ['unsupported', 'Unsupported content'],
];

export function partialProof(input, sid, runId, head, acceptedSequence) {
  const page = validateConversationPage(input, { kind: 'latest' }, sid), block = page.block;
  if (page.snapshot_head !== head || page.session.head_sequence !== head || block === null || block.run_id !== runId
    || block.accepted_sequence !== acceptedSequence || block.state !== 'running' || block.result_recorded !== false
    || [block.outcome, block.summary, block.events_complete, block.sink_error].some(value => value !== null)
    || page.earlier_activity !== null || page.previous_block !== null || page.entries.length !== 1) reject();
  const entries = [block.human, ...page.entries];
  if (block.human.entry_id !== `e:${acceptedSequence}:0` || block.human.recorded_state !== 'accepted' || block.human.provisional
    || page.entries[0].kind !== 'assistant' || page.entries[0].recorded_state !== 'in_progress' || !page.entries[0].provisional) reject();
  const facts = [[['text', data.user]], richPartialFacts];
  for (const [index, entry] of entries.entries()) {
    if (!entry.content_complete || entry.earlier_content !== null || entry.reference !== null
      || ['result_recorded', 'finish_recorded', 'is_error'].some(key => entry[key] !== null)
      || !isDeepStrictEqual(entry.fields.map(field => [field.kind, field.text]), facts[index])) reject();
    for (const field of entry.fields) {
      const bytes = String(Buffer.byteLength(field.text));
      if (bytes === '0' || field.from_byte !== '0' || field.to_byte !== bytes || field.total_bytes !== bytes
        || field.has_earlier || field.has_later) reject();
    }
  }
  const cursor = parseDisplayCursor(page.live_after, 'live', sid);
  if (cursor.sequence !== head || cursor.rank !== '3' || cursor.run_id !== '' || cursor.entry_id !== '') reject();
  return page;
}

// Compare supplied display values, not reconstructed provider or canonical events.
export function expectedBlock(page) {
  const block = page.block;
  const recording = [`Run: ${block.run_id}`, `Accepted sequence: ${block.accepted_sequence}`,
    `Outcome: ${block.outcome?.type ?? 'not recorded'}`, `Events complete: ${block.events_complete ?? 'not recorded'}`,
    `Sink error: ${block.sink_error ?? 'none'}`, block.summary === null ? 'Summary not recorded.'
      : Object.entries(block.summary).map(([key, value]) => `${key}: ${value ?? 'none'}`).join('\n')].join('\n');
  return { run_id: block.run_id, status: `Execution: ${block.state}. Final result ${block.result_recorded ? 'recorded' : 'not recorded'}.`,
    recording, entries: [block.human, ...page.entries].map(entry => {
      const state = [`Recorded state: ${entry.recorded_state}`, `Provisional: ${entry.provisional}`];
      for (const key of ['result_recorded', 'finish_recorded', 'is_error']) if (entry[key] !== null) state.push(`${key}: ${entry[key]}`);
      return { entry_id: entry.entry_id, kind: entry.kind === 'human' ? 'Human' : entry.kind, state: state.join('; '),
        content: 'Content complete.', fields: entry.fields.map(field => ({ field_id: field.field_id,
          kind: field.kind === 'unsupported' ? 'Unsupported content' : field.kind,
          metadata: `Recorded bytes: ${field.total_bytes}; generation: ${field.generation}`,
          ranges: [{ range: `text:${field.from_byte}`, text: field.text }] })) };
    }) };
}

export async function displayedBlock(run) {
  return run.evaluate(node => ({ run_id: node.dataset.run, status: node.querySelector(':scope > .metadata').textContent,
    recording: node.querySelector(':scope > details > pre').textContent,
    entries: Array.from(node.querySelectorAll('.entry'), entry => ({ entry_id: entry.dataset.entry,
      kind: entry.querySelector('h4').textContent, state: entry.querySelector(':scope > .metadata').textContent,
      content: entry.querySelectorAll(':scope > .metadata')[1].textContent,
      fields: Array.from(entry.querySelectorAll('[data-field]'), field => ({ field_id: field.dataset.field,
        kind: field.querySelector('h5,summary').textContent, metadata: field.querySelector('.metadata').textContent,
        ranges: Array.from(field.querySelectorAll('pre'), pre => ({ range: pre.dataset.range, text: pre.textContent })) })) })) }));
}

export async function normalizedDom(run) {
  return run.evaluate(node => {
    const clone = node.cloneNode(true);
    // Disclosure is page-local. All identities, content, status and other markup stay in the comparison.
    for (const details of clone.querySelectorAll('details')) details.removeAttribute('open');
    return clone.outerHTML;
  });
}

export function freshHandshake({ origin, sid, head, value, snapshots, streams, reply }) {
  if (snapshots.length !== 1 || streams.length !== 1) reject();
  const snapshot = snapshots[0], stream = streams[0], url = `${origin}/v1/sessions/${sid}/conversation`;
  if (snapshot.request !== reply.request() || snapshot.response !== reply || stream.response !== reply
    || snapshot.request === stream.request || snapshot.index >= stream.index || reply.status() !== 200
    || snapshot.request.method() !== 'GET' || snapshot.request.url() !== url || reply.url() !== url
    || stream.request.method() !== 'GET' || value.snapshot_head !== head || value.session_id !== sid) reject();
  const cursor = parseDisplayCursor(value.live_after, 'live', sid);
  if (cursor.sequence !== head || cursor.rank !== '3' || cursor.run_id !== '' || cursor.entry_id !== ''
    || stream.request.url() !== `${url}/events?after=${encodeURIComponent(value.live_after)}`) reject();
  return true;
}

export function readOnly(requests) {
  return requests.every(request => request.method === 'GET');
}
