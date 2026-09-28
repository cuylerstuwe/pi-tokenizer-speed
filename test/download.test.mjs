import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadTokenizers } from '../scripts/download-tokenizers.mjs';

test('explicit download pins source, verifies before writing, and reuses verified files', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pi-token-download-'));
  const file = resolve(dir, 'config.json');
  const bytes = Buffer.from('{"test":"synthetic"}');
  const entry = { type: 'huggingface', repo: 'example/model', revision: 'a'.repeat(40),
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, file: 'tokenizers/test.json' };
  const save = () => writeFileSync(file, JSON.stringify({ models: { 'example/model': entry } }));
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    assert.equal(url, `https://huggingface.co/example/model/resolve/${'a'.repeat(40)}/tokenizer.json`);
    return new Response(bytes);
  };
  try {
    save();
    await assert.rejects(downloadTokenizers(file, [], async () => new Response('wrong')), /checksum/);
    assert.equal(existsSync(resolve(dir, entry.file)), false);
    await downloadTokenizers(file, [], fetcher);
    assert.deepEqual(readFileSync(resolve(dir, entry.file)), bytes);
    assert.equal((await downloadTokenizers(file, [], fetcher))[0].status, 'verified');
    assert.equal(calls, 1);
    entry.revision = 'main'; save();
    await assert.rejects(downloadTokenizers(file, [], fetcher), /immutable/);
    assert.equal(calls, 1);
    await assert.rejects(downloadTokenizers(file, ['unknown/model'], fetcher), /No Hugging Face mapping/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
