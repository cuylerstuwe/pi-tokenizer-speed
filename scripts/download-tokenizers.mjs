import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configLocation, loadConfig, selectTokenizer } from '../config.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Downloads are an explicit setup action, never part of extension startup.
export async function downloadTokenizers(file, keys = [], fetcher = fetch) {
  const { config, error } = loadConfig(file);
  if (error) throw new Error(error);
  if (!Object.keys(config.models).length) throw new Error('No tokenizer mappings found in config');
  const selected = keys.length ? keys : Object.keys(config.models).filter((key) => config.models[key]?.type === 'huggingface');
  const results = [];
  for (const key of selected) {
    const entry = config.models[key];
    if (entry?.type !== 'huggingface') throw new Error(`No Hugging Face mapping for ${key}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo ?? '') || !/^[a-f0-9]{40}$/i.test(entry.revision ?? '')
      || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '')) {
      throw new Error(`${key}: require repo, immutable 40-character revision and SHA-256`);
    }
    const slash = key.indexOf('/');
    const { spec, error: invalid } = selectTokenizer(config, {
      provider: key.slice(0, slash), id: key.slice(slash + 1), name: entry.nameIncludes ?? '',
    }, file);
    if (!spec) throw new Error(invalid);
    let existing;
    try { existing = readFileSync(spec.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && hash(existing) === spec.sha256) {
      results.push({ key, status: 'verified' });
      continue;
    }
    const response = await fetcher(`https://huggingface.co/${entry.repo}/resolve/${entry.revision}/tokenizer.json`);
    if (!response.ok) throw new Error(`${key}: HTTP ${response.status}; for gated models, obtain an authorized local tokenizer file`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== spec.sha256) throw new Error(`${key}: tokenizer checksum mismatch; existing file preserved`);
    if (entry.bytes !== undefined && bytes.length !== entry.bytes) throw new Error(`${key}: tokenizer size mismatch`);
    JSON.parse(bytes.toString('utf8'));
    mkdirSync(dirname(spec.file), { recursive: true });
    const temp = `${spec.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: 'wx' });
      renameSync(temp, spec.file);
    } finally { rmSync(temp, { force: true }); }
    results.push({ key, status: 'downloaded and verified' });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2] ? resolve(process.argv[2]) : configLocation();
    for (const result of await downloadTokenizers(file, process.argv.slice(3))) console.log(`${result.key}: ${result.status}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
