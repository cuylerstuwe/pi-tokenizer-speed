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
    assert.equal(h.line(), 'Model waiting for first output… · PP unavailable · no server timing');
    const index = h.transcript.length - 1;
    await flush();
    h.at(role === 'user' ? 1000 : 5000);
    h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a', data: { prompt_token_ids: Array(100).fill(1), choices: [{ delta: { content: 'answer' } }] } });
    assert.match(h.line(), role === 'user' ? /Model TTFT 1.00s/ : /Model TTFT 2.00s/);
    assert.match(h.line(), /100 prompt tok; cache unknown/);
    assert.doesNotMatch(h.line(), /tok\/s/);
    h.transcript.push('assistant');
    h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a', data: { timings: { prompt_n: 80, prompt_ms: 100, prompt_per_second: 800 } } });
    assert.match(h.transcript[index].render()[0], /PP 800 tok\/s · server · 80 processed tok · 0.10s prefill$/);
    h.emit('message_end', { message: { role: 'assistant', usage: { input: 80, cacheRead: 20 } } });
    assert.equal(h.transcript[index - 1], role);
    assert.equal(h.transcript[index + 1], 'assistant');
  }
  assert.equal(h.entries.filter((entry) => entry.customType === PP_ENTRY).length, 2);
  assert.equal(h.transcript.length, 6, 'hidden result entries add no visible transcript rows');
});

test('results survive session reload without being added to model messages', async () => {
  const h = harness();
  h.emit('tool_execution_start', { toolCallId: 'a' });
  h.at(1000); h.emit('tool_execution_end', { toolCallId: 'a' });
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
  assert.match(expected, /Tools 1.00s wall · Model TTFT 1.00s.*80 uncached tok/);
  assert.doesNotMatch(expected, /tok\/s/);
  assert.equal(restored.renderers.get(PP_RESULT)(persisted.at(-1)), undefined);
});

test('cache counts are subtracted only when known; only server timing produces a speed', () => {
  const state = { firstMs: 1000, promptTokens: 1000 };
  assert.match(prefillLine(state), /Model TTFT 1.00s.*1,000 prompt tok; cache unknown/);
  assert.doesNotMatch(prefillLine(state), /tok\/s/);
  readPrefillMetadata({ usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } } }, state);
  assert.match(prefillLine(state), /100 uncached tok/);
  assert.doesNotMatch(prefillLine(state), /tok\/s/);
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

test('MTPLX uses compute timing and suffix tokens instead of its inflated generic cached rate', () => {
  for (const cached of [0, 1065]) {
    const seconds = 0.05, tokens = 1070 - cached;
    const state = {};
    readPrefillMetadata({
      usage: { prompt_tokens: 1070, prompt_tokens_details: { cached_tokens: cached } },
      timings: { prompt_n: 1070, prompt_ms: 50, prompt_per_second: 21400 },
      mtplx_stats: { prompt_tokens: 1070, cached_tokens: cached, prompt_eval_time_s: seconds, prefill_compute_tok_s: tokens / seconds },
    }, state);
    assert.deepEqual(state.native, {rate: tokens / seconds, tokens, seconds, scope:'server_prefill_compute'});
    assert.match(prefillLine(state), /server compute/);
    assert.equal(state.cachedTokens, cached);
  }
});

test('MTPLX missing, zero-work and invalid compute counters never fall back to an inflated cached rate', () => {
  for (const overrides of [
    {cached_tokens:1070}, {cached_tokens:1071}, {cached_tokens:-1},
    {cached_tokens:undefined}, {prompt_tokens:undefined},
    {prompt_eval_time_s:0}, {prompt_eval_time_s:NaN}, {prefill_compute_tok_s:Infinity},
  ]) {
    const state = {native:{rate:999999}};
    readPrefillMetadata({
      timings:{prompt_n:1070,prompt_ms:50,prompt_per_second:21400},
      mtplx_stats:{prompt_tokens:1070,cached_tokens:1065,prompt_eval_time_s:0.05,prefill_compute_tok_s:100,...overrides},
    },state);
    assert.equal(state.native,undefined);
    assert.match(prefillLine(state),/PP unavailable/);
  }
});

test('MTPLX explicit processed count takes precedence and respects zero work', () => {
  for (const count of [5, 0, -1, NaN]) {
    const state={};
    readPrefillMetadata({mtplx_stats:{new_prefill_tokens:count,prompt_tokens:1000,cached_tokens:990,prompt_eval_time_s:0.05,prefill_compute_tok_s:100}},state);
    if(count>0) assert.equal(state.native.tokens,count);
    else assert.equal(state.native,undefined);
  }
});

test('Server reports server prefill phase explicitly and persists late timing metadata', () => {
  const h = harness();
  h.ctx.model.id = 'model-b';
  h.emit('before_provider_request', { payload: {} });
  h.at(1500);
  h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-b',
    data: { choices: [{ delta: { content: 'OK' } }] } });
  h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-b', data: {
    choices: [], timings: { prompt_n: 100, prompt_ms: 50, prompt_per_second: 2000,
      cache_n: 9900, scope: 'server_prefill_phase' } } });
  h.emit('message_end', { message: { role: 'assistant', usage: { input:100,cacheRead:9900 } } });
  assert.match(h.line(), /Model TTFT 1.50s · PP 2,000 tok\/s · server phase · 100 processed tok · 0.05s prefill phase/);
  assert.equal(h.entries.at(-1).data.native.scope, 'server_prefill_phase');
  assert.equal(h.entries.at(-1).data.cachedTokens, 9900);
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
  assert.equal(h.line(), 'Model TTFT unavailable · PP unavailable · no first output observed');
});

test('long tool execution and idle delay are separate from request-to-first-output time', async () => {
  const h = harness();
  h.emit('tool_execution_start', { toolCallId: 'script', toolName: 'bash' });
  h.at(60_000);
  h.emit('tool_execution_update', { toolCallId: 'script', partialResult: { content: 'still working' } });
  assert.equal(h.transcript.length, 0, 'no model-processing line while a script is running');
  h.at(90_000); h.emit('tool_execution_end', { toolCallId: 'script', isError: true });
  h.at(100_000); h.emit('before_provider_request', { payload: { messages: [{ role: 'tool', content: 'result' }] } });
  assert.match(h.line(), /^Tools 90.00s wall · Model waiting for first output/);
  await flush();
  h.at(102_000); h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a',
    data: { choices: [{ delta: { reasoning_content: 'thinking' } }] } });
  assert.match(h.line(), /^Tools 90.00s wall · Model TTFT 2.00s/);
  assert.doesNotMatch(h.line(), /tok\/s/);
  h.at(105_000); h.emit('message_update', { message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
  assert.match(h.line(), /Model TTFT 2.00s/, 'first reasoning counts, not the later visible answer');
  h.emit('message_end', { message: { role: 'assistant' } });
  assert.equal(h.entries.at(-1).data.firstMs, 2000);
  assert.equal(h.entries.at(-1).data.toolMs, 90_000);

  h.emit('before_provider_request', { payload: {} });
  assert.doesNotMatch(h.line(), /Tools/, 'a later request does not reuse the tool batch');
});

test('parallel and nested tools count wall time once, excluding gaps between executions', () => {
  const h = harness();
  h.emit('tool_execution_start', { toolCallId: 'a' });
  h.emit('tool_execution_start', { toolCallId: 'a' }); // duplicate start
  h.at(1000); h.emit('tool_execution_start', { toolCallId: 'b', parentToolCallId: 'a' });
  h.at(2000); h.emit('tool_execution_end', { toolCallId: 'b' });
  h.at(4000); h.emit('tool_execution_end', { toolCallId: 'a' });
  h.at(5000); h.emit('tool_execution_end', { toolCallId: 'a' }); // duplicate end
  h.at(10_000); h.emit('tool_execution_start', { toolCallId: 'c' });
  h.at(12_000); h.emit('tool_execution_end', { toolCallId: 'c' });
  h.emit('before_provider_request', { payload: {} });
  assert.match(h.line(), /^Tools 6.00s wall \(3 calls\)/);
});

test('unfinished and stale tool batches do not leak across sessions or agent runs', () => {
  for (const reset of ['session_switch', 'session_tree', 'session_start', 'agent_start', 'agent_end', 'session_shutdown']) {
    const h = harness();
    h.emit('tool_execution_start', { toolCallId: 'old' });
    h.at(1000); h.emit(reset);
    h.at(2000); h.emit('tool_execution_end', { toolCallId: 'old' });
    h.emit('before_provider_request', { payload: {} });
    assert.doesNotMatch(h.line(), /Tools/, reset);
  }
  const h = harness();
  h.emit('tool_execution_start', { toolCallId: 'unfinished' });
  h.at(5000); h.emit('before_provider_request', { payload: {} });
  assert.doesNotMatch(h.line(), /Tools/, 'do not report an incomplete execution as a completed duration');
});

test('late cache statistics change counts without inventing wildly different PP rates', async () => {
  const h = harness([], async () => 114027);
  h.emit('before_provider_request', { payload: { messages: [{ content: 'long cached history' }] } });
  await flush();
  h.at(2418); h.emit('message_update', { message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } });
  assert.match(h.line(), /Model TTFT 2.42s.*114,027 prompt-text tok; cache unknown/);
  assert.doesNotMatch(h.line(), /tok\/s/);
  h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a',
    data: { usage: { prompt_tokens: 114027, prompt_tokens_details: { cached_tokens: 113802 } } } });
  assert.match(h.line(), /Model TTFT 2.42s.*225 uncached tok/);
  assert.doesNotMatch(h.line(), /tok\/s/);
  h.emit('provider_stream_event', { provider: 'example-provider', model: 'model-a',
    data: { timings: { prompt_n: 225, prompt_ms: 50 } } });
  assert.match(h.line(), /Model TTFT 2.42s · PP 4,500 tok\/s · server · 225 processed tok · 0.05s prefill/);
});

test('native prompt_time cannot turn unknown cache counts into a prefill rate', () => {
  const state = { firstMs: 1000 };
  readPrefillMetadata({ usage: { prompt_tokens: 100000, prompt_time: 0.1 } }, state);
  assert.doesNotMatch(prefillLine(state), /tok\/s/);
  readPrefillMetadata({ usage: { prompt_tokens: 100000, prompt_tokens_details: { cached_tokens: 99900 }, prompt_time: 0.1 } }, state);
  assert.match(prefillLine(state), /PP 1,000 tok\/s · server · 100 processed tok · 0.10s prefill/);
  const directRate = {};
  readPrefillMetadata({ usage: { prompt_tokens: 100000, prompt_tokens_per_sec: 2000 } }, directRate);
  assert.match(prefillLine(directRate), /PP 2,000 tok\/s · server/);
});

test('zero-duration TTFT and fully cached input do not invent infinite or zero PP rates', () => {
  const line = prefillLine({ firstMs: 0, promptTokens: 1000, cachedTokens: 1000, toolMs: 0, toolCount: 1 });
  assert.match(line, /^Tools 0.00s wall · Model TTFT 0.00s.*0 uncached tok/);
  assert.doesNotMatch(line, /tok\/s|Infinity|NaN/);
});

test('fallback tokenizes user/tool inputs and schemas but not image bytes or request settings', () => {
  const blocks = promptText({ model: 'ignored-model', temperature: 1, instructions: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }, { type: 'image_url', image_url: { url: 'secret-base64' } }] },
      { role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: '{"path":"x"}' } }] },
      { role: 'tool', content: 'tool result' }], tools: [{ name: 'read' }] });
  assert.deepEqual(blocks, ['system', 'question', 'read', '{"path":"x"}', 'tool result', '[{"name":"read"}]']);
});

test('preserves distinct native active and wall prefill scopes', () => {
  for (const [scope,label] of [['server_prefill_active','active'],['server_prefill_wall','wall']]) {
    const state = { firstMs: 5000, ended: true };
    readPrefillMetadata({timings:{prompt_n:1000,prompt_ms:500,cache_n:9000,scope}},state);
    assert.equal(state.native.rate,2000);
    assert.equal(state.cachedTokens,9000);
    assert.match(prefillLine(state), new RegExp('server '+label));
    assert.match(prefillLine(state), new RegExp('0.50s prefill '+label));
  }
});
