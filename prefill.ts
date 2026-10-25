import { randomUUID } from 'node:crypto';

export const PP_ENTRY = 'tokenizer-speed-pp';
export const PP_RESULT = 'tokenizer-speed-pp-result';
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const positive = (value) => number(value) > 0 ? value : undefined;
const fmt = (value) => value.toLocaleString('en-US', { maximumFractionDigits: 1 });

// This is only a fallback count of exposed prompt text. Chat templates and
// image/audio tokenization are server-owned, so never label it an exact prompt.
export function promptText(payload) {
  const blocks = [];
  function content(value) {
    if (typeof value === 'string') blocks.push(value);
    else if (Array.isArray(value)) for (const item of value) {
      if (typeof item === 'string') blocks.push(item);
      else if (typeof item?.text === 'string') blocks.push(item.text);
      else if (item?.type === 'tool_result') content(item.content);
      else if (item?.type === 'tool_use') blocks.push(item.name ?? '', JSON.stringify(item.input ?? {}));
    }
  }
  if (!payload || typeof payload !== 'object') return blocks;
  content(payload.system); content(payload.instructions); content(payload.prompt);
  const messages = payload.messages ?? (Array.isArray(payload.input) ? payload.input : []);
  if (typeof payload.input === 'string') content(payload.input);
  for (const message of messages) {
    content(message.content);
    if (typeof message.output === 'string') content(message.output);
    if (typeof message.arguments === 'string') blocks.push(message.name ?? '', message.arguments);
    for (const tool of message.tool_calls ?? []) {
      blocks.push(tool.function?.name ?? '', tool.function?.arguments ?? tool.custom?.input ?? '');
    }
  }
  if (Array.isArray(payload.tools) && payload.tools.length) blocks.push(JSON.stringify(payload.tools));
  return blocks.filter((value) => typeof value === 'string' && value.length > 0);
}

export function readPrefillMetadata(data, state) {
  if (!data || typeof data !== 'object') return;
  const response = data.response ?? data.message ?? data;
  const usage = data.usage ?? response.usage;
  if (Array.isArray(data.prompt_token_ids) && data.prompt_token_ids.every(Number.isInteger)) {
    state.promptTokens = data.prompt_token_ids.length;
  }
  if (usage) {
    if (number(usage.prompt_tokens) !== undefined) state.promptTokens = usage.prompt_tokens;
    else if (number(usage.input_tokens) !== undefined) {
      // Anthropic input_tokens excludes cache reads/writes; Responses includes them.
      const anthropic = state.api === 'anthropic-messages';
      state.promptTokens = usage.input_tokens + (anthropic ? (number(usage.cache_read_input_tokens) ?? 0)
        + (number(usage.cache_creation_input_tokens) ?? 0) : 0);
    }
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? usage.cache_read_input_tokens;
    if (number(cached) !== undefined) state.cachedTokens = cached;
    if (state.api === 'anthropic-messages' && number(usage.input_tokens) !== undefined) state.cachedTokens ??= 0;
  }
  const stats = data.mtplx_stats ?? response.mtplx_stats;
  if (stats && ('prefill_compute_tok_s' in stats || 'prompt_eval_time_s' in stats)) {
    // MTPLX's generic timings divide the entire prompt by suffix-only time.
    // Its explicit compute statistic already excludes cached prompt tokens.
    const total = number(stats.prompt_tokens);
    const cached = number(stats.cached_tokens);
    const tokens = stats.new_prefill_tokens !== undefined ? number(stats.new_prefill_tokens)
      : total !== undefined && cached !== undefined && cached <= total ? total - cached : undefined;
    const seconds = positive(stats.prompt_eval_time_s);
    const rate = positive(stats.prefill_compute_tok_s);
    if (tokens > 0 && seconds && rate) {
      state.native = { rate, tokens, seconds, scope: 'server_prefill_compute' };
    } else {
      // Do not fall back to the misleading full-prompt rate for zero work or
      // incomplete counters. Missing timing stays unavailable.
      delete state.native;
    }
    return;
  }
  const timings = data.timings ?? response.timings;
  if (timings && (positive(timings.prompt_per_second) || positive(timings.prompt_ms))) {
    const tokens = number(timings.prompt_n);
    const seconds = positive(timings.prompt_ms) ? timings.prompt_ms / 1000 : undefined;
    const rate = positive(timings.prompt_per_second) ?? (tokens !== undefined && seconds ? tokens / seconds : undefined);
    if (rate !== undefined) state.native = { rate, tokens, seconds,
      ...(['server_prefill_phase', 'server_prefill_wall', 'server_prefill_active'].includes(timings.scope) ? { scope: timings.scope } : {}) };
    if (number(timings.cache_n) !== undefined) state.cachedTokens = timings.cache_n;
  } else if (usage && (positive(usage.prompt_tokens_per_sec) || positive(usage.prompt_time))) {
    const seconds = positive(usage.prompt_time);
    // A prompt duration alone is insufficient when the processed token count
    // is unknown. In particular, never treat the cached history as fresh input.
    const tokens = state.promptTokens === undefined || state.cachedTokens === undefined
      ? undefined : Math.max(0, state.promptTokens - state.cachedTokens);
    const rate = positive(usage.prompt_tokens_per_sec) ?? (tokens !== undefined && seconds ? tokens / seconds : undefined);
    if (rate !== undefined) state.native = { rate, tokens, seconds };
  }
}

export function hasOutput(data) {
  if (!data || typeof data !== 'object') return false;
  if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta',
    'response.function_call_arguments.delta'].includes(data.type)) return Boolean(data.delta);
  if (data.type === 'content_block_delta') return Boolean(data.delta?.text || data.delta?.thinking || data.delta?.partial_json);
  return Boolean(data.choices?.some((choice) => {
    const delta = choice.delta;
    return choice.text || delta?.content || delta?.reasoning_content || delta?.reasoning || delta?.tool_calls?.some(
      (tool) => tool.function?.name || tool.function?.arguments || tool.custom?.input);
  }));
}

export function prefillLine(state) {
  if (!state) return 'PP unavailable';
  const parts = [];
  if (number(state.toolMs) !== undefined) {
    parts.push(`Tools ${(state.toolMs / 1000).toFixed(2)}s wall${state.toolCount > 1 ? ` (${state.toolCount} calls)` : ''}`);
  }
  if (number(state.firstMs) !== undefined) parts.push(`Model TTFT ${(state.firstMs / 1000).toFixed(2)}s`);
  else parts.push(state.ended ? 'Model TTFT unavailable' : 'Model waiting for first output…');
  if (state.native) {
    const { rate, tokens, seconds, scope } = state.native;
    const phase = { server_prefill_phase: 'phase', server_prefill_wall: 'wall', server_prefill_active: 'active', server_prefill_compute: 'compute' }[scope];
    parts.push(`PP ${fmt(rate)} tok/s · server${phase ? ` ${phase}` : ''}${tokens !== undefined ? ` · ${fmt(tokens)} processed tok` : ''}`
      + `${seconds !== undefined ? ` · ${seconds.toFixed(2)}s prefill${phase ? ` ${phase}` : ''}` : ''}`);
  } else {
    // TTFT includes queueing, transport, cache restore and first-token decode.
    // Neither all prompt text nor uncached tokens / TTFT measures prefill speed.
    parts.push(state.firstMs === undefined && state.ended
      ? 'PP unavailable · no first output observed' : 'PP unavailable · no server timing');
    if (number(state.promptTokens) !== undefined) {
      if (number(state.cachedTokens) !== undefined) {
        parts.push(`${fmt(Math.max(0, state.promptTokens - state.cachedTokens))} uncached tok`);
      } else parts.push(`${fmt(state.promptTokens)} prompt tok; cache unknown`);
    } else if (number(state.textTokens) !== undefined) {
      parts.push(`${fmt(state.textTokens)} prompt-text tok; cache unknown`);
    }
  }
  return parts.join(' · ');
}

export function installPrefill(pi, { clock, countPrompt, makeComponent, enabled }) {
  const states = new Map();
  const runningTools = new Set();
  let toolIntervalStarted;
  let toolMs = 0;
  let toolCount = 0;
  let active;
  let generation = 0;

  function resetTools() {
    runningTools.clear();
    toolIntervalStarted = undefined;
    toolMs = 0;
    toolCount = 0;
  }

  function persist(state) {
    if (!state || !state.shown) return;
    // Only numeric measurements and model identifiers are saved, never prompts.
    const data = { id: state.id, model: state.model, provider: state.provider, api: state.api,
      firstMs: state.firstMs, promptTokens: state.promptTokens, cachedTokens: state.cachedTokens,
      textTokens: state.textTokens, native: state.native, ended: state.ended,
      toolMs: state.toolMs, toolCount: state.toolCount };
    const serialized = JSON.stringify(data);
    if (state.saved === serialized) return;
    state.saved = serialized;
    pi.appendEntry(PP_RESULT, data);
  }

  function first() {
    if (!active || active.firstMs !== undefined) return;
    active.firstMs = Math.max(0, clock() - active.started);
    persist(active);
  }

  function restore(ctx) {
    generation++;
    active = undefined;
    resetTools();
    states.clear();
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type === 'custom' && (entry.customType === PP_ENTRY || entry.customType === PP_RESULT) && entry.data?.id) {
        states.set(entry.data.id, { ...entry.data, ended: true });
      }
    }
  }

  pi.registerEntryRenderer(PP_ENTRY, (entry, _options, theme) => {
    if (!entry.data?.id) return undefined;
    const getText = () => prefillLine(states.get(entry.data.id) ?? { ...entry.data, ended: true });
    return makeComponent ? makeComponent(getText, theme) : { render: () => [getText()], invalidate() {} };
  });
  pi.registerEntryRenderer(PP_RESULT, () => undefined);
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_switch', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => {
    if (active && !active.ended) { active.ended = true; persist(active); }
    generation++;
    active = undefined;
    resetTools();
  });

  pi.on('agent_start', () => resetTools());
  pi.on('agent_end', () => {
    if (active && !active.ended) { active.ended = true; persist(active); }
    resetTools();
  });
  pi.on('tool_execution_start', (event) => {
    if (!event.toolCallId || runningTools.has(event.toolCallId)) return;
    if (!runningTools.size) toolIntervalStarted = clock();
    runningTools.add(event.toolCallId);
    toolCount++;
  });
  pi.on('tool_execution_end', (event) => {
    if (!runningTools.delete(event.toolCallId)) return;
    if (!runningTools.size) {
      // Union of execution intervals: parallel/nested tools must not double
      // count elapsed wall time. Gaps between sequential tools are excluded.
      toolMs += Math.max(0, clock() - toolIntervalStarted);
      toolIntervalStarted = undefined;
    }
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (active && !active.ended) { active.ended = true; persist(active); }
    const state = { id: randomUUID(), model: ctx.model?.id, provider: ctx.model?.provider, api: ctx.model?.api,
      started: clock(), shown: enabled(), ended: false,
      ...(toolCount && !runningTools.size ? { toolMs, toolCount } : {}) };
    resetTools();
    active = state;
    states.set(state.id, state);
    // This runs after the input/tool results are displayed and before Pi creates
    // the assistant component. The entry stays in this position permanently.
    if (state.shown) pi.appendEntry(PP_ENTRY, { id: state.id, model: state.model, provider: state.provider,
      toolMs: state.toolMs, toolCount: state.toolCount });
    const epoch = generation;
    const blocks = promptText(event.payload);
    if (blocks.length) {
      Promise.resolve(countPrompt(ctx.model, blocks)).then((count) => {
        if (epoch !== generation || number(count) === undefined) return;
        state.textTokens = count;
        if (state.firstMs !== undefined || state.ended) persist(state);
      }).catch(() => {});
    }
  });

  pi.on('provider_stream_event', (event) => {
    if (!active || active.ended || event.provider !== active.provider || event.model !== active.model) return;
    readPrefillMetadata(event.data, active);
    if (hasOutput(event.data)) first();
    // Metadata can arrive after the answer has begun. The dynamic entry renderer
    // updates the original line; this hidden journal entry only persists it.
    if (active.firstMs !== undefined || active.native) persist(active);
  });

  pi.on('message_update', (event) => {
    if (!active || active.ended || event.message.role !== 'assistant') return;
    const update = event.assistantMessageEvent;
    if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update.type) && update.delta) first();
    if (update.type === 'toolcall_start' && update.partial?.content?.[update.contentIndex]?.name) first();
  });

  pi.on('message_end', (event) => {
    if (!active || active.ended || event.message.role !== 'assistant') return;
    const usage = event.message.usage;
    // Normalized positive usage is useful when a provider lacks raw event hooks.
    // Pi initializes absent usage to zero, so zero is not evidence of zero input.
    if (active.promptTokens === undefined && usage && (usage.input > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0)) {
      active.promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (usage.cacheRead > 0) active.cachedTokens = usage.cacheRead;
    }
    active.ended = true;
    persist(active);
  });
}
