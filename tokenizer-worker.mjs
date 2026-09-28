import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Tokenizer } from 'tokenizers';
import { get_encoding } from 'tiktoken';

// The native tokenizer and WASM encoding both stay off Pi's UI/event thread.
const cache = new Map();
function load(spec) {
  const key = JSON.stringify(spec);
  let entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }
  let tokenizer;
  if (spec.type === 'huggingface') {
    const bytes = readFileSync(spec.file);
    if (spec.sha256 && createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
      throw new Error('Tokenizer checksum mismatch');
    }
    tokenizer = Tokenizer.fromString(bytes.toString('utf8'));
    tokenizer.disablePadding();
    tokenizer.disableTruncation();
  } else if (spec.type === 'tiktoken') {
    tokenizer = get_encoding(spec.encoding);
  } else {
    throw new Error('Unsupported tokenizer type');
  }
  entry = { tokenizer, previous: new Map() };
  cache.set(key, entry);
  while (cache.size > 2) {
    const oldest = cache.keys().next().value;
    cache.get(oldest).tokenizer.free?.();
    cache.delete(oldest);
  }
  return entry;
}

let queue = Promise.resolve();
parentPort.on('message', (request) => {
  queue = queue.then(async () => {
    try {
      const entry = load(request.spec);
      let total = 0;
      if (request.blocks) {
        const next = new Map();
        for (let index = 0; index < request.blocks.length; index++) {
          const text = request.blocks[index];
          let count = entry.previous.get(index)?.text === text ? entry.previous.get(index).count : undefined;
          if (count === undefined) {
            count = !text ? 0 : request.spec.type === 'huggingface'
              ? (await entry.tokenizer.encode(text, null, { addSpecialTokens: false })).getLength()
              : entry.tokenizer.encode(text, [], []).length;
          }
          next.set(index, { text, count });
          total += count;
        }
        entry.previous = next;
      }
      parentPort.postMessage({ id: request.id, count: total });
    } catch (error) {
      parentPort.postMessage({ id: request.id, error: String(error.message ?? error) });
    }
  });
});
