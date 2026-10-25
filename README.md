# Pi tokenizer speed

A Pi extension that counts received output with an explicitly configured tokenizer and displays live tokens/second. Multi-token stream chunks are handled correctly: the accumulated text is tokenized, rather than counting emissions.

It also places an input-timing line **after the processed input or tool results and before the corresponding assistant response**. It separates tool execution, model time to first output (TTFT), and server-reported prompt processing (PP). The line updates in place when server timing arrives.

## Install

```sh
pi install git:github.com/cuylerstuwe/pi-tokenizer-speed@v1.2.0
```

Then run `/reload` or restart Pi. Version 1.2.0 passed all 37 tests, including the real Pi loader/reload integration, with Pi 0.87.1 and Node 26.8.1 on Linux x64 and Pi 1.1.0 and Node 24.18.0 on macOS arm64. Node 22.19+ is required. The `tokenizers` dependency contains native code; installation must succeed on the destination container's platform. Pi supplies its own SDK and TUI dependencies.

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
git checkout v1.2.0
node scripts/download-tokenizers.mjs /absolute/path/to/tokenizer-speed.json example-provider/model-a
```

Omit the model key to process all Hugging Face entries. The helper requires an immutable 40-character repository revision and SHA-256, downloads only `tokenizer.json`, verifies it before replacing a file, and reuses matching local files. An optional `bytes` field verifies the download size. For gated models, obtain the file using your own authorized tooling and point the configuration at it. Observe the publisher's terms. No weights or authentication credentials are bundled.

## What the measurements mean

- **Decode tok/s:** local tokenization of received text, exposed thinking, tool names and argument JSON. Counts each accumulated content block in full so changing token boundaries and multi-token chunks do not create an emission-count estimate. Hidden tokens, control tokens, and server chat templates are not reconstructed; the server's final output total is shown separately.
- **Timing:** a rolling window while streaming and an average at completion. The first received batch is included in token totals but excluded from the rate numerator, since its individual token arrival times are unknown. A single batch has no measurable decode rate. Network buffering can affect the measured arrival rate.
- **Tools:** wall time from tool execution start/end events. Parallel and nested tools count elapsed time once; gaps between tools are excluded. Completed tool batches are attached to the following model request. Failed tools still count.
- **Model TTFT:** provider request to first text, thinking, or tool-call output. Tool execution and the gap before the request are excluded. It still includes upload, queueing, cache restoration, prefill, and initial generation; the client cannot isolate GPU computation.
- **PP server:** uses provider `timings.prompt_n`, `prompt_ms`, `prompt_per_second`, or supported usage timing fields. Recognized scopes are labeled `server phase`, `server wall`, `server active`, or `server compute`; their backend-defined boundaries can differ. MTPLX's explicit compute counters and newly processed suffix count take precedence over generic full-prompt rates. Invalid, zero-work, or incomplete MTPLX compute measurements do not fall back to an inflated rate. Some servers report timing only at completion; the existing line then updates in its original position.
- **Missing PP timing:** says `PP unavailable · no server timing`. Version 1.2.0 removes the old prompt-tokens/TTFT estimate: queueing, cached history, and fixed overhead made it misleading. Token counts remain visible with an explicit cache-known/unknown label. If server input usage is unavailable, exposed prompt text and tool schemas are tokenized locally; templates, images, and hidden context are excluded. A prompt duration alone needs a known uncached count before it can produce a rate.
- **Placement:** one line per provider request. If several tool results are consumed together, one line follows that group. It describes the whole request and preceding tool batch. Input that never causes an inference request has no measurement.

For example:

```text
Tools 0.20s wall · Model TTFT 0.82s · PP 1,200 tok/s · server · 60 processed tok · 0.05s prefill
Tools 0.20s wall · Model TTFT 2.42s · PP unavailable · no server timing · 225 uncached tok
```

Custom entries persist numeric timing/count data and model/provider identifiers in the local Pi session. They add no messages to the model's context. The extension does not log prompts, send telemetry, or make network calls at runtime; the explicit download helper contacts Hugging Face. Prompt/output text is held temporarily in process memory for tokenization.

Input timing requires Pi's `before_provider_request`, streaming events, tool execution events, and custom-entry rendering APIs. Missing custom-entry methods disable input lines while preserving the output meter. No picker customization or particular provider configuration is required.

## Development and verification

```sh
npm ci --ignore-scripts
npm test
```

Default tests use a tiny synthetic tokenizer and tiktoken without network access. Tests cover chunk partitioning, Unicode, tool arguments, input-line placement and persistence, tool wall-time unions, separate TTFT, late/cache-aware server timing, unavailable PP, unsupported models, missing configuration, config paths, checksum failures, stale async results, and explicit downloads.

Optional integrations:

```sh
PI_EXTENSION_LOADER=/path/to/pi/packages/coding-agent/dist/core/extensions/loader.js npm test
PI_TOKENIZER_SPEED_TEST_CONFIG=/path/to/verified/tokenizer-speed.json npm test
```

The first enables the real Pi `/reload` loader regression. The second tests all configured Hugging Face tokenizers against direct tokenization. Both variables can be set together. Keep the in-process module graph in `.ts`: Pi's loader refreshes those dependencies on `/reload`; cached native `.mjs` dependencies previously prevented updated PP renderers from loading. The worker deliberately remains `.mjs` and is recreated for each session.

For an existing local installation, migrate its tokenizer mappings and files to the external configuration path, and remove its old extension entry before enabling this package. Do not load both copies. To uninstall, remove the Git package with Pi's package manager; external configuration and tokenizer files are intentionally retained.
