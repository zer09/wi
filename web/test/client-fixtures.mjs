import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createClient } from '../dist/client.js';
import * as wire from './wire-fixtures.mjs';

export const token = 'ab'.repeat(32);
export function json(value, status = 200, type = 'application/json') {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': type } });
}
export function httpError(code = 'api.not_found', certainty = 'not_applicable', acceptance = null) {
  return { api_version: 1, code, certainty, acceptance, stage: null, notices: [] };
}
export function event(kind, sequence, sid = wire.sid, data) {
  const view = wire.event(kind, String(sequence), sid);
  view.event_id = BigInt(sequence).toString(16).padStart(32, '0').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  if (data !== undefined) view.data = data;
  return view;
}
export function page(events, sid = wire.sid, through = events.at(-1)?.sequence ?? '1') {
  const end = events.at(-1)?.sequence ?? through;
  return { api_version: 1, session_id: sid, through_sequence: through, next_after: `${sid}:${end}`,
    has_more: BigInt(end) < BigInt(through), events };
}
export function stream() {
  let control;
  let cancelled = 0;
  const body = new ReadableStream({ start(value) { control = value; }, cancel() { cancelled += 1; } });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    push(text) { control.enqueue(new TextEncoder().encode(text)); },
    close() { control.close(); },
    fail() { control.error(new Error('private transport details')); },
    get cancelled() { return cancelled; },
  };
}
export async function tick() { await setImmediate(); }
export function harness(options = {}) {
  const calls = [];
  let serial = 0;
  const crypto = { randomUUID() { serial += 1; return `bbbbbbbb-0000-4000-8000-${serial.toString(16).padStart(12, '0')}`; } };
  const client = createClient({ fetch(url, init) {
    return new Promise((resolve, reject) => { calls.push({ url, init, resolve, reject }); });
  }, crypto, ...options });
  let consumed = 0;
  return {
    client, calls,
    get uuids() { return serial; },
    async next(path, method = 'GET') {
      await tick();
      const call = calls[consumed++];
      assert.ok(call, 'expected a request');
      assert.equal(call.url, path);
      assert.equal(call.init.method, method);
      return call;
    },
    async connect(entries = []) {
      const done = client.connect(token);
      (await this.next('/v1/settings')).resolve(json(wire.settings));
      (await this.next('/v1/sessions?limit=32')).resolve(json({ api_version: 1, entries,
        next_after_id: entries.at(-1)?.session_id ?? null, has_more: false }));
      await done;
      assert.equal(client.snapshot().connection, 'connected');
    },
    async select(sid = wire.sid, events = [event('session.created', 1, sid)]) {
      const done = client.selectSession(sid);
      (await this.next(`/v1/sessions/${sid}`)).resolve(json({ ...wire.session, session_id: sid, head_sequence: events.at(-1).sequence }));
      (await this.next(`/v1/sessions/${sid}/history?after=${sid}%3A0&limit=32`)).resolve(json(page(events, sid)));
      const observation = stream();
      (await this.next(`/v1/sessions/${sid}/events?after=${sid}%3A${events.at(-1).sequence}`)).resolve(observation.response);
      await done; await tick();
      return observation;
    },
  };
}
