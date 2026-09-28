# Pi tokenizer speed

A Pi extension that counts received output with an explicitly configured tokenizer and displays live tokens/second. Multi-token stream chunks are handled correctly: the accumulated text is tokenized, rather than counting emissions.

It also places a prompt-processing (PP) line **after the processed input or tool results and before the corresponding assistant response**. The line updates in place when server timing arrives.

## Install

```sh
pi install git:github.com/cuylerstuwe/pi-tokenizer-speed@v1.1.0
```

Then run `/reload` or restart Pi. Tested with Pi 0.87.1 and Node 26.7.0 on Linux x64. Node 22.19+ is required. The `tokenizers` dependency contains native code; installation must succeed on the destination container's platform. Pi supplies its own SDK and TUI dependencies.

The package has no built-in model mappings, server addresses, credentials, or model downloads. It is distributed through Git; `private: true` in package.json prevents accidental npm publication and does not describe this repository's visibility.

## Configure model tokenizers

Create `tokenizer-speed.json` in Pi's agent directory (normally `~/.pi/agent`; respects `PI_CODING_AGENT_DIR`). Alternatively set `PI_TOKENIZER_SPEED_CONFIG` to an absolute configuration path before starting Pi. Start with `config.example.json` and add mappings under `models`, keyed by the **exact `provider/model-id`** reported by Pi.

A Hugging Face mapping looks like this; replace the placeholder values with verified values for the deployed model:

```json
{
  "windowMs": 3000,
  "updateIntervalMs": 250,
  "models": {
    "example-provider/model-a": {
      "type": "huggingface",
      "file": "tokenizers/model-a/tokenizer.json",
      "repo": "publisher/model-repository",
      "revision": "REPLACE_WITH_40_CHARACTER_COMMIT_SHA",
      "sha256": "REPLACE_WITH_64_CHARACTER_SHA256",
      "nameIncludes": "Expected model family"
    }
  }
}
```

`file` is relative to **the configuration file's directory**, not the extension installation. Absolute paths and `~/` paths also work. `repo` and `revision` describe provenance; runtime tokenization only needs a local file. Runtime checksum verification is optional but recommended. The optional `nameIncludes` guard rejects changed or missing display names. If a server silently changes the weights behind an unchanged alias, verify and update the mapping yourself.

For an explicit, verified tiktoken mapping, use an entry such as `{"type":"tiktoken","encoding":"o200k_base"}`. This is an encoding example, not an assertion that it matches your model. Do not select an encoding merely because the API is OpenAI-compatible. To document a known unsupported model, use `{"type":"unavailable","reason":"No verified tokenizer published"}`.

Missing configuration, unknown models, invalid mappings, missing files and tokenizer errors show an unavailable state instead of guessing a tokenizer or breaking inference. `/token-speed` explains the current selection or error; `/token-speed reload` rereads the configuration. `/token-speed off` hides the live meter and stops adding new PP lines; `/token-speed on` enables them again. Previously saved PP entries remain in the transcript.

## Obtain tokenizer files

You can use a local `tokenizer.json` from the exact deployed checkpoint. Do not commit model artifacts or personal configuration here.

For public publisher files, the repository includes an **explicit setup helper**, never run automatically by Pi:

```sh
git clone https://github.com/cuylerstuwe/pi-tokenizer-speed.git
cd pi-tokenizer-speed
git checkout v1.1.0
node scripts/download-tokenizers.mjs /absolute/path/to/tokenizer-speed.json example-provider/model-a
```

Omit the model key to process all Hugging Face entries. The helper requires an immutable 40-character repository revision and SHA-256, downloads only `tokenizer.json`, verifies it before replacing a file, and reuses matching local files. An optional `bytes` field verifies the download size. For gated models, obtain the file using your own authorized tooling and point the configuration at it. Observe the publisher's terms. No weights or authentication credentials are bundled.

## What the measurements mean

- **Decode tok/s:** local tokenization of received text, exposed thinking, tool names and argument JSON. Counts each accumulated content block in full so changing token boundaries and multi-token chunks do not create an emission-count estimate. Hidden tokens, control tokens, and server chat templates are not reconstructed; the server's final output total is shown separately.
- **Timing:** a rolling window while streaming and an average at completion. The first received batch is included in token totals but excluded from the rate numerator, since its individual token arrival times are unknown. A single batch has no measurable decode rate. Network buffering can affect the measured arrival rate.
- **PP server:** prefers provider `timings.prompt_n`, `prompt_ms`, `prompt_per_second`, or supported usage timing fields. The provider defines the timing scope. Some servers report it only at completion; the existing PP line then updates in its original position.
- **PP TTFT estimate:** when native timing is absent, divides input tokens by time to first received output. This includes queueing, network time and initial generation, so it is explicitly approximate. Known cache reads are subtracted; unknown cache status is labeled. If server input usage is unavailable, exposed prompt text and tool schemas are tokenized locally; templates, images and hidden context are excluded and the line says `prompt-text tok`.
- **Placement:** one PP line per provider request. If several tool results are consumed together, one line follows that group. It measures the request's prompt, not just the last visible message, and is separate from the tool's execution duration. Input that never causes an inference request has no PP measurement.

Custom entries persist numeric timing/count data and model/provider identifiers in the local Pi session. They add no messages to the model's context. The extension does not log prompts, send telemetry, or make network calls at runtime; the explicit download helper contacts Hugging Face. Prompt/output text is held temporarily in process memory for tokenization.

PP requires Pi's `before_provider_request`, streaming events and custom-entry rendering APIs. Missing custom-entry methods disable PP while preserving the output meter. Full behavior is tested on Pi 0.87.1; this is not a claim of compatibility with every older release. No picker customization or particular provider configuration is required.

## Development and verification

```sh
npm ci
npm test
```

Default tests use a tiny synthetic tokenizer and tiktoken without network access. Tests cover chunk partitioning, Unicode, tool arguments, PP placement and persistence, unsupported models, missing configuration, config paths, checksum failures, stale async results, and explicit downloads.

Optional integrations:

```sh
PI_EXTENSION_LOADER=/path/to/pi/packages/coding-agent/dist/core/extensions/loader.js npm test
PI_TOKENIZER_SPEED_TEST_CONFIG=/path/to/verified/tokenizer-speed.json npm test
```

The first enables the real Pi `/reload` loader regression. The second tests all configured Hugging Face tokenizers against direct tokenization. Both variables can be set together. Keep the in-process module graph in `.ts`: Pi's loader refreshes those dependencies on `/reload`; cached native `.mjs` dependencies previously prevented updated PP renderers from loading. The worker deliberately remains `.mjs` and is recreated for each session.

For an existing local installation, migrate its tokenizer mappings and files to the external configuration path, and remove its old extension entry before enabling this package. Do not load both copies. To uninstall, remove the Git package with Pi's package manager; external configuration and tokenizer files are intentionally retained.
