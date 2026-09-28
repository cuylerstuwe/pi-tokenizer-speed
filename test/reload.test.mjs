import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Pi reload replaces an already-loaded native module and refreshes edited TS dependencies', { skip: !process.env.PI_EXTENSION_LOADER }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = mkdtempSync(resolve(root, 'test/reload-fixture-'));
  const loaderPath = process.env.PI_EXTENSION_LOADER;
  const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(loaderPath).href);
  const load = async () => {
    clearExtensionCache();
    const result = await loadExtensions([resolve(fixture, 'index.ts')], fixture);
    assert.deepEqual(result.errors, []);
    return result.extensions[0];
  };
  try {
    // Simulate the original version already cached in a running Pi process.
    writeFileSync(resolve(fixture, 'extension.mjs'), "export default pi => pi.registerCommand('old-version', {description:'old',handler:async()=>{}});\n");
    writeFileSync(resolve(fixture, 'index.ts'), "import install from './extension.mjs'; export default install;\n");
    const old = await load();
    assert.ok(old.commands.has('old-version'));
    assert.ok(!old.entryRenderers.has('tokenizer-speed-pp'));

    // Upgrade to the real extension without restarting Node or changing paths.
    for (const file of ['index.ts', 'extension.ts', 'prefill.ts', 'meter.ts', 'client.ts', 'config.ts']) {
      copyFileSync(resolve(root, file), resolve(fixture, file));
    }
    const updated = await load();
    assert.ok(updated.commands.has('token-speed'));
    assert.ok(updated.entryRenderers.has('tokenizer-speed-pp'));
    assert.equal(updated.handlers.get('before_provider_request').length, 2);

    // A subsequent edit to a nested dependency must also refresh on /reload.
    const leaf = resolve(fixture, 'prefill.ts');
    writeFileSync(leaf, readFileSync(leaf, 'utf8').replace('PP unavailable · no first output observed', 'PP refreshed · no first output observed'));
    const reloaded = await load();
    const renderer = reloaded.entryRenderers.get('tokenizer-speed-pp');
    const component = renderer({ data: { id: 'test' } }, {}, { fg: (_color, text) => text });
    assert.match(component.render(120).join('\n'), /PP refreshed/);
  } finally {
    clearExtensionCache();
    rmSync(fixture, { recursive: true, force: true });
  }
});
