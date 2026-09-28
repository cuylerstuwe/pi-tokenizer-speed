import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPrefill, prefillLine, promptText, readPrefillMetadata, PP_ENTRY, PP_RESULT } from '../prefill.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(entries = [], countPrompt = async () => 120) {
  let time = 0;
  const handlers = new Map(), renderers = new Map(), transcript = [];
  const ctx = { model: { id: 'model-a', provider: 'example-provider', api: 'openai-completions' },
    sessionManager: { getBranch: () => entries } };
  const pi = {
    on: (type, handler) => handlers.set(type, handler),
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry: (customType, data) => {
      const entry = { type: 'custom', customType, data: structuredClone(data) };
      entries.push(entry);
      const component = renderers.get(customType)?.(entry, {}, {});
      if (component) transcript.push(component);
    },
  };
  installPrefill(pi, { clock: () => time, countPrompt, enabled: () => true });
  const emit = (type, data = {}) => handlers.get(type)?.({ type, ...data }, ctx);
  emit('session_start');
  return { ctx, transcript, entries, renderers, emit, at: (value) => { time = value; },
    line: () => transcript.at(-1).render()[0] };
}

test('PP entry precedes response, updates in place, and measures tool continuations independently', async () => {
  const h = harness();
  for (const role of ['user', 'tool']) {
    h.transcript.push(role);
    h.at(role === 'user' ? 0 : 3000);
    h.emit('before_provider_request', { payload: { messages: [{ role, content: 'input' }] } });
    assert.equal(h.line(), 'PP processing…');
    const index = h.transcript.length - 1;
    await flush();
    h.at(role === 'user' ? 1000 : 5000);
    h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a', data: { prompt_token_ids: Array(100).fill(1), choices: [{ delta: { content: 'answer' } }] } });
    assert.match(h.line(), role === 'user' ? /PP ≈100 tok\/s/ : /PP ≈50 tok\/s/);
    h.transcript.push('assistant');
    h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a', data: { timings: { prompt_n: 80, prompt_ms: 100, prompt_per_second: 800 } } });
    assert.equal(h.transcript[index].render()[0], 'PP 800 tok/s · server · 80 processed tok · 0.10s');
    h.emit('message_end', { message: { role: 'assistant', usage: { input: 80, cacheRead: 20 } } });
    assert.equal(h.transcript[index - 1], role);
    assert.equal(h.transcript[index + 1], 'assistant');
  }
  assert.equal(h.entries.filter((entry) => entry.customType === PP_ENTRY).length, 2);
  assert.equal(h.transcript.length, 6, 'hidden result entries add no visible transcript rows');
});

test('results survive session reload without being added to model messages', async () => {
  const h = harness();
  h.emit('before_provider_request', { payload: { messages: [{ role: 'user', content: 'private input' }] } });
  await flush(); h.at(2000);
  h.emit('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } });
  h.emit('message_end', { message: { role: 'assistant', usage: { input: 80, cacheRead: 20 } } });
  const expected = h.line();
  const persisted = JSON.parse(JSON.stringify(h.entries));
  assert.ok(persisted.every((entry) => entry.type === 'custom'));
  assert.ok(!JSON.stringify(persisted).includes('private input'));
  const restored = harness(persisted);
  const anchor = persisted.find((entry) => entry.customType === PP_ENTRY);
  const component = restored.renderers.get(PP_ENTRY)(anchor, {}, {});
  assert.equal(component.render()[0], expected);
  assert.match(expected, /PP ≈40 tok\/s.*80 uncached tok/);
  assert.equal(restored.renderers.get(PP_RESULT)(persisted.at(-1)), undefined);
});

test('cache counts are subtracted only when known; estimates cannot masquerade as native speed', () => {
  const state = { firstMs: 1000, promptTokens: 1000 };
  assert.match(prefillLine(state), /PP ≈1,000 tok\/s.*cache unknown/);
  readPrefillMetadata({ usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } } }, state);
  assert.match(prefillLine(state), /PP ≈100 tok\/s.*100 uncached tok/);
  readPrefillMetadata({ timings: { prompt_n: 100, prompt_ms: 50 } }, state);
  assert.match(prefillLine(state), /PP 2,000 tok\/s · server/);
});

test('OpenAI Responses and Anthropic cache semantics differ', () => {
  const openai = { api: 'openai-responses' }, anthropic = { api: 'anthropic-messages' };
  readPrefillMetadata({ response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 70 } } } }, openai);
  readPrefillMetadata({ message: { usage: { input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10 } } }, anthropic);
  assert.equal(openai.promptTokens, 100); assert.equal(openai.cachedTokens, 70);
  assert.equal(anthropic.promptTokens, 100); assert.equal(anthropic.cachedTokens, 70);
});

test('late tokenizer completion after session switch cannot append to another session', async () => {
  let complete;
  const h = harness([], () => new Promise((resolve) => { complete = resolve; }));
  h.emit('before_provider_request', { payload: { messages: [{ content: 'input' }] } });
  h.at(1000); h.emit('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  h.emit('session_switch');
  const count = h.entries.length;
  complete(400); await flush();
  assert.equal(h.entries.length, count);
});

test('tokenizer failure and abort before output do not invent a speed', async () => {
  const h = harness([], async () => { throw new Error('no tokenizer'); });
  h.emit('before_provider_request', { payload: { messages: [{ content: 'input' }] } });
  await flush(); h.at(2000);
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'aborted' } });
  assert.equal(h.line(), 'PP unavailable · no first output observed');
});

test('fallback tokenizes user/tool inputs and schemas but not image bytes or request settings', () => {
  const blocks = promptText({ model: 'ignored-model', temperature: 1, instructions: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }, { type: 'image_url', image_url: { url: 'secret-base64' } }] },
      { role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: '{"path":"x"}' } }] },
      { role: 'tool', content: 'tool result' }], tools: [{ name: 'read' }] });
  assert.deepEqual(blocks, ['system', 'question', 'read', '{"path":"x"}', 'tool result', '[{"name":"read"}]']);
});
