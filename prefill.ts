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
  const timings = data.timings ?? response.timings;
  if (timings && (positive(timings.prompt_per_second) || positive(timings.prompt_ms))) {
    const tokens = number(timings.prompt_n);
    const seconds = positive(timings.prompt_ms) ? timings.prompt_ms / 1000 : undefined;
    const rate = positive(timings.prompt_per_second) ?? (tokens !== undefined && seconds ? tokens / seconds : undefined);
    if (rate !== undefined) state.native = { rate, tokens, seconds };
    if (number(timings.cache_n) !== undefined) state.cachedTokens = timings.cache_n;
  } else if (usage && (positive(usage.prompt_tokens_per_sec) || positive(usage.prompt_time))) {
    const seconds = positive(usage.prompt_time);
    const tokens = state.promptTokens === undefined ? undefined : Math.max(0, state.promptTokens - (state.cachedTokens ?? 0));
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
  if (state.native) {
    const { rate, tokens, seconds } = state.native;
    return `PP ${fmt(rate)} tok/s · server${tokens !== undefined ? ` · ${fmt(tokens)} processed tok` : ''}`
      + `${seconds !== undefined ? ` · ${seconds.toFixed(2)}s` : ''}`;
  }
  if (state.firstMs !== undefined && state.firstMs > 0) {
    const exactPrompt = state.promptTokens !== undefined;
    const cached = number(state.cachedTokens);
    const tokens = exactPrompt ? Math.max(0, state.promptTokens - (cached ?? 0)) : state.textTokens;
    const seconds = state.firstMs / 1000;
    if (tokens !== undefined) {
      const basis = exactPrompt ? cached !== undefined ? 'uncached tok' : 'prompt tok; cache unknown' : 'prompt-text tok; cache unknown';
      return `PP ≈${fmt(tokens / seconds)} tok/s · TTFT estimate · ${fmt(tokens)} ${basis} · ${seconds.toFixed(2)}s`;
    }
    return `PP timing unavailable · TTFT ${seconds.toFixed(2)}s${state.ended ? '' : ' · waiting for token count'}`;
  }
  return state.ended ? 'PP unavailable · no first output observed' : 'PP processing…';
}

export function installPrefill(pi, { clock, countPrompt, makeComponent, enabled }) {
  const states = new Map();
  let active;
  let generation = 0;

  function persist(state) {
    if (!state || !state.shown) return;
    // Only numeric measurements and model identifiers are saved, never prompts.
    const data = { id: state.id, model: state.model, provider: state.provider, api: state.api,
      firstMs: state.firstMs, promptTokens: state.promptTokens, cachedTokens: state.cachedTokens,
      textTokens: state.textTokens, native: state.native, ended: state.ended };
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
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (active && !active.ended) { active.ended = true; persist(active); }
    const state = { id: randomUUID(), model: ctx.model?.id, provider: ctx.model?.provider, api: ctx.model?.api,
      started: clock(), shown: enabled(), ended: false };
    active = state;
    states.set(state.id, state);
    // This runs after the input/tool results are displayed and before Pi creates
    // the assistant component. The entry stays in this position permanently.
    if (state.shown) pi.appendEntry(PP_ENTRY, { id: state.id, model: state.model, provider: state.provider });
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
