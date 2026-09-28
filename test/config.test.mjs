import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { configLocation, loadConfig, selectTokenizer } from '../config.ts';

test('config location respects Pi agent directory and explicit override', () => {
  assert.equal(configLocation('/container/pi', {}), '/container/pi/tokenizer-speed.json');
  assert.equal(configLocation(undefined, { PI_CODING_AGENT_DIR: '/container/agent' }), '/container/agent/tokenizer-speed.json');
  assert.equal(configLocation('/ignored', { PI_TOKENIZER_SPEED_CONFIG: '/custom/tokens.json' }), '/custom/tokens.json');
});

test('missing, malformed and invalid config remain safe', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pi-token-config-'));
  const file = resolve(dir, 'config.json');
  try {
    assert.deepEqual(loadConfig(file), { config: { models: {} }, error: undefined });
    for (const value of ['{', 'null', '{"models":[]}', '{"models":{},"windowMs":0}', '{"models":{},"updateIntervalMs":"250"}']) {
      writeFileSync(file, value);
      assert.deepEqual(loadConfig(file).config.models, {});
      assert.ok(loadConfig(file).error);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exact model mappings, name guards and relative files do not assume any home config', () => {
  const model = { provider: 'example', id: 'family/model', name: 'Family current' };
  const config = { models: { 'example/family/model': { type: 'huggingface', file: 'tokenizers/model.json', nameIncludes: 'Family' } } };
  assert.equal(selectTokenizer(config, model, '/config/tokens.json').spec.file, '/config/tokenizers/model.json');
  assert.ok(selectTokenizer(config, { ...model, id: 'new-model' }, '/config/tokens.json').error);
  assert.ok(selectTokenizer(config, { ...model, provider: 'new-provider' }, '/config/tokens.json').error);
  assert.ok(selectTokenizer(config, { ...model, name: 'Different' }, '/config/tokens.json').error);
  assert.ok(selectTokenizer(config, { ...model, name: undefined }, '/config/tokens.json').error);
  for (const entry of [null, [], 42, { type: 'huggingface' }, { type: 'huggingface', file: 'x', sha256: 'bad' },
    { type: 'tiktoken' }, { type: 'tiktoken', encoding: 'o200k_base', nameIncludes: 1 }, { type: 'unknown' }]) {
    assert.ok(selectTokenizer({ models: { 'example/family/model': entry } }, model, '/config/tokens.json').error);
  }
});
