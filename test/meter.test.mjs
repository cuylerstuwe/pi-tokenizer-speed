import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputBlocks, Throughput } from '../meter.ts';

test('multi-token chunks and one-character chunks produce identical text; mutable partials cannot count ahead', () => {
  const text = 'antidisestablishmentarianism こんにちは 🌲\nconst x = 42;';
  for (const chunks of [[text], [...text], [text.slice(0, 9), text.slice(9)]]) {
    const blocks = new OutputBlocks();
    const partial = { content: [{ type: 'text', text }] };
    blocks.update({ type: 'text_start', contentIndex: 0, partial });
    assert.deepEqual(blocks.snapshot(), ['']);
    let prefix = '';
    for (const delta of chunks) {
      prefix += delta;
      blocks.update({ type: 'text_delta', contentIndex: 0, delta, partial });
      assert.deepEqual(blocks.snapshot(), [prefix]);
    }
    blocks.finish(partial.content);
    assert.deepEqual(blocks.snapshot(), [text]);
  }
});

test('thinking and interleaved tools retain raw JSON whitespace; end events do not double count', () => {
  const b = new OutputBlocks();
  b.update({ type: 'thinking_delta', contentIndex: 0, delta: 'Think carefully.' });
  b.update({ type: 'toolcall_start', contentIndex: 1, partial: { content: [null, { type: 'toolCall', name: 'read', arguments: { path: 'a' } }] } });
  b.update({ type: 'toolcall_delta', contentIndex: 1, delta: '{ "path": ' });
  b.update({ type: 'text_delta', contentIndex: 2, delta: 'Reading.' });
  b.update({ type: 'toolcall_delta', contentIndex: 1, delta: '"a" }' });
  b.finish([{ type: 'thinking', thinking: 'Think carefully.' }, { type: 'toolCall', name: 'read', arguments: { path: 'a' } }, { type: 'text', text: 'Reading.' }]);
  assert.deepEqual(b.snapshot(), ['Think carefully.', 'read', '{ "path": "a" }', 'Reading.']);
});

test('first multi-token batch is excluded from rates but counted in total; stalls decay to zero', () => {
  const m = new Throughput(3000);
  m.add(1000, 40);
  assert.equal(m.rates(1000).average, undefined);
  m.add(2000, 60);
  assert.equal(m.latest.count, 60);
  assert.equal(m.rates(2000).average, 20);
  assert.equal(m.rates(2000).rolling, 20);
  assert.equal(m.rates(6000).rolling, 0);
  assert.equal(m.rates(6000).average, 4);
});

test('retokenization can reduce total; no permanent positive-delta overcount', () => {
  const m = new Throughput();
  m.add(0, 2);
  m.add(1000, 1);
  m.add(2000, 5);
  assert.equal(m.latest.count, 5);
  assert.equal(m.rates(2000).average, 1.5);
});

test('one batch has no measurable decode rate, even after a completion delay', () => {
  const m = new Throughput();
  m.add(0, 800);
  assert.equal(m.rates(3000).average, undefined);
});
