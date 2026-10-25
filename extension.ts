import { loadConfig, selectTokenizer, configLocation } from './config.ts';
import { performance } from 'node:perf_hooks';
import { TokenizerClient } from './client.ts';
import { OutputBlocks, Throughput } from './meter.ts';
import { installPrefill } from './prefill.ts';

const statusKey = 'tokenizer-speed';
const formatRate = (value) => value === undefined ? '—' : value.toFixed(1);

export default function install(pi, options = {}) {
  const clock = options.clock ?? (() => performance.now());
  const makeClient = options.makeClient ?? (() => new TokenizerClient());
  const configPath = options.configPath ?? configLocation(options.agentDir);
  let config;
  let configError;
  let client;
  let current;
  let timer;
  let enabled = true;
  let ui;
  let requestStarted;

  function readConfig() {
    ({ config, error: configError } = loadConfig(configPath));
  }

  function selection(model) {
    return selectTokenizer(config ?? { models: {} }, model, configPath);
  }

  function stopTimer() { clearInterval(timer); timer = undefined; }

  function render(state = current) {
    if (!enabled || !ui?.hasUI || !state || current !== state) return;
    const end = state.ended ? state.lastArrival ?? state.started : clock();
    const rates = state.meter.rates(end);
    const total = state.meter.latest?.count;
    let text;
    if (state.error) {
      text = `tok/s unavailable · ${state.model.id}`;
    } else if (total === undefined) {
      text = `tok/s — · ${state.firstArrival === undefined ? 'waiting' : 'tokenizing'} · ${state.model.id}`;
    } else {
      const speed = state.ended ? rates.average : rates.rolling;
      text = `${formatRate(speed)} tok/s`;
      if (!state.ended) text += ` · avg ${formatRate(rates.average)}`;
      text += ` · ${total.toLocaleString('en-US')} tok · tokenized`;
      if (state.firstArrival !== undefined) text += ` · TTFT ${((state.firstArrival - state.started) / 1000).toFixed(2)}s`;
      text += ` · ${state.model.id}`;
    }
    if (state.ended) {
      text += ` · ${state.stopReason === 'aborted' ? 'aborted' : state.stopReason === 'error' ? 'error' : 'done'}`;
      if (state.providerOutput > 0) text += ` · server ${state.providerOutput.toLocaleString('en-US')} tok`;
    }
    ui.ui.setStatus(statusKey, text);
  }

  async function sample(state) {
    if (!client || state.error || state.busy || current !== state) return;
    if (state.sampledRevision === state.blocks.revision) { render(state); return; }
    const blocks = state.blocks.snapshot();
    if (!blocks.some(Boolean)) {
      if (state.ended) {
        state.meter.add(state.lastArrival ?? clock(), 0);
        state.sampledRevision = state.blocks.revision;
      }
      render(state);
      return;
    }
    state.busy = true;
    const revision = state.blocks.revision;
    const at = state.lastArrival ?? clock();
    try {
      const count = await client.count(state.spec, blocks);
      if (current !== state) return;
      state.meter.add(at, count);
      state.sampledRevision = revision;
    } catch (error) {
      if (current === state) state.error = error.message;
    } finally {
      state.busy = false;
      if (current === state) {
        render(state);
        // Always flush the final content, including changes during an in-flight
        // count. Regular updates are coalesced by the UI interval.
        if (state.ended && !state.error && state.sampledRevision !== state.blocks.revision) void sample(state);
      }
    }
  }

  function warm(model) {
    if (!model || !client) return;
    const selected = selection(model);
    if (selected.spec) void client.warm(selected.spec).catch(() => {});
  }

  function reset(ctx) {
    stopTimer();
    current = undefined;
    ui = ctx;
    ctx.ui.setStatus(statusKey, undefined);
  }

  pi.on('session_start', (_event, ctx) => {
    readConfig();
    reset(ctx);
    client?.close();
    client = makeClient();
    warm(ctx.model);
    if (configError && ctx.hasUI) ctx.ui.notify(`Token speed: ${configError}`, 'warning');
  });

  pi.on('model_select', (event, ctx) => { reset(ctx); warm(event.model); });
  pi.on('session_switch', (_event, ctx) => { reset(ctx); warm(ctx.model); });
  pi.on('before_provider_request', () => { requestStarted = clock(); });

  pi.on('message_start', (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    reset(ctx);
    if (!config) readConfig();
    if (!client || client.closed) client = makeClient();
    const model = {
      ...ctx.model,
      id: event.message.model || ctx.model?.id,
      provider: event.message.provider || ctx.model?.provider,
    };
    const selected = selection(model);
    current = {
      model, ...selected, started: requestStarted ?? clock(), blocks: new OutputBlocks(),
      meter: new Throughput(config.windowMs ?? 3000), sampledRevision: -1, busy: false, ended: false,
    };
    requestStarted = undefined;
    render();
    timer = setInterval(() => {
      if (current && !current.ended) { void sample(current); render(); }
    }, Math.max(100, config.updateIntervalMs ?? 250));
    timer.unref?.();
  });

  pi.on('message_update', (event) => {
    if (!current || current.ended || event.message.role !== 'assistant') return;
    const changed = current.blocks.update(event.assistantMessageEvent);
    if (!changed || !current.blocks.snapshot().some(Boolean)) return;
    current.lastArrival = clock();
    if (current.firstArrival === undefined) {
      current.firstArrival = current.lastArrival;
      // Capture the first batch before subsequent updates can join it.
      void sample(current);
    }
  });

  pi.on('message_end', (event) => {
    if (!current || event.message.role !== 'assistant') return;
    stopTimer();
    current.blocks.finish(event.message.content);
    current.lastArrival ??= clock();
    current.ended = true;
    current.stopReason = event.message.stopReason;
    current.providerOutput = event.message.usage?.output;
    void sample(current);
    render();
  });

  pi.on('session_shutdown', () => {
    stopTimer();
    current = undefined;
    client?.close();
    client = undefined;
    ui?.ui.setStatus(statusKey, undefined);
  });

  const supportsPrefill = typeof pi.registerEntryRenderer === 'function' && typeof pi.appendEntry === 'function';
  if (supportsPrefill) installPrefill(pi, {
    clock,
    enabled: () => enabled,
    makeComponent: options.makePPComponent,
    countPrompt: (model, blocks) => {
      if (!config) readConfig();
      const selected = selection(model);
      if (!selected.spec) return undefined;
      if (!client || client.closed) client = makeClient();
      return client.count(selected.spec, blocks);
    },
  });

  pi.registerCommand('token-speed', {
    description: 'Show tokenizer details, or on/off/reload',
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === 'off') { enabled = false; ctx.ui.setStatus(statusKey, undefined); return; }
      if (action === 'on') { enabled = true; render(); return; }
      if (action === 'reload') { readConfig(); reset(ctx); warm(ctx.model); }
      if (!config) readConfig();
      const selected = selection(ctx.model);
      ctx.ui.notify([
        `Token speed: ${selected.key}`,
        current?.error ?? selected.error ?? `${selected.spec.type}: ${selected.spec.repo ?? selected.spec.encoding}`,
        configError ?? `Config: ${options.configPath ?? configPath}`,
        'Counts received text, thinking, and tool arguments with local tokenizers. No chunk or character estimates.',
        'Rates exclude the first received batch; final provider totals may include hidden/control tokens.',
        supportsPrefill ? 'Input timing appears below each processed input: tool wall time, then model TTFT. PP tok/s requires server prefill timing.'
          : 'PP unavailable: this Pi version lacks custom entry renderers. Tested with Pi 0.87.1.',
      ].join('\n'), current?.error || selected.error || configError ? 'warning' : 'info');
    },
  });
}
