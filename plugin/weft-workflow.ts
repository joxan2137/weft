// Weft workflow plugin for the opencode engine (loaded beside weft-liberated.ts, through the
// OPENCODE_CONFIG_CONTENT Weft passes it). It adds the `workflow` tool, after Claude Code's Workflow
// tool: the model writes a JavaScript script whose agent(), parallel() and pipeline() calls run
// subagents, each in a child session of the calling one, and gets the script's return value back.
//   progress -> written into the running tool part as `metadata.workflow` (PATCH), because
//               ctx.metadata() never reaches a plugin tool in opencode 1.19.1
//   journal  -> every agent result lands in WEFT_WORKFLOWS_DIR/<run>/journal.jsonl, so a later call
//               with resumeFromRunId replays the unchanged prefix of the run instead of paying again
//   saved    -> scripts in .opencode/workflows (and .claude/workflows) of the project or the global
//               config run by name, and each becomes a slash command
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { cpus, homedir, tmpdir } from "node:os"
import { join } from "node:path"

type Client = PluginInput["client"]

/** What a plugin tool receives at run time (callID is undocumented but always set by the engine). */
type ToolContext = {
  sessionID: string
  messageID: string
  callID?: string
  agent: string
  abort: AbortSignal
  extra?: { model?: { id?: string; providerID?: string } }
}

type Phase = { title: string; detail?: string }
type Meta = { name?: string; description?: string; whenToUse?: string; phases?: Phase[] }
type AgentStatus = "queued" | "running" | "done" | "failed" | "stopped" | "cached"

/** One agent() call as the progress view shows it. */
type AgentRow = {
  n: number
  label: string
  phase?: string
  status: AgentStatus
  agent?: string
  model?: string
  session?: string
  start?: number
  end?: number
  tokens?: number
  cost?: number
  error?: string
}

/** `metadata.workflow` on the tool part: the contract with src/engine/workflow.ts. */
type Run = {
  v: 1
  id: string
  name: string
  description?: string
  status: "running" | "completed" | "failed" | "stopped"
  phases: Phase[]
  agents: AgentRow[]
  logs: { at: number; text: string }[]
  started: number
  ended?: number
  resumedFrom?: string
  error?: string
}

type AgentOpts = Record<string, unknown>
type Model = { providerID: string; modelID: string }
type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
type Saved = { name: string; file: string; meta: Meta }
type ReplyPart = { type: string; text?: string; synthetic?: boolean }
type ReplyInfo = {
  role: string
  error?: { name?: string; data?: { message?: string } }
  structured?: unknown
  variant?: string
  providerID?: string
  modelID?: string
}

const TOOL = "workflow"
const MAX_AGENTS = 200
const CONCURRENCY = Math.min(16, Math.max(2, cpus().length - 2))
const MAX_LOGS = 200
const PUBLISH_MS = 300
const KEEP_RUNS_MS = 30 * 24 * 60 * 60_000
const RUN_ID = /^wf_[a-z0-9-]{6,}$/
const SAVED_NAME = /^[A-Za-z0-9][\w.-]*$/
const STOPPED = "The workflow was stopped"

const ARGS = {
  script: { type: "string", description: "The workflow script (plain JavaScript)." },
  name: { type: "string", description: "The name of a saved workflow to run instead of a script." },
  args: { type: "string", description: "Input for the script, exposed as the global `args`. JSON text is parsed; other text stays a string." },
  resumeFromRunId: { type: "string", description: "The run id (wf_…) of an earlier call whose finished agents should be reused." },
}

// ───────── script parsing ─────────

/**
 * Reads the pure literal after `export const meta =` without evaluating it: listing saved workflows
 * must never run code from the project.
 */
function readLiteral(source: string, from: number) {
  let i = from
  const fail = (what: string): never => {
    throw new SyntaxError(`meta must be a pure literal (${what} at character ${i})`)
  }
  const space = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++
      if (source.startsWith("//", i)) {
        const next = source.indexOf("\n", i)
        i = next < 0 ? source.length : next
      } else if (source.startsWith("/*", i)) {
        const next = source.indexOf("*/", i + 2)
        if (next < 0) fail("an unclosed comment")
        i = next + 2
      } else return
    }
  }
  const quoted = () => {
    const quote = source[i++]
    let out = ""
    while (i < source.length && source[i] !== quote) {
      const c = source[i++]
      if (quote === "`" && c === "$" && source[i] === "{") fail("a template placeholder")
      if (c !== "\\") {
        out += c
        continue
      }
      const e = source[i++]
      if (e === "u") {
        out += String.fromCharCode(parseInt(source.slice(i, i + 4), 16))
        i += 4
      } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "" } as Record<string, string>)[e] ?? e
    }
    if (source[i] !== quote) fail("an unclosed string")
    i++
    return out
  }
  const string = () => {
    let out = quoted()
    for (;;) {
      const at = i
      space()
      if (source[i] !== "+") {
        i = at
        return out
      }
      i++
      space()
      if (!`"'\``.includes(source[i])) fail("a joined value that is not a string")
      out += quoted()
    }
  }
  const value = (): unknown => {
    space()
    const c = source[i]
    if (c === "{") {
      i++
      const out: Record<string, unknown> = {}
      for (;;) {
        space()
        if (source[i] === "}") {
          i++
          return out
        }
        let key: string
        if (source[i] === '"' || source[i] === "'") key = quoted()
        else {
          key = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 200))?.[0] ?? fail("a key")
          i += key.length
        }
        space()
        if (source[i++] !== ":") fail("a missing ':'")
        out[key] = value()
        space()
        if (source[i] === ",") i++
        else if (source[i] !== "}") fail("a missing ',' or '}'")
      }
    }
    if (c === "[") {
      i++
      const out: unknown[] = []
      for (;;) {
        space()
        if (source[i] === "]") {
          i++
          return out
        }
        out.push(value())
        space()
        if (source[i] === ",") i++
        else if (source[i] !== "]") fail("a missing ',' or ']'")
      }
    }
    if (c === '"' || c === "'" || c === "`") return string()
    const word = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null|undefined)/.exec(source.slice(i, i + 64))?.[0] ?? fail("an expression")
    i += word.length
    return word === "true" ? true : word === "false" ? false : word === "null" ? null : word === "undefined" ? undefined : Number(word)
  }
  return { value: value(), end: i }
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function cleanMeta(raw: unknown): Meta {
  const meta = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const phases = Array.isArray(meta.phases) ? meta.phases : []
  return {
    name: text(meta.name),
    description: text(meta.description),
    whenToUse: text(meta.whenToUse),
    phases: phases.flatMap((p) => {
      const phase = (p && typeof p === "object" ? p : {}) as Record<string, unknown>
      const title = text(phase.title)
      return title ? [{ title, detail: text(phase.detail) }] : []
    }),
  }
}

/** Splits `export const meta = {…}` off the script; the body keeps it as a plain `const meta`. */
function parseScript(source: string) {
  const head = /^[ \t]*export\s+const\s+meta\s*=\s*/m.exec(source)
  if (!head) return { meta: {} as Meta, body: source }
  const start = head.index + head[0].length
  return {
    meta: cleanMeta(readLiteral(source, start).value),
    body: `${source.slice(0, head.index)}${head[0].replace(/export\s+/, "")}${source.slice(start)}`,
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...params: string[]) => (...args: unknown[]) => Promise<unknown>
const GLOBALS = ["agent", "parallel", "pipeline", "phase", "log", "args", "workflow"]
/** Shadowed so a slip in a script cannot end or rewire the engine; not a sandbox. */
const SHADOWED = ["process", "Bun", "require", "module", "globalThis", "global"]

const compile = (body: string) => new AsyncFunction(...GLOBALS, ...SHADOWED, `"use strict";\n${body}`)

// ───────── saved workflows ─────────

const flag = (value?: string) => /^(1|true)$/i.test(value ?? "")

function workflowDirs(directory: string, worktree: string) {
  const claude = !flag(process.env.OPENCODE_DISABLE_CLAUDE_CODE)
  const home = process.env.OPENCODE_TEST_HOME || homedir()
  const config = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
  // opencode reports "/" as the worktree of a folder outside git.
  const roots = [...new Set([directory, worktree].filter((root) => root && root !== "/"))]
  return [
    ...roots.flatMap((root) => [join(root, ".opencode", "workflows"), ...(claude ? [join(root, ".claude", "workflows")] : [])]),
    ...(process.env.OPENCODE_CONFIG_DIR ? [join(process.env.OPENCODE_CONFIG_DIR, "workflows")] : []),
    join(config, "workflows"),
    ...(claude ? [join(home, ".claude", "workflows")] : []),
  ]
}

/** The first file with a name wins: the project before the global config, .opencode before .claude. */
function savedWorkflows(dirs: string[]) {
  const found = new Map<string, Saved>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files.filter((f) => /\.m?js$/.test(f)).sort()) {
      const name = file.replace(/\.m?js$/, "")
      if (found.has(name) || !SAVED_NAME.test(name)) continue
      let meta: Meta = {}
      try {
        meta = parseScript(readFileSync(join(dir, file), "utf8")).meta
      } catch {}
      found.set(name, { name, file: join(dir, file), meta })
    }
  }
  return found
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

function describe(saved: Map<string, Saved>) {
  const lines = [
    "Run a workflow: a JavaScript script that orchestrates subagents deterministically. Each agent() call runs a subagent in its own child session of this one; parallel() and pipeline() run many at once. The call returns when the script ends, with its return value.",
    "",
    "Use it only when the user asks for a workflow or for many agents at once, or names a saved workflow. Otherwise describe the workflow you would run and how many agents it would start, and ask first: every agent is a full model session and spends tokens.",
    "",
    "Parameters (give script, name or resumeFromRunId):",
    "- script: plain JavaScript, no TypeScript and no imports. It may begin with `export const meta = { name, description, phases: [{ title, detail }] }`, a pure literal. The rest runs as the body of an async function: await at the top level and `return` the result.",
    "- name: the name of a saved workflow to run instead of a script.",
    "- args: input for the script, exposed as the global `args`. JSON text is parsed; other text stays a string.",
    "- resumeFromRunId: the run id (wf_…) of an earlier call. Agent calls that repeat that run's calls in the same order, with the same prompt and options, return its results without running again; the first changed call and everything after it run live. Without script or name the earlier script runs again with its args.",
    "",
    "Inside the script:",
    '- agent(prompt, opts?) → Promise<string | object | null>: runs one subagent and resolves to its final text, or to the object it answered with when opts.schema is set; null when it failed or was stopped. opts: label (its name in the progress view), phase (its progress group), agent (an opencode agent; default general), model ("provider/model"; default this session\'s model), variant (a model variant such as a reasoning effort), schema (a JSON Schema object the answer must match).',
    "- parallel(thunks) → Promise<array>: starts every function at once and waits for all; one that throws gives null.",
    "- pipeline(items, ...stages) → Promise<array>: each item runs through the stages on its own, with no barrier between stages; a stage gets (previous, item, index); a throw gives null for that item. Prefer it to parallel when a stage does not need every earlier result.",
    "- phase(title): starts a progress group; agent() calls without opts.phase join it.",
    "- log(message): a progress line for the user.",
    "- workflow(name, args?): runs a saved workflow inside this one (one level deep) and resolves to its return value.",
    "- args: the args value.",
    `At most ${CONCURRENCY} agents run at once and the rest queue; a run starts at most ${MAX_AGENTS} agents, and about 15 is plenty unless the user asks for more. Subagents cannot start workflows, other subagents or todo lists. Leave files, network and processes to the agents: the script only orchestrates.`,
  ]
  const listed = [...saved.values()].slice(0, 40)
  if (listed.length)
    lines.push(
      "",
      "Saved workflows:",
      ...listed.map((s) => `- ${s.name}: ${clip(s.meta.description ?? "no description", 300)}${s.meta.whenToUse ? ` Use when: ${clip(s.meta.whenToUse, 300)}` : ""}`),
    )
  return lines.join("\n")
}

const commandTemplate = (name: string) =>
  `Run the saved workflow "${name}" with the workflow tool (name: "${name}"). Pass the text below as its args, unchanged; leave args empty when there is none.\n\n$ARGUMENTS`

// ───────── runs on disk ─────────

function newRunID() {
  const hex = randomBytes(6).toString("hex")
  return `wf_${hex.slice(0, 8)}-${hex.slice(8, 11)}`
}

function prune(root: string) {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names.filter((n) => RUN_ID.test(n))) {
    try {
      if (Date.now() - statSync(join(root, name)).mtimeMs > KEEP_RUNS_MS) rmSync(join(root, name), { recursive: true, force: true })
    } catch {}
  }
}

function loadRun(root: string, id: string) {
  const dir = join(root, id)
  let script: string
  try {
    script = readFileSync(join(dir, "script.js"), "utf8")
  } catch {
    throw new Error(`There is no workflow run ${id} on this machine.`)
  }
  let args: unknown
  try {
    args = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).args
  } catch {}
  const cache = new Map<string, unknown>()
  let lines: string[] = []
  try {
    lines = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n")
  } catch {}
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as { type?: string; key?: string; result?: unknown }
      if (record.type === "result" && typeof record.key === "string") cache.set(record.key, record.result ?? null)
    } catch {}
  }
  return { script, args, cache }
}

function parseArgs(value: unknown) {
  if (typeof value !== "string") return value
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// ───────── engine helpers ─────────

function semaphore(size: number) {
  let free = size
  const waiting: (() => void)[] = []
  return {
    acquire: () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((go) => waiting.push(go))),
    release: () => {
      const next = waiting.shift()
      if (next) next()
      else free++
    },
  }
}

const errorText = (error: unknown): string | undefined => {
  if (!error) return undefined
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  const data = (error as { data?: { message?: string }; message?: string; name?: string }).data
  return data?.message ?? (error as { message?: string }).message ?? (error as { name?: string }).name ?? JSON.stringify(error)
}

function lastText(parts: ReplyPart[] = []) {
  const texts = parts.filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
  return texts[texts.length - 1]?.text ?? ""
}

/**
 * Writes the run into the running tool part, at most every PUBLISH_MS. A part that is no longer
 * running is left alone, and nothing is sent once the tool returns or is stopped: a late write
 * would turn a finished part back into a running one.
 */
function liveProgress(client: Client, ctx: ToolContext) {
  type ToolPart = { id: string; type: string; callID?: string; state: { status: string } }
  const http = (client as unknown as { _client?: { patch: (options: Record<string, unknown>) => Promise<unknown> } })._client
  let part: ToolPart | undefined
  let pending: { title: string; run: Run } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain = Promise.resolve()
  let closed = !http || !ctx.callID

  const find = async () => {
    const res = await client.session.message({ path: { id: ctx.sessionID, messageID: ctx.messageID } }).catch(() => undefined)
    const parts = ((res?.data as { parts?: ToolPart[] } | undefined)?.parts ?? []) as ToolPart[]
    const found = parts.find((p) => p.type === "tool" && p.callID === ctx.callID)
    if (found?.state.status === "running") part = found
  }

  const send = () => {
    timer = undefined
    const next = pending
    pending = undefined
    if (!next) return
    chain = chain.then(async () => {
      if (closed) return
      if (!part) await find()
      if (!part || closed) return
      const body = { ...part, state: { ...part.state, title: next.title, metadata: { workflow: next.run } } }
      await http!
        .patch({
          url: "/session/{id}/message/{messageID}/part/{partID}",
          path: { id: ctx.sessionID, messageID: ctx.messageID, partID: part.id },
          body,
          headers: { "Content-Type": "application/json" },
        })
        .catch(() => undefined)
    })
  }

  return {
    update(title: string, run: Run) {
      if (closed) return
      pending = { title, run: structuredClone(run) }
      timer ??= setTimeout(send, PUBLISH_MS)
    },
    /** Sends the last update now and waits for every write. */
    async flush() {
      if (timer) clearTimeout(timer)
      send()
      await chain
    },
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      await chain
    },
  }
}

/** A hook that throws aborts the user's turn, so every hook degrades to "do nothing" instead. */
function guarded<A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (error) {
      console.error(`[weft-workflow] ${name}`, error)
    }
  }
}

function seconds(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function summary(run: Run) {
  const count = (status: AgentStatus) => run.agents.filter((a) => a.status === status).length
  const tokens = run.agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
  const parts = [
    `${run.agents.length} agent${run.agents.length === 1 ? "" : "s"}`,
    ...(["done", "cached", "failed", "stopped"] as const).filter((s) => count(s)).map((s) => `${count(s)} ${s}`),
    seconds((run.ended ?? Date.now()) - run.started),
    ...(tokens ? [`${tokens.toLocaleString("en-US")} tokens`] : []),
  ]
  return parts.join(", ")
}

function resultText(result: unknown) {
  if (result === undefined) return "(the script returned nothing)"
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

// ───────── the plugin ─────────

export default {
  id: "weft-workflow",
  server: (async ({ client, directory, worktree }) => {
    const dirs = workflowDirs(directory, worktree)
    const runsRoot = process.env.WEFT_WORKFLOWS_DIR || join(tmpdir(), "weft-workflows")

    async function execute(raw: Record<string, unknown>, ctx: ToolContext) {
      const resumeID = text(raw.resumeFromRunId)
      if (resumeID && !RUN_ID.test(resumeID)) throw new Error(`resumeFromRunId "${resumeID}" is not a workflow run id (wf_…).`)
      prune(runsRoot)
      const earlier = resumeID ? loadRun(runsRoot, resumeID) : undefined
      const savedName = text(raw.name)
      let script = text(raw.script) ? String(raw.script) : undefined
      if (!script && savedName) {
        const saved = savedWorkflows(dirs).get(savedName)
        if (!saved) {
          const known = [...savedWorkflows(dirs).keys()]
          throw new Error(`There is no saved workflow named "${savedName}". ${known.length ? `Saved workflows: ${known.join(", ")}.` : "No workflows are saved."}`)
        }
        script = readFileSync(saved.file, "utf8")
      }
      script ??= earlier?.script
      if (!script) throw new Error("Pass a script, the name of a saved workflow, or resumeFromRunId.")
      const args = raw.args !== undefined && raw.args !== "" ? parseArgs(raw.args) : earlier?.args
      const parsed = parseScript(script)
      const main = compile(parsed.body)

      const run: Run = {
        v: 1,
        id: newRunID(),
        name: parsed.meta.name ?? savedName ?? TOOL,
        description: parsed.meta.description,
        status: "running",
        phases: [...(parsed.meta.phases ?? [])],
        agents: [],
        logs: [],
        started: Date.now(),
        resumedFrom: resumeID,
      }
      const runDir = join(runsRoot, run.id)
      const record = () => {
        try {
          writeFileSync(join(runDir, "run.json"), JSON.stringify({ id: run.id, name: run.name, sessionID: ctx.sessionID, args, status: run.status, started: run.started, ended: run.ended, resumedFrom: resumeID }, null, 2))
        } catch {}
      }
      const journal = (entry: Record<string, unknown>) => {
        try {
          appendFileSync(join(runDir, "journal.jsonl"), `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
        } catch {}
      }
      try {
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, "script.js"), script)
      } catch {}
      record()

      const progress = liveProgress(client, ctx)
      const publish = () => progress.update(run.name, run)

      const [parentSession, parentMessage] = await Promise.all([
        client.session.get({ path: { id: ctx.sessionID } }).then((r) => r.data as { permission?: Rule[] } | undefined).catch(() => undefined),
        client.session
          .message({ path: { id: ctx.sessionID, messageID: ctx.messageID } })
          .then((r) => (r.data as { info?: ReplyInfo } | undefined)?.info)
          .catch(() => undefined),
      ])
      const parentModel: Model = {
        providerID: ctx.extra?.model?.providerID ?? parentMessage?.providerID ?? "",
        modelID: ctx.extra?.model?.id ?? parentMessage?.modelID ?? "",
      }
      // A subagent never inherits the parent's allows, only its denials; like opencode's own task tool
      // it cannot plan or delegate, and it can never start another workflow.
      const childPermission: Rule[] = [
        ...(parentSession?.permission ?? []).filter((r) => r.permission === "external_directory" || r.action === "deny"),
        ...[TOOL, "task", "todowrite"].map((permission): Rule => ({ permission, pattern: "*", action: "deny" })),
      ]

      type AgentInfo = { name: string; hidden?: boolean }
      type ProviderInfo = { id: string; models: Record<string, { id: string; name?: string; release_date?: string; variants?: Record<string, unknown> }> }
      let agentsLoaded: Promise<AgentInfo[]> | undefined
      let providersLoaded: Promise<ProviderInfo[]> | undefined
      const agents = () => (agentsLoaded ??= client.app.agents().then((r) => (r.data ?? []) as AgentInfo[]).catch(() => []))
      const providers = () => (providersLoaded ??= client.config.providers().then((r) => (r.data?.providers ?? []) as unknown as ProviderInfo[]).catch(() => []))

      const noted = new Set<string>()
      const log = (message: unknown) => {
        run.logs.push({ at: Date.now(), text: typeof message === "string" ? message : resultText(message) })
        if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS)
        publish()
      }
      const noteOnce = (key: string, message: string) => {
        if (noted.has(key)) return
        noted.add(key)
        log(message)
      }

      async function resolveAgent(wanted?: string) {
        const usable = (await agents()).filter((a) => !a.hidden)
        const fallback = usable.find((a) => a.name === "general")?.name ?? (usable.length ? ctx.agent : "general")
        if (!wanted) return fallback
        if (!usable.length) return wanted
        const hit = usable.find((a) => a.name === wanted) ?? usable.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
        if (hit) return hit.name
        noteOnce(`agent:${wanted}`, `There is no agent "${wanted}" here; its calls run as ${fallback}.`)
        return fallback
      }

      async function resolveModel(wanted?: string): Promise<Model> {
        if (!wanted) return parentModel
        const slash = wanted.indexOf("/")
        if (slash > 0) return { providerID: wanted.slice(0, slash), modelID: wanted.slice(slash + 1) }
        // Scripts written for Claude Code name models by family ("opus", "sonnet").
        const provider = (await providers()).find((p) => p.id === parentModel.providerID)
        const models = Object.values(provider?.models ?? {})
        const lower = wanted.toLowerCase()
        const hit =
          models.find((m) => m.id === wanted) ??
          models
            .filter((m) => m.id.toLowerCase().includes(lower) || m.name?.toLowerCase().includes(lower))
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))[0]
        if (provider && hit) return { providerID: provider.id, modelID: hit.id }
        noteOnce(`model:${wanted}`, `There is no model "${wanted}" at ${parentModel.providerID}; its calls use ${parentModel.providerID}/${parentModel.modelID}.`)
        return parentModel
      }

      async function resolveVariant(model: Model, wanted?: string) {
        if (!wanted) return model.providerID === parentModel.providerID && model.modelID === parentModel.modelID ? parentMessage?.variant : undefined
        const known = (await providers()).find((p) => p.id === model.providerID)?.models[model.modelID]?.variants
        if (known && Object.hasOwn(known, wanted)) return wanted
        noteOnce(`variant:${model.modelID}:${wanted}`, `${model.modelID} has no variant "${wanted}"; its calls use the default.`)
        return undefined
      }

      async function usage(row: AgentRow, sessionID: string) {
        const res = await client.session.messages({ path: { id: sessionID } }).catch(() => undefined)
        type Info = { role: string; cost?: number; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
        for (const message of ((res?.data ?? []) as { info: Info }[]).map((m) => m.info)) {
          if (message.role !== "assistant" || !message.tokens) continue
          const t = message.tokens
          row.tokens = (row.tokens ?? 0) + t.input + t.output + t.reasoning + t.cache.read + t.cache.write
          row.cost = (row.cost ?? 0) + (message.cost ?? 0)
        }
      }

      const active = new Set<string>()
      const abortActive = () => {
        for (const child of active) void client.session.abort({ path: { id: child } }).catch(() => undefined)
      }
      let stopped = false
      let stop!: () => void
      const stopping = new Promise<never>((_, reject) => {
        stop = () => {
          if (stopped) return
          stopped = true
          void progress.close()
          abortActive()
          // An abort that lands before a child's prompt has started is a no-op: try once more.
          setTimeout(abortActive, 1500)
          reject(new Error(STOPPED))
        }
      })
      stopping.catch(() => {})
      if (ctx.abort.aborted) stop()
      else ctx.abort.addEventListener("abort", stop, { once: true })

      const slots = semaphore(CONCURRENCY)
      const cache = earlier?.cache ?? new Map<string, unknown>()
      let replaying = cache.size > 0
      let previousKey = ""
      let spawned = 0
      let current: string | undefined

      const addPhase = (title: string) => {
        if (!run.phases.some((p) => p.title === title)) run.phases.push({ title })
      }

      /** Chained over every call in call order, so a resumed run replays only its unchanged prefix. */
      const keyOf = (prompt: string, opts: AgentOpts) => {
        const { label: _label, phase: _phase, ...rest } = opts
        let options: string
        try {
          options = JSON.stringify(rest)
        } catch {
          options = String(Object.keys(rest))
        }
        previousKey = createHash("sha256").update(`${previousKey}\n${JSON.stringify(prompt)}\n${options}`).digest("hex").slice(0, 32)
        return previousKey
      }

      const fail = (row: AgentRow, key: string, error: string) => {
        row.status = stopped ? "stopped" : "failed"
        row.error = clip(error, 600)
        journal({ type: "failed", key, n: row.n, label: row.label, error })
        return null
      }

      async function spawn(row: AgentRow, key: string, prompt: string, opts: AgentOpts) {
        const schema = opts.schema && typeof opts.schema === "object" ? opts.schema : undefined
        const name = await resolveAgent(text(opts.agent) ?? text(opts.agentType))
        const model = await resolveModel(text(opts.model))
        const variant = await resolveVariant(model, text(opts.variant) ?? text(opts.effort))
        if (opts.isolation !== undefined) noteOnce("isolation", `Isolation "${String(opts.isolation)}" is not available here; every agent works in the project folder.`)
        row.agent = name
        if (model.providerID) row.model = `${model.providerID}/${model.modelID}`
        journal({ type: "started", key, n: row.n, label: row.label })

        const created = await client.session
          .create({
            body: {
              parentID: ctx.sessionID,
              title: `${row.label} (${run.name} workflow)`,
              agent: name,
              permission: childPermission,
              metadata: { weftWorkflow: { run: run.id, n: row.n } },
            } as never,
          })
          .catch((error: unknown) => ({ data: undefined, error }))
        const child = (created.data as { id?: string } | undefined)?.id
        if (!child) return fail(row, key, `its session could not be created: ${errorText(created.error) ?? "no answer"}`)
        row.session = child
        if (stopped) {
          row.status = "stopped"
          return null
        }
        row.status = "running"
        row.start = Date.now()
        active.add(child)
        publish()

        const res = await client.session
          .prompt({
            path: { id: child },
            body: {
              agent: name,
              // Unknown only when the parent's model could not be read: the engine then picks one.
              ...(model.providerID && { model }),
              ...(variant && { variant }),
              ...(schema && { format: { type: "json_schema", schema } }),
              parts: [{ type: "text", text: prompt }],
            } as never,
          })
          .catch((error: unknown) => ({ data: undefined, error }))
        active.delete(child)
        row.end = Date.now()
        await usage(row, child)

        const reply = res.data as { info?: ReplyInfo; parts?: ReplyPart[] } | undefined
        const info = reply?.info
        if (info?.role !== "assistant") return fail(row, key, stopped ? "stopped" : (errorText((res as { error?: unknown }).error) ?? "it gave no reply"))
        if (info.error?.name === "MessageAbortedError") {
          row.status = "stopped"
          journal({ type: "failed", key, n: row.n, label: row.label, error: "stopped" })
          return null
        }
        if (info.error) return fail(row, key, errorText(info.error) ?? "it failed")
        const result = schema ? info.structured : lastText(reply?.parts)
        if (result === undefined) return fail(row, key, "it gave no structured output")
        row.status = "done"
        journal({ type: "result", key, n: row.n, label: row.label, result })
        return result
      }

      async function agent(prompt: unknown, options?: unknown) {
        if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent(prompt, opts): the prompt must be a non-empty string")
        if (stopped) throw new Error(STOPPED)
        if (spawned >= MAX_AGENTS) throw new Error(`A workflow starts at most ${MAX_AGENTS} agents.`)
        const opts = (options && typeof options === "object" ? options : {}) as AgentOpts
        const n = ++spawned
        const phase = text(opts.phase) ?? current
        if (phase) addPhase(phase)
        const row: AgentRow = { n, label: text(opts.label) ?? `agent ${n}`, phase, status: "queued" }
        run.agents.push(row)
        const key = keyOf(prompt, opts)
        if (replaying && cache.has(key)) {
          const result = cache.get(key)
          row.status = "cached"
          journal({ type: "result", key, n, label: row.label, result, cached: true })
          publish()
          return result
        }
        replaying = false
        publish()
        await slots.acquire()
        try {
          if (stopped) {
            row.status = "stopped"
            return null
          }
          return await spawn(row, key, prompt, opts)
        } catch (error) {
          return fail(row, key, errorText(error) ?? "it failed")
        } finally {
          slots.release()
          publish()
        }
      }

      const settle = async (work: () => unknown) => {
        try {
          return await work()
        } catch (error) {
          if (stopped) throw error
          log(`A step failed: ${errorText(error)}`)
          return null
        }
      }

      async function parallel(thunks: unknown) {
        if (!Array.isArray(thunks)) throw new TypeError("parallel(thunks): pass an array of functions")
        return Promise.all(thunks.map((thunk) => settle(() => (typeof thunk === "function" ? thunk() : thunk))))
      }

      async function pipeline(items: unknown, ...stages: unknown[]) {
        if (!Array.isArray(items)) throw new TypeError("pipeline(items, ...stages): pass an array of items")
        if (stages.some((stage) => typeof stage !== "function")) throw new TypeError("pipeline(items, ...stages): every stage must be a function")
        return Promise.all(
          items.map((item, index) =>
            settle(async () => {
              let value: unknown = item
              for (const stage of stages as ((previous: unknown, item: unknown, index: number) => unknown)[]) value = await stage(value, item, index)
              return value
            }),
          ),
        )
      }

      function phase(title: unknown) {
        const name = text(title)
        if (!name) return
        current = name
        addPhase(name)
        publish()
      }

      const nestedOnly = () => {
        throw new Error("workflow() runs one level deep: a saved workflow cannot start another")
      }

      async function workflow(name: unknown, nestedArgs?: unknown) {
        const saved = typeof name === "string" ? savedWorkflows(dirs).get(name) : undefined
        if (!saved) throw new Error(`There is no saved workflow named "${String(name)}".`)
        const nested = parseScript(readFileSync(saved.file, "utf8"))
        return compile(nested.body)(agent, parallel, pipeline, phase, log, nestedArgs, nestedOnly)
      }

      publish()
      try {
        const result = await Promise.race([main(agent, parallel, pipeline, phase, log, args, workflow), stopping])
        run.status = "completed"
        run.ended = Date.now()
        record()
        await progress.close()
        const failed = run.agents.filter((a) => a.status === "failed")
        return {
          title: run.name,
          output: [
            `Workflow "${run.name}" finished (run ${run.id}): ${summary(run)}.`,
            ...(failed.length ? ["Failed agents:", ...failed.slice(0, 20).map((a) => `- ${a.label}: ${a.error}`)] : []),
            "<result>",
            resultText(result),
            "</result>",
          ].join("\n"),
          metadata: { workflow: run },
        }
      } catch (error) {
        run.status = stopped ? "stopped" : "failed"
        run.ended = Date.now()
        run.error = clip(errorText(error) ?? "it failed", 2000)
        record()
        if (!stopped) {
          publish()
          await progress.flush()
        }
        await progress.close()
        const kept = run.agents.filter((a) => a.status === "done" || a.status === "cached").length
        throw new Error(
          `Workflow "${run.name}" ${stopped ? "was stopped" : "failed"} (run ${run.id}): ${run.error}` +
            (kept ? `\n${kept} agent result${kept === 1 ? " is" : "s are"} saved: call workflow again with resumeFromRunId "${run.id}" (and a fixed script) to reuse them.` : ""),
        )
      } finally {
        ctx.abort.removeEventListener("abort", stop)
      }
    }

    const hooks: Hooks = {
      config: guarded("config", async (cfg) => {
        const saved = savedWorkflows(dirs)
        if (!saved.size) return
        const commands = (cfg.command ??= {})
        for (const wf of saved.values()) {
          if (commands[wf.name]) continue
          commands[wf.name] = { description: clip(`Workflow: ${wf.meta.description ?? wf.name}`, 300), template: commandTemplate(wf.name) }
        }
      }),
      tool: {
        [TOOL]: {
          description: describe(new Map()),
          args: ARGS as never,
          execute: (args, ctx) => execute(args as Record<string, unknown>, ctx as unknown as ToolContext),
        },
      },
      // Lists the saved workflows as they are now, and frees every parameter: plugin tools with
      // plain JSON Schema args would otherwise require all of them.
      "tool.definition": guarded("tool.definition", async (input, output) => {
        if (input.toolID !== TOOL) return
        output.description = describe(savedWorkflows(dirs))
        const typed = output as { jsonSchema?: Record<string, unknown> }
        if (typed.jsonSchema) typed.jsonSchema = { ...typed.jsonSchema, required: [] }
      }),
    }
    return hooks
  }) satisfies Plugin,
}
