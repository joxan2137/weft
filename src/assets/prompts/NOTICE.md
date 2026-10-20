# Vendored opencode v1.19.1 prompt texts

These files are copied verbatim from opencode (github.com/anomalyco/opencode), tag `v1.19.1`,
commit `4a929747483f9e19b05c7cf944fc0aca6e5111b0`. They were exported with `git cat-file blob` /
`git show` (not from the CRLF working tree), so every file is LF-only and byte-identical to the
release. For the top-level and `commands/` files, `git hash-object --no-filters <file>` equals the
blob hash in the table.

`inline/` holds texts that v1.19.1 keeps as TypeScript string constants, not `.txt` files. They were
extracted from the template literal or string literal unchanged (none contains escapes or `${}`).

## Files from `.txt` sources

Status compares with tag `v1.3.13` (commit `6314f09c14fdd6a3ab8bedc4f7b7182647551d12`).

| File | Source path in v1.19.1 | Bytes | Blob | vs 1.3.13 |
|---|---|---|---|---|
| `anthropic.txt` | `packages/opencode/src/session/prompt/anthropic.txt` | 8212 | `21d9c0e9f2` | same |
| `beast.txt` | `packages/opencode/src/session/prompt/beast.txt` | 11080 | `e92e4d020f` | same |
| `build-switch.txt` | `packages/opencode/src/session/prompt/build-switch.txt` | 233 | `3737b74d89` | same |
| `codex.txt` | `packages/opencode/src/session/prompt/codex.txt` | 7390 | `d595cadb0e` | same |
| `default.txt` | `packages/opencode/src/session/prompt/default.txt` | 8528 | `c8d904665e` | changed (2 examples removed) |
| `gemini.txt` | `packages/opencode/src/session/prompt/gemini.txt` | 15372 | `87fe422bc7` | same |
| `gpt-astra.txt` | `packages/opencode/src/session/prompt/gpt-astra.txt` | 4078 | `1dba79282a` | new |
| `gpt.txt` | `packages/opencode/src/session/prompt/gpt.txt` | 9284 | `9068df4778` | same |
| `kimi.txt` | `packages/opencode/src/session/prompt/kimi.txt` | 8695 | `beff6755f9` | changed ("# Skills" section removed) |
| `meta.txt` | `packages/opencode/src/session/prompt/meta.txt` | 9159 | `d5aa008c03` | new (contains `{{MODEL_NAME}}`) |
| `plan-mode.txt` | `packages/opencode/src/session/prompt/plan-mode.txt` | 4547 | `2057f36d7d` | new (contains `${planInfo}`) |
| `plan.txt` | `packages/opencode/src/session/prompt/plan.txt` | 1484 | `1806e0eba6` | same |
| `trinity.txt` | `packages/opencode/src/session/prompt/trinity.txt` | 7748 | `28ee4c4f26` | same |
| `compaction.txt` | `packages/opencode/src/agent/prompt/compaction.txt` | 630 | `1bf58de8a9` | changed (rewritten, new first line) |
| `explore.txt` | `packages/opencode/src/agent/prompt/explore.txt` | 871 | `5761077cbd` | same |
| `summary.txt` | `packages/opencode/src/agent/prompt/summary.txt` | 648 | `1cb2aedbd7` | same |
| `title.txt` | `packages/opencode/src/agent/prompt/title.txt` | 2120 | `62960b2c47` | same |
| `generate.txt` | `packages/opencode/src/agent/generate.txt` | 4994 | `774277b0fa` | same |
| `commands/opencode-initialize.txt` | `packages/opencode/src/command/template/initialize.txt` | 3492 | `90751e3d6f` | changed |
| `commands/opencode-review.txt` | `packages/opencode/src/command/template/review.txt` | 4707 | `43c6738577` | changed |
| `commands/core-initialize.txt` | `packages/core/src/plugin/command/initialize.txt` | 3420 | `5fc073d61c` | new (v2 core) |
| `commands/core-review.txt` | `packages/core/src/plugin/command/review.txt` | 4550 | `071807ec87` | new (v2 core) |

Removed in v1.19.1: `packages/opencode/src/session/prompt/max-steps.txt`. Its text moved, unchanged,
into a TypeScript constant (`inline/max-steps.txt`, byte-identical to the 1.3.13 file).

## Inline constants (`inline/`)

| File | Source | Bytes | Note |
|---|---|---|---|
| `max-steps.txt` | `packages/core/src/session/runner/max-steps.ts:1` (`MAX_STEPS_PROMPT`) | 750 | same bytes as 1.3.13 `max-steps.txt` |
| `structured-output-system.txt` | `packages/opencode/src/session/prompt.ts:82` (`STRUCTURED_OUTPUT_SYSTEM_PROMPT`) | 248 | system part for `format: json_schema` |
| `structured-output-tool-description.txt` | `packages/opencode/src/session/prompt.ts:74` (`STRUCTURED_OUTPUT_DESCRIPTION`) | 379 | `StructuredOutput` tool description |
| `compaction-summary-template.txt` | `packages/core/src/session/compaction.ts:16` (`SUMMARY_TEMPLATE`) | 1107 | user-message template of the compaction call (v1 and v2) |
| `compaction-update-instructions.txt` | `packages/core/src/session/compaction.ts:48` (`SUMMARY_UPDATE_INSTRUCTIONS`) | 952 | used when a prior summary exists |
| `v2-build-system.txt` | `packages/core/src/plugin/agent.ts:12` (`BUILD_SYSTEM`) | 190 | v2 `/api` runner only |
| `v2-explore.txt` | `packages/core/src/plugin/agent.ts:15` (`PROMPT_EXPLORE`) | 787 | v2 copy; differs from `explore.txt` |
| `v2-compaction.txt` | `packages/core/src/plugin/agent.ts:33` (`PROMPT_COMPACTION`) | 629 | = `compaction.txt` without the final newline |
| `v2-title.txt` | `packages/core/src/plugin/agent.ts:39` (`PROMPT_TITLE`) | 2119 | ASCII arrows; differs from `title.txt` |
| `v2-summary.txt` | `packages/core/src/plugin/agent.ts:84` (`PROMPT_SUMMARY`) | 647 | = `summary.txt` without the final newline |

## Upstream sources

opencode distributes these texts under its MIT license. Some of them were adapted, by opencode, from
other projects' prompts:

- `gemini.txt` from the system prompt of Gemini CLI (https://github.com/google-gemini/gemini-cli),
  Copyright 2025 Google LLC, Apache License 2.0. opencode changed the agent name and tool references.
- `codex.txt` from the GPT-5-Codex prompt of Codex CLI (https://github.com/openai/codex), Copyright
  2025 OpenAI, Apache License 2.0. opencode changed the agent name and tool references.
- `beast.txt` from Burke Holland's "Beast Mode" prompt.

Weft ships them unchanged from opencode v1.19.1. The Apache License 2.0 text is in
`licenses/THIRD_PARTY_NOTICES.txt`.

## License

The texts are part of opencode and are distributed under its MIT license, reproduced verbatim
from `LICENSE` at tag `v1.19.1`:

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
