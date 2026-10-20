# Weft — design contract

Weft is a liberated desktop client for the open-source opencode agent (MIT). It runs the official
opencode engine and gives the user full authorship of the conversation: any message can be
rewritten, re-voiced (role changed) or removed, and the system prompt is the first message of the
conversation, editable like any other.

Weft is not built by, endorsed by, or affiliated with the OpenCode team. It ships opencode's
prompt texts under the MIT license (see `src/assets/prompts/NOTICE.md`).

This file is the contract. Part A is the visual language, Part B the architecture. Code that
disagrees with this file is wrong, or this file must be updated first.

---

## Part A — Visual language: Flow

### A.1 The idea

Vibecoding is not typing commands. You describe what you want, in your own words, and stay in
flow while the model turns intent into code. Weft draws that as **ink in water**.

Your words drop into the water like ink. The model's answer spreads out of them. Everything in a
session comes from one **source**, the system prompt, at the top of the current. Water never
holds a shape for good, and neither does a conversation in Weft: you can reach in and stir any
message, change its colour (who said it), let it settle out of the current (muted), or let it
dissolve (deleted).

| Water | Weft |
|---|---|
| the source | the system prompt, the first message, editable |
| an ink drop | a message; its colour is who wrote it |
| stirring the water | editing a message |
| changing the ink | changing a message's role |
| settling to the bottom | muting: kept, never sent |
| dissolving | deleting |
| the current | streaming |
| a lock that holds the water | a permission request |
| a marbled print | a session's thumbnail: inks from its own messages, floated and combed |
| the vessel's level | how full the context window is |
| a fork in the river | forking a session |

The metaphor lives in colour, motion and the living water behind the text. Words stay plain:
buttons say Edit, Save, Fork, Delete, Allow once.

Nothing looks like a terminal: proportional type, no monospace outside code, no box-drawing, no
bracketed buttons, no blinking block cursors.

### A.2 Type

| Voice | Face | Use |
|---|---|---|
| You | Fraunces (soft, variable), 17 px / 1.6 | your messages, the composer |
| The model | Geist, 15 px / 1.7 | assistant text, interface |
| The source | Fraunces italic for titles; Geist for the long prompt text | system prompt |
| Code | Geist Mono, 13 px | code blocks, tool output, paths |

All three are SIL OFL 1.1 and bundled.

### A.3 Colour: paper and ink

Light by default. `src/theme/tokens.css` defines every colour; components use tokens only.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f2efe7` | the water, the window |
| `--paper-2` | `#f9f7f2` | raised paper: cards, composer, menus |
| `--paper-3` | `#e9e5da` | wells, hover, code |
| `--ink` | `#1c2027` | text (15:1) |
| `--ink-2` | `#41464f` | secondary text |
| `--ink-3` | `#676c74` | tertiary text (5:1) |
| `--ink-4` | `#a3a5a8` | decoration only |

| Ink | text | bright (water) | wash | Who |
|---|---|---|---|---|
| vermilion | `#b8382a` | `#e0533a` | `#f4ddd5` | you |
| indigo | `#2c4a92` | `#3d63c4` | `#dfe5f3` | the model |
| ochre | `#8a5f10` | `#c9922a` | `#f2e7cd` | the source (system) |
| teal | `#1b6e61` | `#2a9a87` | `#d7ebe5` | tools |
| carmine | `#a3233b` | `#d03a55` | `#f3dade` | delete, errors |

Each role exposes `--ink-role`, `--ink-role-bright`, `--ink-role-wash` and `--voice` on
`[data-role]`.

### A.4 Layout

No hard panes. The water fills the window; paper floats on it.

- Top: a quiet strip on the water with the mark (`weft` in Fraunces italic), the session title,
  and a few round controls. It is the window's drag region.
- Left: sessions as marbled prints (round thumbnails) with their titles.
- Centre: one reading column (max 720 px). Messages carry no boxes: a coloured drop, a small
  role name, the text in its voice.
- Bottom: the inkwell, a floating paper card where you write, with the vessel (context gauge),
  the speed of the reply (tokens a second, indigo while it streams), the model and agent, attach
  and send.
- Right: "currents" (tokens, cost, plan, changed files, engine) as a drawer, closed by default.

### A.5 Signature elements

1. **The water.** A real fluid simulation (WebGL2, low resolution) behind everything, rendered as
   subtractive ink on paper so inks mix like real pigment. Ink enters on events: a drop when you
   send, a slow current beside a streaming reply, a stir where you save an edit, a new colour
   when you change a role. The text column sits on a pale veil so the water never hurts reading.
   The simulation stops when nothing moves, and whenever the window is hidden or unfocused.
2. **Ink settling.** Streamed words arrive soft (a slight blur and the role's colour) and settle
   into sharp text.
3. **Marbled prints.** Each session's thumbnail is a marbling (ebru) made with the real drop and
   comb transforms: one drop per message in its role's ink, sized by its length, then combed.
4. **The source.** The system prompt sits at the top as the source card, with its
   `{{placeholders}}` shown as small ochre pills.
5. **Lifting a message.** Double-click: the message rises onto paper as an editor; three ink pots
   choose who said it; saving lets it back into the water with a stir.
6. **Settled messages.** Muted messages sink: faded, slightly lowered, marked "settled — not
   sent".
7. **The vessel.** The context gauge is a small glass whose water level is the share of the
   context window in use, tinted by who used it.
8. **The lock.** A permission request holds the flow: "opencode wants to run …" with Allow once,
   Always, Reject.
9. **The first drop.** On a cold start a single drop blooms in the water while the engine starts.

### A.6 Motion

Fluid, never stepped: `cubic-bezier(.22,.8,.2,1)`, 300 ms for interface, 600 ms for settling ink.
Everything stops under `prefers-reduced-motion` (the water renders one still frame).

### A.7 Words

Plain words for actions and errors. Water words only in quiet labels: "source", "settled",
"currents".

### A.8 Night

Day is pigment on paper; night is light in dark water. The same simulation and the same density
field render as each other's dual:

| | Day | Night |
|---|---|---|
| ground | paper `#f2efe7` | an inkstone's wet well `#101215` |
| ink in water | multiplies: `paper · e^(−d)` | screens: `1 − (1 − ground) · e^(−d)` |
| overlapping inks | darken, like pigment | brighten, like light |
| text | dark ink | warm ivory `#ece7dc`, a little thinner (Fraunces 360, Geist 370) |
| role inks | deep for text, bright for drops | pale for text, luminous for drops and glows |

- The theme follows the system unless chosen in Settings → Appearance or with the moon/sun in
  the sessions footer. `data-theme` on `<html>` carries it; `public/theme-boot.js` sets it before
  the first paint. A change crossfades with a view transition.
- Ink in the water means different colours by day and by night, so a change empties the water
  and the open session pours its inks again (A.5.1).
- Every colour is a token in `src/theme/tokens.css`; components never hard-code one. Translucent
  hovers use `--tint-1`/`--tint-2`, raised edges `--highlight`, solid fills under white text
  `--indigo-solid`, code colours `--syn-*` (so cached highlights follow the theme).
- Night may glow where day casts a shadow: drops, pots, the caret, the mark and settling words
  carry a soft halo of their role's bright ink (at most 45% opacity), never a hard neon edge.
  Pure black and pure white never appear.
- Marbled prints are rendered per theme: luminous inks on dark paper at night.

---

## Part B — Architecture

Every rule here was checked against opencode 1.19.1.

### B.1 Processes

```
Weft.exe (Tauri 2, Rust)                         opencode.exe serve (the engine, Bun)
 ├─ engine manager ── spawns, job-object ─────────► 127.0.0.1:<port>, Basic auth weft:<uuid>
 │   version = installed OpenCode Desktop's          OPENCODE_CONFIG_CONTENT = {plugin:[file:///…/
 │   official npm binary, sha512-verified              weft-liberated.ts, file:///…/weft-workflow.ts],
 │                                                     permission:{weft_canary:deny}}
 │   migration guard against the shared DB          shares ~/.local/share/opencode with Desktop
 └─ WebView2 (SolidJS) ── fetch + SSE ────────────► legacy HTTP API + GET /global/event
```

- The engine version always equals the installed OpenCode Desktop version (shared SQLite DB,
  forward-only migrations). No Desktop: user-chosen binary, else npm `latest`.
- The webview talks to the engine directly with `fetch` (CORS allows `http://tauri.localhost`).
  Credentials come from the `engine_status` command / `engine://state` event. In a plain browser
  (development) they come from `VITE_ENGINE_URL/USER/PASSWORD` written by `npm run engine:dev`.
- The plugin is loaded through `OPENCODE_CONFIG_CONTENT`, never an app-owned `OPENCODE_CONFIG_DIR`
  (that would drop the user's `~/.config/opencode/AGENTS.md` from the default prompt).
- When Desktop updates itself, the engine manager installs the matching engine and restarts it.
- Only legacy routes run model turns (`/session/:id/prompt_async`, `/message`, `/command`, `/shell`).
  The v2 runner (`/api/session/*/prompt`) fires no plugin hooks and must never be used.

### B.2 Frontend modules

```
src/engine/
  connection.ts   engine credentials + state signal (Tauri or env), Basic auth header
  api.ts          typed client over the legacy routes
  events.ts       one SSE loop on GET /global/event (B.3)
  store.ts        server-level store: sessions, messages, parts, status, permissions, questions,
                  todos; per-directory lists; providers, agents, commands, config, mcp, lsp, vcs
  liberate.ts     metadata.weft schema, the cloth derivation (PickView[]) and every edit operation
  actions.ts      everything the UI can do, as one object (B.4)
  view.ts         PickView / LoomView types (exists; extend, do not break)
  speed.ts        tokens a second of a reply (B.8)
  workflow.ts     the `metadata.workflow` run a workflow tool part carries (B.8)
src/ui/           components (exist: Titlebar, SwatchBook, Cloth, Pick, Fell, Knot, DraftPanel,
                  EmptyLoom, Speed, parts/*); new dialogs live beside them
src/art/          signature visuals (owned by the design; change only to fix bugs)
plugin/weft-liberated.ts   the engine plugin (copied into src-tauri/resources/opencode/plugins)
plugin/weft-workflow.ts    the workflow tool, a plugin of its own beside it (B.8)
```

### B.3 Sync rules

1. One `fetch` SSE stream on `GET /global/event`; frames are
   `{directory, project?, workspace?, payload:{id, type, properties}}`. Skip `payload.type === "sync"`
   for the UI. Watchdog: reconnect after 30 s without a frame (heartbeat every 10 s); reconnect
   delay 250 ms, backing off to 5 s.
2. Batch frames for 16 ms and apply each batch inside one Solid `batch`. Merge consecutive
   `message.part.delta` for the same part and field; never drop deltas. Apply a delta only when the
   part exists.
3. Messages sort by `(time.created, id)`; parts by `id`. Never sort messages by id alone (ids
   wrapped on 2026-08-14).
4. First page 40 messages, older pages 200 via the `before` cursor from `X-Next-Cursor`. Backfill
   missing parent user messages.
5. Another process (Desktop) can write the same DB without events: refetch the open session's
   messages on window focus and every 20 s while idle.
6. After a reconnect: re-bootstrap lists and refetch open sessions.

### B.4 Actions (the UI calls only these)

Session: `open(id)`, `create(directory)`, `rename`, `remove`, `archive`, `share`/`unshare`,
`fork(fromMessageID?)`, `summarize`, `abort`, `revert(messageID)`, `unrevert`, `exportJSON`.
Prompting: `send(text, attachments, mentions)` → `prompt_async` with client-generated ids,
`command(name, args)`, `shell(command)` (`!` prefix in the fell), `continue()` (= `prompt_async`
with `parts: []`), `regenerate(assistantID)`.
Model/agent: `setModel(providerID, modelID, variant?)`, `setAgent(name)`.
Permissions/questions: `replyPermission(id, "once"|"always"|"reject", message?)`,
`answerQuestion(id, answers)`, `rejectQuestion(id)`.
Providers: list (`GET /provider`, `GET /provider/auth`), connect with an API key (`PUT /auth/:id`),
OAuth (`authorize` → show URL / instructions / code input → `callback`), disconnect; dispose after.
Never render the `key` or `options` fields from `GET /provider`.
Project: list projects, open folder (dialog), file search (`/find/file`), vcs status and diff, MCP
list / connect / authenticate, LSP status, terminal (PTY with ticket connect).
Config: only `PATCH /global/config`, after the user confirms. Never `PATCH /config` (it writes a dead
`config.json` into the project).
Liberation: B.5.

### B.5 Liberation

State lives in `session.metadata.weft` (PATCH `/session/:id` with the whole `metadata` object,
keeping unknown keys):

```ts
type WeftMeta = {
  v: 1
  system?: { text: string; seed?: string; at?: number } // template, placeholders below
  roles?: Record<string /*messageID*/, "system" | "user" | "assistant">
  order?: Record<string /*messageID*/, number>          // when set, written for every message
  muted?: Record<string, true>                          // kept in the cloth, not sent
  thought?: Record<string /*partID*/, true>             // edited reasoning, sent as text
  mends?: Record<string /*messageID*/, { text: string; role: string; at: number }[]> // last 8
}
```

The engine plugin `plugin/weft-liberated.ts` (every hook wrapped so it can never abort a turn) applies it on every main-loop model call
(`experimental.chat.messages.transform`, `experimental.chat.system.transform`) and records what it
saw in `<app config>/observed/<sessionID>.json` (read with the `observed_system` command). The
plugin never rewrites storage.

The cloth (what the UI shows) is derived, never stored separately:
- **pick 00** is the system prompt. With `weft.system` it shows that template, else the seed:
  `{{prompt}}` replaced by the vendored provider prompt file chosen with opencode's rule for the session's model, followed by the lines
  `{{environment}}`, `{{references}}`, `{{instructions}}`, `{{mcp}}`, `{{skills}}`,
  `{{structured_output}}`, `{{client_system}}`. `{{opencode}}` stands for the whole default.
  Placeholders render as inline chips; hovering one shows the value last observed by the plugin.
- Every stored message becomes a pick with role `roles[id] ?? info.role`, ordered by `order[id]`
  (missing = after all ordered ones, in stored order), then stored order.
- `session.revert` (an Undo in OpenCode): picks from `revert.messageID` on, in stored order, show as
  reverted and leave the context. opencode deletes them before it runs any prompt, so a band above the
  fell says so and offers Unrevert (off when G18 applies); pick actions refuse to prompt from a
  reverted pick, and Insert asks first.

| User does | Weft does |
|---|---|
| edit a text part | `PATCH /session/:id/message/:mid/part/:pid` with the full part; push a mend |
| edit reasoning | PATCH the part; set `thought[partID]` |
| change role | set `roles[mid]`; push a mend |
| edit pick 00 | set `system.text` |
| delete a message / part | `DELETE` message / part (409 while busy: offer Stop first); a user message goes with its replies (`parentID`), unless the user picks Delete message only |
| mute / unmute | toggle `muted[mid]` |
| insert a message after pick N | `POST /session/:id/message {noReply:true, parts:[text]}`, then write `order` for all picks and `roles[new]` |
| move a pick | rewrite `order` |
| save and resend (user pick) | PATCH the edited part (other parts kept), delete every later message, then `continue()` |
| regenerate an assistant pick | delete it and every later message, then `continue()` |
| continue | `prompt_async` with `parts: []` |
| fork from here | `POST /session/:id/fork {messageID}`, then copy `metadata.weft` for ids that survived |

If the canary tool `weft_canary` is missing from `GET /experimental/tool/ids`, the plugin did not
load: show a persistent warning that edits are stored but not applied.

### B.6 Licensing and naming

- Name: Weft. Bundle id `app.weft.desktop`. Never the OpenCode name, logo or `ai.opencode.*` id.
- Weft is MIT: `LICENSE` at the repo root, "Copyright (c) 2026 The Weft authors".
- `licenses/` ships as the bundle resource `licenses/` (beside `weft.exe`), and `LICENSE` as
  `licenses/LICENSE-weft.txt`. Its files:
  - `LICENSE-opencode.txt`: opencode's MIT license, byte-identical to `LICENSE` at tag v1.19.1. It
    covers the vendored prompt texts (`src/assets/prompts`, see `NOTICE.md` there) and
    `@opencode-ai/sdk`, which publishes no licence file.
  - `OFL-Fraunces.txt`, `OFL-Geist.txt`, `OFL-Geist-Mono.txt`: copied byte for byte from
    `node_modules/@fontsource-variable/{fraunces,geist,geist-mono}/LICENSE`. OFL §2 wants the
    copyright and licence with every copy of the fonts, and the subset woff2 files carry neither.
    Geist's holder is The Geist Project Authors, not Vercel.
  - `THIRD_PARTY_NOTICES.txt`, generated by `node tools/notices.mjs`, never edited by hand. npm: the
    production dependencies of `package.json` and everything they pull in (`@types/*` and lock
    entries marked dev left out). Rust: the `src-tauri/Cargo.lock` crates that build for
    `x86_64-pc-windows-msvc` (dev-dependencies and other targets' dependencies dropped; build
    scripts, proc macros and what they use kept and marked "build time"). It reads the LICENSE,
    COPYING, NOTICE and COPYRIGHT files from `node_modules` and `~/.cargo/registry/src`, prints each
    distinct text once under the licence recognised from it with the packages that publish it, lists
    packages without a licence file with their declared licence and authors, and gives the crates.io
    source URL of every MPL-2.0 crate. It exits 1 when a package or crate source is missing.
    Regenerate it after every dependency change.
- The About screen names Weft's own licence and says Weft is not built by or affiliated with the
  OpenCode team. It opens each file in `licenses/` with the opener plugin (`openPath` on
  `resolveResource("licenses/…")`); the capability scopes open-path to `$RESOURCE/licenses/**` plus
  the paths the app already opens.
- Auth flows are exactly the engine's own (`/provider/auth`). opencode 1.19.1 has no Anthropic
  subscription OAuth and Weft adds none (Anthropic's terms forbid it in third-party apps).
- The engine binary is the official npm `opencode-windows-x64` package, verified by sha512. It is
  downloaded at run time, never bundled, and carries its own licence.

### B.7 Verification

- `npm run typecheck`, `npm run build`, `cargo build` in `src-tauri`.
- `npm run engine:dev` (isolated data) plus `tools/mock-provider.mjs` (an OpenAI-compatible mock
  that streams text, reasoning and tool calls and records every request) for end-to-end tests
  without paid calls: every operation in B.5 is checked on the recorded wire request
  (`tools/e2e-liberation.mjs` through `liberate.ts`, `tools/e2e-ui.mjs` through the UI in headless
  Edge).
- Release smoke test, after every release build: `node tools/low.mjs node tools/e2e-release.mjs
  [--exe <path>] [--keep]`. It runs the built `weft.exe` (default `<target dir>/release/weft.exe`;
  `--exe` takes the installed one) with isolated opencode data under `%TEMP%\weft-qa-release` and
  the mock provider as the only model, and attaches to its WebView2 over the DevTools protocol. It
  sets `WEFT_QA_BACKGROUND=1`: the window is created hidden, unfocusable and off the taskbar, then
  moved off-screen and shown without activation in one `SetWindowPos` (tao drops a starting position
  outside every monitor), and does not save its window state, but the page still renders, so a run
  never disturbs whatever is in front. Checks, in order: the page is on `tauri.localhost` with IPC
  answering, the window off-screen and unfocused; boot ends within 10 min with the engine ready at the reported version; the engine's
  data, config and state sit under the temp root; the plugin canary is listed; a project opens; New
  session shows pick 00; the mock reply arrives with the wire record naming the mock model; the
  observed system prompt equals what the mock received; an edit saves and the engine stores it; the
  theme toggle flips and back; Ctrl+, opens Settings, About shows the license buttons and Esc closes it; no exceptions or console
  errors; screenshots land in `.shots/release/`; the engine is a child of `weft.exe`; the titlebar
  Close exits the app within 30 s and the engine within 15 s more. It prints `ok` or `not ok` per
  check and exits 1 on any failure. Weft must not be running (single instance).
- `node tools/notices.mjs` after a dependency change (B.6).
- Screenshots: `node tools/shoot.mjs <url> <png>` (headless Edge, short profile dir).
- Workflows (B.8): `node tools/e2e-workflow.mjs [--keep]` loads both plugins into an isolated engine
  and has the mock model call the tool. It checks the tool and the saved workflow's command are
  listed; three parallel agents and a structured one return to the parent in order; the agents are
  child sessions that deny `workflow`, `task` and `todowrite` and are never offered them; the parent
  is offered the tool with nothing required and the saved workflows listed; the run is journaled;
  a resume replays every agent with no model call; a saved workflow runs by name with its args,
  phases and log, and its command prompts for it; the running part shows a running agent; Stop on
  the parent aborts every agent; a throwing script fails with a resume hint; a bad script, an
  unknown name and an empty call are refused.

### B.8 Workflows

`plugin/weft-workflow.ts` adds the `workflow` tool, after Claude Code's Workflow tool. The model
passes a `script` (plain JavaScript, optionally led by `export const meta = { name, description,
phases }`, a pure literal), or the `name` of a saved workflow, plus `args` (JSON text is parsed) and
`resumeFromRunId`. The body runs as an async function with `agent`, `parallel`, `pipeline`, `phase`,
`log`, `workflow` and `args` in scope (and `process`, `Bun`, `require`, `globalThis` shadowed). The
tool is opt-in by its description: the model asks first unless the user asked for a workflow.

- **Agents.** `agent(prompt, opts)` creates a child session (`parentID` = the calling session,
  title `<label> (<name> workflow)`, `metadata.weftWorkflow = {run, n}`) and prompts it on the
  synchronous legacy route (`POST /session/:id/message`), so every plugin hook runs. The result is
  the last text part, or `info.structured` when `opts.schema` asks for `format: json_schema`; a
  failure, an abort or a missing structured answer gives null. The child's permission is the
  parent session's denials and `external_directory` rules plus `deny` for `workflow`, `task` and
  `todowrite`, so a run never nests (only `workflow(name)` nests, one level). The model is the
  parent's (`ctx.extra.model`) unless `opts.model` names `provider/model` or a family name the
  current provider has; the parent's variant follows it. Unknown agents run as `general`, with a
  log line. At most min(16, cores − 2) agents run at once, 200 per run.
- **Progress.** `ctx.metadata()` does nothing for plugin tools in 1.19.1, so the plugin PATCHes the
  running tool part (found by `callID`) with `state.metadata.workflow`, at most every 300 ms, and
  never once the tool returned or was stopped. The returned metadata carries the final run. A part
  that ended while its run still reads `running` was stopped (`readRun`).
- **Stop.** `ctx.abort` aborts every running child over HTTP (aborting the parent does not reach
  sessions created over HTTP) and the call fails at once.
- **Journal and resume.** Each run keeps `script.js`, `run.json` and `journal.jsonl` in
  `WEFT_WORKFLOWS_DIR/<run id>` (`%LOCALAPPDATA%\app.weft.desktop\workflows`, pruned after 30 days).
  An agent call's key is a hash chained over every earlier call's prompt and options (label and
  phase left out), in call order. With `resumeFromRunId` the calls whose keys match the earlier
  run's results return them, until the first call that does not; that call and all later ones run.
- **Saved workflows.** `.opencode/workflows/*.js` and `.claude/workflows/*.js` in the directory and
  the worktree, then `$OPENCODE_CONFIG_DIR/workflows`, `~/.config/opencode/workflows` and
  `~/.claude/workflows`; the first file with a name wins, and `.claude` is skipped under
  `OPENCODE_DISABLE_CLAUDE_CODE`. Their meta is read without evaluating code. The
  `tool.definition` hook lists them in the tool's description on every call (and clears
  `required`: plain JSON Schema args would otherwise all be required); the `config` hook adds a
  command per saved workflow that has no command of that name.
- **UI.** `Brocade` renders a `workflow` part with `WorkflowView`: the description, the last log
  lines, the agents by phase (status, agent, tokens, time, **open** for the child session), the
  error and the `<result>` the model got.

**Speed.** `Speed` in the inkwell follows the reply streaming now, else the newest reply that can be
timed (`latestReply`). While it streams the rate is the streamed text and reasoning characters
since the first chunk seen, over four characters a token, divided by the time to the last chunk
(a stall keeps the last rate). A finished reply shows `measuredRate`: `tokens.output +
tokens.reasoning` over the time from the first text or reasoning part's `time.start` to the last
`time.end` or tool `state.time.start`, at least 0.25 s. The pick header shows the same figure.
