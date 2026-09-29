import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError } from '../dist/api.js';
import { WiSseParser } from '../dist/sse.js';
import * as f from './wire-fixtures.mjs';

const encoder = new TextEncoder();
function bytes(text) { return encoder.encode(text); }
function parse(chunks) {
  const records = [];
  const parser = new WiSseParser(f.sid, record => records.push(record));
  for (const chunk of chunks) parser.push(chunk);
  parser.finish();
  assert.equal(parser.done, true);
  return records;
}
function expected(view) { return { kind: 'event', id: `${view.session_id}:${view.sequence}`, event: view }; }
function fails(action, category) {
  assert.throws(action, error => {
    assert.ok(error instanceof ProtocolError);
    if (category !== undefined) assert.equal(error.category, category);
    assert.equal(error.message, `protocol.${error.category}`);
    assert.equal(error.cause, undefined);
    return true;
  });
}
function rejectsSuffix(suffix, category) {
  const view = f.event('session.created');
  const records = [];
  const parser = new WiSseParser(f.sid, record => records.push(record));
  fails(() => parser.push(bytes(f.frame(view) + suffix)), category);
  assert.deepEqual(records, [expected(view)]);
  assert.equal(parser.done, true);
  parser.push(bytes(f.frame(f.event('checkpoint', '2'))));
  parser.finish();
  assert.deepEqual(records, [expected(view)]);
}

for (const ending of ['LF', 'CR', 'CRLF', 'mixed']) {
  test(`SSE ${ending}: every byte split including BOM, UTF-8 and CRLF`, () => {
    const view = f.event('session.renamed', '9007199254740993');
    let number = 0;
    const delimiter = () => {
      if (ending === 'LF') return '\n';
      if (ending === 'CR') return '\r';
      if (ending === 'CRLF') return '\r\n';
      return ['\n', '\r', '\r\n'][number++ % 3];
    };
    const input = bytes('\ufeff' + (': keep-alive\n\n' + f.frame(view)).replaceAll('\n', delimiter));
    for (let split = 0; split <= input.length; split += 1) assert.deepEqual(parse([input.subarray(0, split), input.subarray(split)]), [expected(view)]);
    assert.deepEqual(parse(Array.from(input, byte => Uint8Array.of(byte))), [expected(view)]);
  });
}

test('SSE every Rust EventView kind parses in one chunk and one-byte chunks', () => {
  const kinds = ['session.created', ...Object.keys(f.eventData).filter(kind => kind !== 'session.created')];
  const views = kinds.map((kind, index) => f.event(kind, (BigInt(index) + 1n).toString()));
  const input = bytes(views.map(view => f.frame(view)).join(''));
  assert.deepEqual(parse([input]), views.map(expected));
  assert.deepEqual(parse(Array.from(input, byte => Uint8Array.of(byte))), views.map(expected));
  const chunks = [];
  for (let offset = 0; offset < input.length;) {
    const size = offset % 23 + 1;
    chunks.push(input.subarray(offset, offset + size));
    offset += size;
  }
  assert.deepEqual(parse(chunks), views.map(expected));
});

test('SSE multiline data joins with LF, strips one optional space and uses first colon', () => {
  const view = f.event('session.created');
  const data = JSON.stringify(view, null, 2).split('\n').map(line => `data: ${line}\r\n`).join('');
  const input = bytes(`event:wi.event\r\nid:${f.sid}:1\r\n${data}data:\r\n\r\n`);
  for (let split = 0; split <= input.length; split += 1) assert.deepEqual(parse([input.subarray(0, split), input.subarray(split)]), [expected(view)]);
  assert.equal(parse([input])[0].event.data.title, f.exactText);
  // A JSON newline inside a string is not repaired by SSE framing.
  rejectsSuffix(`event:wi.event\nid:${f.sid}:1\ndata:{"private":"line\ndata:two"}\n\n`, 'invalid_json');
});

test('SSE comments, blank lines, unknown fields and retry never create records or cursors', () => {
  const view = f.event();
  const input = `\n\n: keep-alive\n: id: foreign\nretry: 0\nretry: 9007199254740993\nunknown: ignored\nfield_without_colon\n\n${f.frame(view)}: tail\n\n`;
  assert.deepEqual(parse([bytes(input)]), [expected(view)]);
  assert.deepEqual(parse([bytes(':comment\r\n\r\nretry:0\n\n')]), []);
  const parser = new WiSseParser(f.sid, () => assert.fail('comment emitted a record'));
  parser.push(bytes(': keep-alive\n\n'));
  assert.equal(parser.done, false);
  parser.finish();
});

test('SSE id and event fields use the last field but never inherit across frames', () => {
  const view = f.event();
  const input = `event: ignored\nid: ${f.otherSid}:9\n${f.frame(view)}`;
  assert.deepEqual(parse([bytes(input)]), [expected(view)]);
  rejectsSuffix(`event:wi.event\ndata:${JSON.stringify(view)}\n\n`, 'invalid_cursor');
  rejectsSuffix(`id:${f.sid}:1\ndata:${JSON.stringify(view)}\n\n`, 'invalid_sse');
});

test('SSE accepts one initial BOM and preserves later BOM characters as data', () => {
  const view = f.event('session.created');
  assert.deepEqual(parse([bytes('\ufeff' + f.frame(view))]), [expected(view)]);
  fails(() => parse([bytes('\ufeff\ufeff' + f.frame(view))]), 'invalid_sse');
  rejectsSuffix('\ufeff' + f.frame(view), 'invalid_sse');
  const records = parse([bytes(f.frame(view))]);
  assert.equal(records[0].event.data.title.includes('\ufeff'), true);
});

test('SSE dispatches only at blank delimiters and discards every unfinished EOF prefix', () => {
  const view = f.event();
  const input = bytes(f.frame(view));
  for (let end = 0; end < input.length; end += 1) assert.deepEqual(parse([input.subarray(0, end)]), []);
  assert.deepEqual(parse([input]), [expected(view)]);
  const records = [];
  const parser = new WiSseParser(f.sid, record => records.push(record));
  parser.push(input.subarray(0, -1));
  assert.deepEqual(records, []);
  parser.push(input.subarray(-1));
  assert.deepEqual(records, [expected(view)]);
  parser.push(bytes('event:wi.event\ndata:{"unfinished":'));
  parser.finish();
  assert.deepEqual(records, [expected(view)]);
  // A blank CR is already a delimiter, even when its optional LF never arrives.
  assert.deepEqual(parse([bytes(f.frame(view).replaceAll('\n', '\r'))]), [expected(view)]);
});

test('SSE flat wi.error ends observation without an id, cursor or task completion', () => {
  const wire = `event: wi.error\ndata: ${JSON.stringify(f.error)}\n\n`;
  const input = bytes(wire);
  for (let split = 0; split <= input.length; split += 1) assert.deepEqual(parse([input.subarray(0, split), input.subarray(split)]), [{ kind: 'error', error: f.error }]);
  assert.deepEqual(parse([bytes(f.frame() + wire + f.frame())]), [expected(f.event()), { kind: 'error', error: f.error }]);
  for (const id of ['', `${f.sid}:1`]) rejectsSuffix(`event:wi.error\nid:${id}\ndata:${JSON.stringify(f.error)}\n\n`, 'invalid_sse');
  rejectsSuffix(`event:wi.error\ndata:${JSON.stringify({ error: f.error })}\n\n`, 'invalid_schema');
});

test('SSE wi.closed uses the exact shutdown schema and ends only observation', () => {
  const wire = `event: wi.closed\ndata: ${JSON.stringify(f.closed)}\n\n`;
  const input = bytes(wire);
  for (let split = 0; split <= input.length; split += 1) assert.deepEqual(parse([input.subarray(0, split), input.subarray(split)]), [{ kind: 'closed', closed: f.closed }]);
  const records = [];
  const parser = new WiSseParser(f.sid, record => records.push(record));
  parser.push(bytes(f.frame() + wire + 'invalid bytes ignored after closure'));
  parser.push(Uint8Array.of(255));
  assert.equal(parser.done, true);
  assert.deepEqual(records, [expected(f.event()), { kind: 'closed', closed: f.closed }]);
  rejectsSuffix(`event:wi.closed\nid:\ndata:${JSON.stringify(f.closed)}\n\n`, 'invalid_sse');
  for (const value of [{ ...f.closed, reason: 'completed' }, { ...f.closed, api_version: 2 }, { reason: 'shutdown' }, { ...f.closed, session_id: f.sid }]) rejectsSuffix(`event:wi.closed\ndata:${JSON.stringify(value)}\n\n`);
});

test('SSE malformed event/data/id/session/schema fails after the last valid record', () => {
  const view = f.event();
  for (const input of [
    'event:unknown\ndata:{}\n\n',
    'event:wi.event\n\n',
    'data:{}\n\n',
    `event: wi.event\nid:${f.sid}:2\ndata:\n\n`,
    `event: wi.event\nid:${f.sid}:2\ndata:private-body-canary\n\n`,
    `event:  wi.event\nid:${f.sid}:2\ndata:${JSON.stringify(view)}\n\n`,
    `event:\twi.event\nid:${f.sid}:2\ndata:${JSON.stringify(view)}\n\n`,
    `event\nid:${f.sid}:2\ndata:${JSON.stringify(view)}\n\n`,
  ]) rejectsSuffix(input);
  for (const id of ['', `${f.sid}:0`, `${f.sid}:1`, `${f.otherSid}:2`, `${f.sid}:02`, `${f.sid}:2:3`, `${f.sid}:9223372036854775808`, `${f.sid}:2\u0000`, `  ${f.sid}:2`, f.sid, 'not-uuid:2']) rejectsSuffix(`event:wi.event\nid:${id}\ndata:${JSON.stringify(view)}\n\n`);
  for (const change of [
    { session_id: f.otherSid }, { event_id: 'not-uuid' }, { sequence: '0' }, { sequence: 1 },
    { api_version: 2 }, { kind: 'new.kind' }, { data: { native: 'synthetic-canary' } },
    { run_id: null }, { private: 'synthetic-canary' },
  ]) rejectsSuffix(`event:wi.event\nid:${f.sid}:2\ndata:${JSON.stringify({ ...view, ...change })}\n\n`);
});

test('SSE rejects impossible session.created sequences and retains only the valid prefix', () => {
  const prefix = f.event('session.created');
  const prefixBytes = bytes(f.frame(prefix));
  const invalid = [
    ...Object.keys(f.eventData).filter(kind => kind !== 'session.created').map(kind => f.event(kind, '1')),
    ...['2', '9007199254740993', '9223372036854775807'].map(sequence => f.event('session.created', sequence)),
  ];
  for (const view of invalid) {
    rejectsSuffix(f.frame(view), 'invalid_schema');
    const input = bytes(f.frame(prefix) + f.frame(view) + f.frame(f.event('checkpoint', '3')));
    for (const split of [prefixBytes.length, input.length - 1]) {
      const records = [];
      const parser = new WiSseParser(f.sid, record => records.push(record));
      fails(() => { parser.push(input.subarray(0, split)); parser.push(input.subarray(split)); }, 'invalid_schema');
      assert.deepEqual(records, [expected(prefix)]);
      assert.equal(parser.done, true);
      parser.push(bytes(f.frame(f.event('checkpoint', '3'))));
      parser.finish();
      assert.deepEqual(records, [expected(prefix)]);
    }
  }
});

test('SSE fatal UTF-8 retains valid prefix even when a later bad byte shares its chunk', () => {
  for (const invalid of [[0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x28, 0xa1]]) {
    const prefix = bytes(f.frame());
    const suffix = Uint8Array.from([...bytes('data: '), ...invalid, ...bytes('\n\n')]);
    const wire = Uint8Array.from([...prefix, ...suffix]);
    for (let split = 0; split <= wire.length; split += 1) {
      const records = [];
      const parser = new WiSseParser(f.sid, record => records.push(record));
      fails(() => { parser.push(wire.subarray(0, split)); parser.push(wire.subarray(split)); parser.finish(); }, 'invalid_utf8');
      assert.deepEqual(records, [expected(f.event())]);
      assert.equal(parser.done, true);
    }
  }
});

test('SSE incomplete UTF-8 fails at EOF instead of silently replacing bytes', () => {
  for (const partial of [[0xc2], [0xe2, 0x82], [0xf0, 0x9f, 0x99], [0xef, 0xbb]]) {
    const records = [];
    const parser = new WiSseParser(f.sid, record => records.push(record));
    parser.push(bytes(f.frame()));
    parser.push(Uint8Array.from(partial));
    fails(() => parser.finish(), 'invalid_utf8');
    assert.deepEqual(records, [expected(f.event())]);
    assert.equal(parser.done, true);
  }
});

test('SSE parser leaves ordering, duplicates and applied cursor ownership to the reducer', () => {
  const views = [f.event('checkpoint', '9007199254740993'), f.event('checkpoint', '9007199254740993'), f.event('checkpoint', '9223372036854775807')];
  assert.deepEqual(parse([bytes(views.map(view => f.frame(view)).join(''))]), views.map(expected));
  rejectsSuffix(f.frame(f.event('checkpoint', '9223372036854775808')), 'invalid_cursor');
});

test('SSE callback failure stops parsing and does not expose exception details', () => {
  let calls = 0;
  const parser = new WiSseParser(f.sid, () => { calls += 1; throw new Error('private-exception-canary'); });
  fails(() => parser.push(bytes(f.frame() + f.frame())), 'consumer_failed');
  parser.push(bytes(f.frame()));
  assert.equal(calls, 1);
  assert.equal(parser.done, true);
});
