// Synthetic only. Failures never print fixtures or assertion exception details.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { command, Evidence, run } from './cli_retest.mjs';

const sentinel = 'PRIVATE_SENTINEL';
const message = text => ({ id: sentinel, kind: 'message', native_type: 'message', function_call: null,
  native: { id: sentinel, type: 'message', content: [{ type: 'output_text', text }] } });
const call = () => ({ id: sentinel, kind: 'function_call', native_type: 'function_call',
  function_call: { call_id: sentinel, name: 'add_numbers', arguments: '{"a":17,"b":25}', origin: 'direct', namespace: null, complete: true },
  native: { id: sentinel, type: 'function_call', call_id: sentinel, name: 'add_numbers', arguments: '{"a":17,"b":25}' } });
// Matches EventEnvelope's #[serde(flatten)] rather than nesting ProviderEvent.
const responseId = request => `${sentinel}_${request}`;
const automaticSequence = Symbol('automaticSequence');
let nextSequence = 0, nextEventId = 0;
const envelope = (request, event) => ({ schema_version: 1, sequence: automaticSequence, request_id: request,
  ...(['response_started', 'response_status', 'output_item_started', 'output_item_updated', 'output_item_finished'].includes(event.type)
    ? { response_id: responseId(request) } : {}),
  ...event, event_id: `${sentinel}_${nextEventId++}`, session_id: sentinel, provider: 'openai-codex' });
const start = request => envelope(request, { type: 'response_started' });
const terminal = (request, output, text = '') => envelope(request, { type: 'response_finished',
  response: { id: responseId(request), outcome: { status: 'completed' }, output, text, native: { output: output.map(i => i.native), private: sentinel } } });
const execution = (type, callId = sentinel) => ({ type, tool_name: 'add_numbers', call_id: callId, is_error: false });
// Assign default sequences in wire order after fixture splices; explicit invalid values stay unchanged.
const encode = values => Buffer.from(values.map(v => JSON.stringify(v.sequence === automaticSequence
  ? { ...v, sequence: nextSequence++ } : v)).join('\n') + '\n');
const continuation = () => [start('r1'), terminal('r1', [message('acknowledged é')], 'acknowledged é'), start('r2'), terminal('r2', [message('lantern')], 'lantern')];
const tool = () => [start('r1'), terminal('r1', [call()]), execution('tool_execution_started'), execution('tool_execution_finished'), start('r2'), terminal('r2', [message('42')], '42')];
function summary(which, events, exit = 0, stderr = '') {
  const e = new Evidence(which);
  e.data(encode(events));
  e.errorData(Buffer.from(stderr));
  const result = e.summary(exit);
  assert.ok(!JSON.stringify(result).includes(sentinel));
  return result;
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  child.unref = () => {};
  return child;
}

export async function selfTest() {
  let tests = 0;
  const test = async fn => { await fn(); tests++; };
  await test(() => {
    assert.deepEqual(command('continuation'), ['generate', '--auth-source', 'codex', '--model', 'gpt-6-astra', '--transport', 'websocket', '--json', '--prompt', 'Remember the word lantern and acknowledge.', '--follow-up', 'What word did I ask you to remember?']);
    assert.deepEqual(command('tool'), ['tool-demo', '--auth-source', 'codex', '--model', 'gpt-6-astra', '--transport', 'websocket', '--json']);
    assert.throws(() => command('arbitrary'));
  });
  await test(() => {
    const events = continuation();
    for (const event of events.filter(e => e.type === 'response_finished')) {
      event.response.output_provenance = 'validated_output_item_done';
      event.response.native.output = [];
    }
    const result = summary('continuation', events);
    assert.equal(result.assertions_passed, true);
    assert.equal(result.requests[0].effective_items.total, 1);
    assert.equal(result.requests[0].native_terminal_items.total, 0);
    assert.equal(result.requests[0].effective_text_state, 'available');
    assert.equal(JSON.stringify(result).includes('terminal_text_state'), false);
    assert.equal(result.requests[0].output_provenance, 'validated_output_item_done');
    assert.equal(summary('continuation', continuation()).requests[0].output_provenance, 'native_terminal');
    assert.equal(summary('continuation', events, 1).assertions_passed, false);
    events[1].response.output_provenance = sentinel;
    assert.equal(summary('continuation', events).assertions_passed, false);
    events[1].response.output_provenance = null;
    assert.equal(summary('continuation', events).assertions_passed, false);
  });
  await test(() => {
    const bytes = encode(continuation());
    for (const size of [1, 2, 7, bytes.length]) {
      const e = new Evidence('continuation');
      for (let i = 0; i < bytes.length; i += size) e.data(bytes.subarray(i, i + size));
      const result = e.summary(0);
      assert.equal(result.assertions_passed, true);
      assert.equal(result.requests[1].lantern_present, true);
      assert.equal(result.accounting.observed_request_ids, 2);
      assert.equal(result.accounting.observed_transport_submissions, null);
      assert.ok(!JSON.stringify(result).includes(sentinel));
    }
  });
  await test(() => {
    const result = summary('tool', tool());
    assert.equal(result.assertions_passed, true);
    assert.equal(result.executor.correlated, true);
    assert.equal(result.executor.result42_observed, null);
    assert.equal(result.executor.result42_validated_by_cli_inferred, true);
  });
  await test(() => {
    for (const mutate of [
      c => { c.function_call.complete = false; },
      c => { c.function_call.origin = sentinel; },
      c => { c.function_call.namespace = sentinel; },
      c => { c.native.namespace = {}; },
      c => { c.native.status = null; },
      c => { c.native.caller = { type: sentinel }; },
      c => { c.function_call.name = sentinel; },
      c => { c.function_call.arguments = '{"a":17.0,"b":25}'; c.native.arguments = c.function_call.arguments; },
      c => { c.native.arguments = '{"a":1,"b":2}'; },
      c => { c.function_call.call_id = ''; },
    ]) {
      const events = tool(); mutate(events[1].response.output[0]);
      const result = summary('tool', events);
      assert.equal(result.assertions_passed, false);
      assert.equal(result.requests[0].exact_add_numbers_17_25, false);
    }
  });
  await test(() => {
    for (const change of [
      events => { events[2].call_id = 'different'; },
      events => { events[3].is_error = true; },
      events => { events[3].tool_name = sentinel; },
      events => { events.splice(2, 1); },
      events => { events.splice(2, 0, execution('tool_result_reused')); },
    ]) {
      const events = tool(); change(events);
      const result = summary('tool', events);
      assert.equal(result.assertions_passed, false);
      assert.equal(result.executor.correlated, false);
    }
  });
  await test(() => {
    const result = summary('tool', [start('r1'), terminal('r1', [message('42')], '42')], 1,
      'error: demo expected a tool call but the model did not request one\n');
    assert.equal(result.public_error, 'no_tool');
    assert.equal(result.accounting.conservative_upper_bound, 1);
    assert.equal(result.accounting.basis, 'inferred_first_response_stop');
    assert.equal(result.assertions_passed, false);
  });
  await test(() => {
    for (const item of [message(sentinel), call()]) {
      const events = [start('r1'), envelope('r1', { type: 'output_item_finished', output_index: 0, item }), terminal('r1', [])];
      const result = summary('tool', events, 1, 'error: invalid provider protocol: CLI streamed output is inconsistent with terminal output or exceeds tracking limits\n');
      assert.equal(result.requests[0].done_items.total, 1);
      assert.equal(result.requests[0].effective_items.total, 0);
      assert.equal(result.requests[0].exact_add_numbers_17_25, false);
      assert.equal(result.accounting.conservative_upper_bound, 1);
      assert.equal(result.assertions_passed, false);
    }
  });
  await test(() => {
    const events = [start('r1'), envelope('r1', { type: 'output_item_updated', kind: 'text', delta: sentinel }), terminal('r1', [])];
    const result = summary('continuation', events, 1);
    assert.equal(result.requests[0].deltas.text, 1);
    assert.equal(result.requests[0].effective_text_state, 'no_ordinary_parts');
    assert.equal(result.accounting.conservative_upper_bound, 2);
  });
  await test(() => {
    const e = new Evidence('tool'); e.data(Buffer.from('{bad\n'));
    assert.equal(e.summary(1).reason, 'invalid_json');
    const truncated = new Evidence('tool'); truncated.data(Buffer.from('{}'));
    assert.equal(truncated.summary(1).reason, 'truncated_json');
    const utf8 = new Evidence('tool'); utf8.data(Buffer.from([0xff, 10]));
    assert.equal(utf8.summary(1).reason, 'invalid_json');
  });
  await test(() => {
    const e = new Evidence('tool'); e.data(Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    assert.equal(e.summary(null).reason, 'line_overflow');
    const err = new Evidence('tool'); err.errorData(Buffer.alloc(65537));
    assert.equal(err.summary(null).reason, 'stderr_overflow');
    const cumulative = new Evidence('tool');
    for (let i = 0; i < 65; i++) cumulative.data(encode([
      envelope('r1', { type: 'provider_extension', payload: 'x'.repeat(1024 * 1024) }),
    ]));
    assert.equal(cumulative.summary(null).reason, 'cumulative_overflow');
  });
  await test(() => {
    const events = [start('r1'), envelope('r1', { type: 'provider_extension', event_type: sentinel, payload: { [sentinel]: sentinel } }), terminal('r1', [message(sentinel)], sentinel)];
    const result = summary('continuation', events, 1, sentinel);
    assert.equal(result.public_error, 'unclassified');
    assert.equal(result.requests[0].effective_text_state, 'available');
    const unknown = summary('tool', [envelope('r1', { type: sentinel })], 1);
    assert.equal(unknown.reason, 'invalid_event');
  });
  await test(() => {
    const result = summary('continuation', [start('r1'), envelope('r1', { type: 'request_failed', code: sentinel, message: sentinel, upstream_outcome: sentinel })], 1);
    assert.equal(result.requests[0].failed, 1);
    assert.equal(result.accounting.conservative_upper_bound, 2);
  });
  await test(() => {
    const events = continuation(); events.push(start('r3'));
    assert.equal(summary('continuation', events).reason, 'request_overflow');
    assert.equal(summary('continuation', [start('r1'), start('r1')]).reason, 'invalid_lifecycle');
  });
  await test(async () => {
    const child = fakeChild();
    const result = await run('tool', (path, args, opts) => {
      assert.ok(path.endsWith('/target/debug/wi'));
      assert.equal(opts.shell, false);
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
      assert.deepEqual(args, command('tool'));
      setImmediate(() => { child.stdout.write(encode(tool())); child.emit('close', 0, null); });
      return child;
    }, 1000, 5);
    assert.equal(result.assertions_passed, true);
    assert.deepEqual(child.signals, []);
  });
  await test(async () => {
    const child = fakeChild();
    const result = await run('continuation', () => child, 5, 5);
    assert.equal(result.time_limit, true);
    assert.equal(result.accounting.conservative_upper_bound, 2);
    assert.equal(result.accounting.observed_request_ids, 0);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  });
  await test(async () => {
    const child = fakeChild();
    const result = await run('tool', () => {
      setImmediate(() => { child.stdout.write(encode([start('r1')])); process.emit('SIGINT'); });
      return child;
    }, 1000, 5);
    assert.equal(result.cancelled, true);
    assert.equal(result.accounting.conservative_upper_bound, 2);
    assert.equal(result.assertions_passed, false);
  });
  await test(async () => {
    const result = await run('tool', () => { throw new Error(sentinel); }, 5, 5);
    assert.equal(result.reason, 'spawn_failed');
    assert.equal(result.accounting.conservative_upper_bound, 2);
    assert.ok(!JSON.stringify(result).includes(sentinel));
  });
  await test(async () => {
    const child = fakeChild();
    const result = await run('tool', () => {
      setImmediate(() => child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 32)));
      return child;
    }, 1000, 5);
    assert.equal(result.reason, 'line_overflow');
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(result.accounting.conservative_upper_bound, 2);
  });
  const update = () => envelope('r1', { type: 'output_item_updated', kind: 'text', delta: sentinel });
  const status = () => envelope('r1', { type: 'response_status', status: 'in_progress' });
  const extension = request => envelope(request, { type: 'provider_extension', payload: sentinel });
  const closed = () => envelope(null, { type: 'session_closed', reason: sentinel });
  const reject = (which, events) => {
    const result = summary(which, events);
    assert.equal(result.assertions_passed, false);
    assert.equal(result.accounting.conservative_upper_bound, 2);
  };
  // Each ordering violation must fail even with otherwise successful terminal answers.
  for (const event of [update(), status(),
    envelope('r1', { type: 'output_item_started', item: message(sentinel) }),
    envelope('r1', { type: 'output_item_finished', item: message(sentinel) }),
    terminal('r1', [])]) {
    await test(() => reject('continuation', [event, ...continuation()]));
  }
  for (const type of ['tool_execution_started', 'tool_execution_finished', 'tool_result_reused']) {
    await test(() => {
      const events = continuation(); events.splice(2, 0, execution(type));
      reject('continuation', events);
    });
  }
  for (const position of [0, 1, 2, 3, 4]) {
    await test(() => {
      const events = continuation(); events.splice(position, 0, closed());
      reject('continuation', events);
    });
  }
  for (const invalid of [undefined, null, '', 7, sentinel, sentinel.repeat(513)]) {
    for (const target of ['start', 'status', 'item', 'update', 'terminal', 'terminal_envelope']) {
      // A start may choose any new bounded ID; mismatch is checked on subsequent events.
      await test(() => {
        const events = continuation();
        if (target === 'start') events[0].response_id = invalid;
        else if (target === 'terminal') events[1].response.id = invalid;
        else if (target === 'terminal_envelope') events[1].response_id = invalid;
        else {
          let event = envelope('r1', { type: 'output_item_finished', item: message(sentinel) });
          if (target === 'status') event = status();
          else if (target === 'update') event = update();
          event.response_id = invalid; events.splice(1, 0, event);
        }
        // JSON omits undefined fields, including an optional terminal envelope ID.
        if (target === 'terminal_envelope' && invalid === undefined) delete events[1].response.id;
        reject('continuation', events);
      });
    }
  }
  for (const mutate of [
    events => events.splice(1, 0, start('r1')),
    events => events.splice(2, 0, terminal('r1', [])),
    events => events.splice(2, 0, update()),
    events => events.splice(3, 0, extension('r1')),
    events => { events[2].response_id = responseId('r1'); events[3].response.id = responseId('r1'); },
    events => { events[3].request_id = `${sentinel}_unknown`; },
    events => { delete events[0].request_id; },
  ]) {
    await test(() => { const events = continuation(); mutate(events); reject('continuation', events); });
  }
  for (const type of ['provider_extension', 'request_failed']) {
    for (const position of [2, 3]) {
      await test(() => {
        const events = tool();
        events.splice(position, 0, envelope('r2', { type }));
        const e = new Evidence('tool');
        e.data(encode(events.slice(0, position + 1)));
        assert.equal(e.summary(0).reason, 'invalid_lifecycle');
        // Later valid executor and response events cannot repair an early request.
        e.data(encode(events.slice(position + 1)));
        const result = e.summary(0);
        assert.equal(result.reason, 'invalid_lifecycle');
        assert.equal(result.assertions_passed, false);
        assert.equal(summary('tool', events).assertions_passed, false);
      });
    }
  }
  for (const position of [0, 1, 5, 6]) {
    await test(() => {
      const events = tool(); events.splice(position, 0, execution('tool_execution_started'));
      reject('tool', events);
    });
  }
  for (const mutate of [
    events => events.splice(2, 2),
    events => events.splice(3, 1),
    events => { [events[2], events[3]] = [events[3], events[2]]; },
    events => events.splice(3, 0, execution('tool_execution_started')),
    events => events.splice(4, 0, execution('tool_execution_finished')),
    events => { events[1].response.outcome.status = 'incomplete'; },
  ]) {
    await test(() => { const events = tool(); mutate(events); reject('tool', events); });
  }
  await test(() => {
    const events = continuation(); events.splice(1, 0, status(), update());
    assert.equal(summary('continuation', events).assertions_passed, true);
    for (const which of ['continuation', 'tool']) {
      const events = which === 'tool' ? tool() : continuation();
      events.unshift(extension('r1'));
      assert.equal(summary(which, events).assertions_passed, true);
    }
    reject('continuation', [extension('r1')]);
  });
  await test(() => {
    const failed = envelope('r1', { type: 'request_failed', code: sentinel, message: sentinel });
    const result = summary('continuation', [extension('r1'), failed], 1);
    assert.equal(result.requests[0].failed, 1);
    assert.equal(result.requests[0].started, 0);
    assert.equal(result.reason, null);
    assert.equal(result.assertions_passed, false);
    assert.equal(result.accounting.conservative_upper_bound, 2);
    reject('continuation', [failed, ...continuation()]);
  });
  await test(() => {
    const events = [update(), start('r1'), terminal('r1', [])];
    const result = summary('tool', events, 1,
      'error: invalid provider protocol: CLI streamed output is inconsistent with terminal output or exceeds tracking limits\n');
    assert.equal(result.accounting.conservative_upper_bound, 2);
    assert.equal(result.assertions_passed, false);
  });
  // Envelope failures must not be hidden by valid terminal answers or a clean CLI exit.
  for (const field of ['sequence', 'event_id', 'session_id', 'provider']) {
    const invalids = field === 'sequence'
      ? [undefined, null, '', '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, {}, true]
      : [undefined, null, '', 7, {}, true, sentinel.repeat(513), 'é'.repeat(257)];
    for (const invalid of invalids) {
      await test(() => {
        const events = continuation(); events[0][field] = invalid;
        const result = summary('continuation', events);
        assert.equal(result.reason, 'invalid_envelope');
        assert.equal(result.assertions_passed, false);
        assert.equal(result.requests.length, 0);
      });
    }
  }
  for (const mutate of [
    events => events.forEach((e, i) => { e.sequence = [99, 1, 1, 0][i]; }),
    events => events.forEach((e, i) => { e.sequence = [0, 1, 1, 2][i]; }),
    events => events.forEach((e, i) => { e.sequence = [0, 2, 1, 3][i]; }),
    events => { events[2].event_id = events[0].event_id; },
    events => { events[2].session_id = `${sentinel}_changed`; },
    events => { events[2].provider = sentinel; },
    events => { delete events[2].event_id; },
    events => { delete events[2].session_id; },
    events => { delete events[2].provider; },
    events => { delete events[2].sequence; },
  ]) {
    await test(() => {
      const events = continuation(); mutate(events);
      const result = summary('continuation', events);
      assert.equal(result.reason, 'invalid_envelope');
      assert.equal(result.assertions_passed, false);
    });
  }
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', true, {}, []]) {
    await test(() => {
      const events = continuation(); events[0].provider_sequence = invalid;
      const result = summary('continuation', events);
      assert.equal(result.reason, 'invalid_envelope');
      assert.equal(result.requests.length, 0);
      assert.equal(result.assertions_passed, false);
    });
  }
  for (const invalid of [undefined, null, 0, 2, '1', {}, sentinel]) {
    await test(() => {
      const events = continuation(); events[0].schema_version = invalid;
      const result = summary('continuation', events);
      assert.equal(result.assertions_passed, false);
      assert.equal(result.requests.length, 0);
    });
  }
  await test(() => {
    const events = continuation();
    events.forEach((e, i) => {
      e.sequence = [0, 2, 99, Number.MAX_SAFE_INTEGER][i];
      e.provider_sequence = [Number.MAX_SAFE_INTEGER, 0, null, undefined][i];
      e.session_id = sentinel + 'é'.repeat(248);
      e.event_id = `${i}_${sentinel}` + 'é'.repeat(247);
      e.request_id = `${sentinel}_${e.request_id}`;
    });
    const result = summary('continuation', events);
    assert.equal(result.assertions_passed, true);
    assert.ok(result.requests.every(r => !['session_id', 'event_id', 'request_id', 'response_id', 'sequence', 'provider'].some(k => Object.hasOwn(r, k))));
  });
  await test(() => {
    const events = tool(); events[2].event_id = sentinel;
    assert.equal(summary('tool', events).reason, 'invalid_envelope');
  });
  await test(() => {
    const e = new Evidence('continuation');
    for (let i = 0; i < 8193; i++) {
      if (i === 8192) assert.equal(e.summary(0).reason, null);
      const request = i < 4096 ? 'r1' : 'r2';
      if (i === 4095) e.data(encode([terminal('r1', [])]));
      else if (i === 0) e.data(encode([start('r1')]));
      else e.data(encode([envelope(request, { type: 'provider_extension' })]));
    }
    assert.equal(e.summary(0).reason, 'event_overflow');
    assert.ok(!JSON.stringify(e.summary(0)).includes(sentinel));
  });
  return tests;
}
