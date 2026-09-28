import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const expand = (value) => value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(value);

export function configLocation(agentDir, env = process.env) {
  return env.PI_TOKENIZER_SPEED_CONFIG
    ? expand(env.PI_TOKENIZER_SPEED_CONFIG)
    : resolve(expand(agentDir ?? env.PI_CODING_AGENT_DIR ?? '~/.pi/agent'), 'tokenizer-speed.json');
}

export function loadConfig(file) {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (!record(config) || !record(config.models)) throw new Error('config.models must be an object');
    for (const key of ['windowMs', 'updateIntervalMs']) {
      if (config[key] !== undefined && (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0)) {
        throw new Error(`${key} must be a positive finite number`);
      }
    }
    return { config };
  } catch (error) {
    return { config: { models: {} }, error: error.code === 'ENOENT' ? undefined : error.message };
  }
}

export function selectTokenizer(config, model, file) {
  const key = `${model?.provider}/${model?.id}`;
  const missing = () => ({ key, error: `No verified tokenizer for ${key}` });
  if (!record(config.models) || !Object.hasOwn(config.models, key)) return missing();
  const entry = config.models[key];
  const invalid = () => ({ key, error: `Invalid tokenizer mapping for ${key}` });
  if (!record(entry)) return invalid();
  if (entry.type === 'unavailable') return { key, error: typeof entry.reason === 'string' ? entry.reason : `Tokenizer unavailable for ${key}` };
  if (entry.nameIncludes !== undefined) {
    if (typeof entry.nameIncludes !== 'string') return invalid();
    if (typeof model?.name !== 'string' || !model.name.includes(entry.nameIncludes)) {
      return { key, error: `Model name changed or missing; update tokenizer mapping for ${key}` };
    }
  }
  if (entry.type === 'tiktoken') {
    return typeof entry.encoding === 'string' && entry.encoding ? { key, spec: { ...entry } } : invalid();
  }
  if (entry.type === 'huggingface') {
    if (typeof entry.file !== 'string' || !entry.file) return invalid();
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256))) return invalid();
    return { key, spec: { ...entry, file: entry.file.startsWith('~/') ? expand(entry.file) : resolve(dirname(file), entry.file),
      ...(entry.sha256 ? { sha256: entry.sha256.toLowerCase() } : {}) } };
  }
  return invalid();
}
