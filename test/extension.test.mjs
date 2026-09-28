import { test } from 'node:test';
import assert from 'node:assert/strict';
import install from '../extension.ts';
import { fileURLToPath } from 'node:url';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(options = {}, legacy = false) {
  const events = new Map(), commands = new Map(), statuses = [];
  let now = 0;
  const requests = [];
  const fake = {
    closed: false, warm: async () => 0,
    count: (spec, blocks) => new Promise((resolve, reject) => requests.push({ spec, blocks, resolve, reject })),
    close() { this.closed = true; for (const r of requests) r.reject(new Error('stopped')); },
  };
  const ctx = { hasUI: true, model: { id: 'model-a', provider: 'example-provider', name: 'Example family-a' },
    ui: { setStatus: (_key, value) => statuses.push(value), notify: () => {} } };
  install({ on: (name, handler) => events.set(name, [...events.get(name) ?? [], handler]),
    registerCommand: (name, command) => commands.set(name, command),
    ...(!legacy ? { registerEntryRenderer: () => {}, appendEntry: () => {} } : {}) },
    { clock: () => now, makeClient: () => fake, configPath: fileURLToPath(new URL('./fixtures/config.json', import.meta.url)), ...options });
  const emit = (type, data = {}) => { for (const handler of events.get(type) ?? []) handler({ type, ...data }, ctx); };
  emit('session_start');
  return { events, commands, statuses, requests, ctx, fake, emit, at: (time) => { now = time; } };
}

test('final update flushes after in-flight first-batch count; TTFT includes request wait, server tokens stay separate', async () => {
  const h = harness();
  const message = { role: 'assistant', model: 'model-a', provider: 'example-provider', content: [] };
  h.emit('before_provider_request');
  h.at(1000); h.emit('message_start', { message });
  h.at(1500); h.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
  assert.deepEqual(h.requests[0].blocks, ['Hello']);
  h.at(2500); h.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world and other words' } });
  h.at(9000); h.emit('message_end', { message: { ...message, content: [{ type: 'text', text: 'Hello world and other words' }], usage: { output: 88 }, stopReason: 'stop' } });
  h.requests[0].resolve(1); await flush();
  assert.deepEqual(h.requests[1].blocks, ['Hello world and other words']);
  h.requests[1].resolve(5); await flush();
  assert.match(h.statuses.at(-1), /^4.0 tok\/s/);
  assert.match(h.statuses.at(-1), /5 tok · tokenized · TTFT 1.50s/);
  assert.match(h.statuses.at(-1), /server 88 tok/);
  h.emit('session_shutdown');
});

test('unsupported model never receives a substitute tokenizer; provider total still appears', () => {
  const h = harness();
  h.ctx.model = { provider: 'unconfigured-provider', id: 'unconfigured-model' };
  const message = { role: 'assistant', ...h.ctx.model, model: 'unconfigured-model', content: [{ type: 'text', text: 'hello' }] };
  h.emit('message_start', { message });
  h.emit('message_end', { message: { ...message, usage: { output: 19 } } });
  assert.equal(h.requests.length, 0);
  assert.match(h.statuses.at(-1), /tok\/s unavailable.*server 19 tok/);
  h.emit('session_shutdown');
});

test('model switch and shutdown prevent stale asynchronous results from changing the status', async () => {
  const h = harness();
  const message = { role: 'assistant', model: 'model-a', provider: 'example-provider', content: [] };
  h.emit('message_start', { message });
  h.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
  h.ctx.model = { provider: 'example-provider', id: 'model-b', name: 'Example family-b' };
  h.emit('model_select', { model: h.ctx.model });
  const length = h.statuses.length;
  h.requests[0].resolve(2); await flush();
  assert.equal(h.statuses.length, length);
  h.emit('session_shutdown');
  assert.equal(h.fake.closed, true);
});

test('each assistant turn resets baseline; aborted streams preserve received content', async () => {
  const h = harness();
  const message = { role: 'assistant', model: 'model-a', provider: 'example-provider', content: [] };
  for (let turn = 0; turn < 2; turn++) {
    h.at(turn * 3000); h.emit('message_start', { message });
    h.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
    h.requests.at(-1).resolve(1); await flush();
    h.at(turn * 3000 + 1000);
    h.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' } });
    h.emit('message_end', { message: { ...message, content: [{ type: 'text', text: 'hello world' }], stopReason: 'aborted' } });
    assert.deepEqual(h.requests.at(-1).blocks, ['hello world']);
    h.requests.at(-1).resolve(2); await flush();
    assert.match(h.statuses.at(-1), /^1.0 tok\/s.*2 tok.*aborted/);
  }
  h.emit('session_shutdown');
});

test('empty responses show zero and tokenizer failures are explicit', async () => {
  const h = harness();
  const message = { role: 'assistant', model: 'model-a', provider: 'example-provider', content: [] };
  h.emit('message_start', { message }); h.emit('message_end', { message });
  assert.match(h.statuses.at(-1), /0 tok · tokenized/);
  h.emit('message_start', { message });
  h.emit('message_update', { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
  h.requests[0].reject(new Error('broken tokenizer')); await flush();
  assert.match(h.statuses.at(-1), /tok\/s unavailable/);
  h.emit('session_shutdown');
});


test('missing config and older Pi entry APIs do not prevent inference or commands', () => {
  const h = harness({ configPath: '/nonexistent/pi-tokenizer-speed/config.json' }, true);
  const message = { role: 'assistant', model: 'model-a', provider: 'example-provider', content: [{ type: 'text', text: 'hello' }] };
  h.emit('message_start', { message });
  h.emit('message_end', { message });
  assert.equal(h.requests.length, 0);
  assert.match(h.statuses.at(-1), /tok\/s unavailable/);
  assert.ok(h.commands.has('token-speed'));
  h.emit('session_shutdown');
});
