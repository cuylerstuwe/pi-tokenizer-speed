# Changelog

## 1.2.0 — 2026-10-25

- Reconcile timing improvements shared by the macOS and Linux installations with the published external configuration, validation, download helper, and compatibility guards.
- Display tool execution wall time independently from model TTFT, counting parallel tool intervals once and excluding gaps.
- Remove misleading prompt-token/TTFT throughput estimates. PP rates require server timing; unavailable measurements keep explicit token/cache labels.
- Preserve active, wall, phase, and compute timing scopes. Normalize MTPLX compute rates using newly processed tokens and reject incomplete or zero-work measurements.
- Extend regressions for tool failures, nesting, session resets, late metadata, cache accounting, and restored timing entries. Configuration paths, model mappings, and tokenizer files remain external.

## 1.1.0

- Initial portable publication with model-specific tokenizer throughput, per-request timing, external configuration, verified tokenizer downloads, and reload regression coverage.
