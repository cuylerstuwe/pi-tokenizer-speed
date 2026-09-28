import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from 'tokenizers';
import { get_encoding } from 'tiktoken';
import { TokenizerClient } from '../client.ts';
import { OutputBlocks } from '../meter.ts';

const external = process.env.PI_TOKENIZER_SPEED_TEST_CONFIG;
const configFile = external ?? fileURLToPath(new URL('./fixtures/tokenizers.json', import.meta.url));
const config = external ? JSON.parse(readFileSync(configFile, 'utf8')) : { models: {
  'example/model': { type: 'huggingface', file: 'tokenizer.json' },
} };
const specFor = (entry) => ({ ...entry, file: resolve(dirname(configFile), entry.file) });
const text = 'Hello world. こんにちは 🌲';

test('model tokenizers and the worker agree across chunk partitions, Unicode, and long output', async () => {
  const client = new TokenizerClient();
  try {
    for (const [model, entry] of Object.entries(config.models).filter(([, e]) => e.type === 'huggingface')) {
      const spec = specFor(entry);
      const direct = Tokenizer.fromFile(spec.file);
      direct.disablePadding(); direct.disableTruncation();
      assert.equal(await client.count(spec, [text]), (await direct.encode(text, null, { addSpecialTokens: false })).getLength(), model);
      const sentence = 'antidisestablishmentarianism こんにちは 🌲\nconst answer = 42;';
      const expected = (await direct.encode(sentence, null, { addSpecialTokens: false })).getLength();
      for (const width of [1, 7, sentence.length]) {
        const blocks = new OutputBlocks();
        for (let i = 0; i < sentence.length; i += width) {
          blocks.update({ type: 'text_delta', contentIndex: 0, delta: sentence.slice(i, i + width) });
        }
        assert.equal(await client.count(spec, blocks.snapshot()), expected, `${model}: chunks ${width}`);
      }
      const long = sentence.repeat(200);
      assert.equal(await client.count(spec, [long]), (await direct.encode(long, null, { addSpecialTokens: false })).getLength());
      assert.equal(await client.count(spec, ['', '']), 0);
    }
  } finally { client.close(); }
});

test('tiktoken counts literal special-looking text without throwing and uses the documented encoding', async () => {
  const client = new TokenizerClient();
  const direct = get_encoding('o200k_base');
  try {
    const value = text + ' <|endoftext|>';
    assert.equal(await client.count({ type: 'tiktoken', encoding: 'o200k_base' }, [value]), direct.encode(value, [], []).length);
  } finally { direct.free(); client.close(); }
});

test('missing tokenizer and corrupt checksum fail explicitly, and shutdown rejects pending work', async () => {
  const client = new TokenizerClient();
  const entry = Object.values(config.models).find((entry) => entry.type === 'huggingface');
  const spec = specFor(entry);
  await assert.rejects(client.count({ ...spec, file: '/nonexistent/tokenizer.json' }, ['x']), /ENOENT/);
  await assert.rejects(client.count({ ...spec, sha256: 'bad' }, ['x']), /checksum/);
  const task = client.count(spec, ['x']);
  client.close();
  await assert.rejects(task, /stopped/);
  await assert.rejects(client.count(spec, ['x']), /stopped/);
});
