#!/usr/bin/env node
// End-to-end check of liberation (docs/DESIGN.md B.5). Starts tools/mock-provider.mjs and an isolated
// opencode 1.19.1 engine that loads plugin/weft-liberated.ts, drives every edit operation through
// src/engine/liberate.ts and asserts on the request the model actually received.
//
//   node tools/e2e-liberation.mjs [--keep]     (--keep leaves %TEMP%\weft-liberation for inspection)
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  carryMetaToFork,
  clothOrder,
  createLiberation,
  deriveCloth,
  isBusy,
  providerPromptFile,
  readMeta,
  SEED_TAIL,
  WARP_ID,
} from "../src/engine/liberate.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const EXE = join(ROOT, ".ref", "bin", "package", "bin", "opencode.exe")
const PROMPTS = join(ROOT, "src", "assets", "prompts")
const TEMP = join(tmpdir(), "weft-liberation")
const ENGINE_PORT = 48620
const MOCK_PORT = 48621
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const USER = "weft"
const PASSWORD = randomUUID()
const MODEL = { providerID: "mock", modelID: "mock-model" }
const CLAUDE = { providerID: "mock", modelID: "claude-mock" }
const KEEP = process.argv.includes("--keep")

const at = (...names) => join(TEMP, ...names)
const WORK = at("w")
const OBSERVED = at("obs")
const LOG = at("mock.jsonl")
const prompt = (file) => readFileSync(join(PROMPTS, file), "utf8")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ───────── transport (the contract's Http over fetch) ─────────

class HttpError extends Error {
  constructor(status, body, message) {
    super(message)
    this.status = status
    this.body = body
  }
}

function nodeHttp(base, user, password) {
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
  const url = (path, query = {}) => {
    const target = new URL(path, base)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(key, String(value))
    return target.toString()
  }
  const call = async (method, path, opts = {}) => {
    const headers = { authorization: auth, ...opts.headers }
    if (opts.directory) headers["x-opencode-directory"] = encodeURIComponent(opts.directory)
    if (opts.body !== undefined) headers["content-type"] = "application/json"
    const res = await fetch(url(path, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
    const text = await res.text()
    let data = text
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {}
    if (!res.ok) throw new HttpError(res.status, data, `${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
    return { data, status: res.status, headers: res.headers }
  }
  return {
    get: (path, opts) => call("GET", path, opts),
    post: (path, opts) => call("POST", path, opts),
    put: (path, opts) => call("PUT", path, opts),
    patch: (path, opts) => call("PATCH", path, opts),
    del: (path, opts) => call("DELETE", path, opts),
    url,
    auth: () => auth,
  }
}

const api = nodeHttp(ENGINE, USER, PASSWORD)

// ───────── processes ─────────

const children = []
let engineLog

async function waitFor(probe, ms, label) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message}${last.cause ? `: ${last.cause.code ?? last.cause.message}` : ""})` : ""}`)
}

/** Every config dir opencode scans gets an npm install unless node_modules exists and the lock names its deps. */
const CONFIG_DIRS = [at("cfg"), at("c", "opencode")]

function prepare() {
  rmSync(TEMP, { recursive: true, force: true })
  for (const name of ["d", "c", "k", "s", "t", "home", "obs", "w", "cfg/plugins"]) mkdirSync(at(name), { recursive: true })
  copyFileSync(join(ROOT, "plugin", "weft-liberated.ts"), at("cfg", "plugins", "weft-liberated.ts"))
  const dependencies = { "@opencode-ai/plugin": "1.19.1" }
  for (const dir of CONFIG_DIRS) {
    mkdirSync(join(dir, "node_modules"), { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "weft-engine", private: true, dependencies }, null, 2))
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ name: "weft-engine", lockfileVersion: 3, requires: true, packages: { "": { name: "weft-engine", dependencies } } }, null, 2),
    )
  }
  const limit = { context: 100000, output: 4096 }
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    compaction: { tail_turns: 2 },
    enabled_providers: ["mock"],
    model: "mock/mock-model",
    small_model: "mock/mock-model",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `${MOCK}/v1`, apiKey: "mock-key" },
        models: {
          "mock-model": { name: "Mock model", tool_call: true, limit },
          "claude-mock": { name: "Mock claude", tool_call: true, limit },
        },
      },
    },
  }
  writeFileSync(at("cfg", "opencode.json"), JSON.stringify(config, null, 2))
  writeFileSync(join(WORK, "AGENTS.md"), "PROJECT RULES\nPrices like $& and $1 stay literal.\n")
  writeFileSync(join(WORK, "README.md"), "# e2e workspace\n")
  // Its own repo, so the engine's worktree (and its .opencode / AGENTS.md lookups) stop here, not in an enclosing repo.
  if (spawnSync("git", ["init", "-q"], { cwd: WORK }).status !== 0) throw new Error("git init failed in the work dir")
}

function engineEnv() {
  const inherited = Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|WEFT_)/i.test(key))
  return {
    ...Object.fromEntries(inherited),
    XDG_DATA_HOME: at("d"),
    XDG_CONFIG_HOME: at("c"),
    XDG_CACHE_HOME: at("k"),
    XDG_STATE_HOME: at("s"),
    TEMP: at("t"),
    TMP: at("t"),
    OPENCODE_CONFIG_DIR: at("cfg"),
    OPENCODE_TEST_HOME: at("home"),
    OPENCODE_SERVER_USERNAME: USER,
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    WEFT_OBSERVED_DIR: OBSERVED,
  }
}

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    return false
  } catch (error) {
    return error.cause?.code === "ECONNREFUSED"
  }
}

async function start() {
  for (const port of [ENGINE_PORT, MOCK_PORT]) if (!(await portFree(port))) throw new Error(`port ${port} is in use`)
  const mock = spawn(process.execPath, [join(ROOT, "tools", "mock-provider.mjs"), "--port", String(MOCK_PORT), "--log", LOG], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  })
  children.push(mock)
  await new Promise((ready, fail) => {
    mock.stdout.once("data", ready)
    mock.once("exit", (code) => fail(new Error(`mock exited ${code}`)))
  })

  engineLog = openSync(at("engine.log"), "w")
  const engine = spawn(EXE, ["serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1", "--print-logs"], {
    cwd: WORK,
    env: engineEnv(),
    stdio: ["ignore", engineLog, engineLog],
    windowsHide: true,
  })
  children.push(engine)
  // A request that reaches opencode 1.19.1 right as it starts listening can hang forever: probe with a timeout.
  const health = () => api.get("/global/health", { signal: AbortSignal.timeout(2_000) })
  await waitFor(async () => (await health()).data?.healthy, 60_000, "engine health")
}

async function stop() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise((done) => child.once("exit", done))
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    else child.kill("SIGTERM")
    await Promise.race([exited, sleep(5_000)])
  }
  if (engineLog !== undefined) closeSync(engineLog)
  if (KEEP) return
  for (let attempt = 0; attempt < 20 && existsSync(TEMP); attempt++) {
    try {
      rmSync(TEMP, { recursive: true, force: true })
    } catch {
      await sleep(250)
    }
  }
}

// ───────── wire records ─────────

const records = () =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("")
      : ""

const systemOf = (record) => record.body.messages.filter((m) => m.role === "system").map((m) => contentText(m.content))

const convo = (record) =>
  record.body.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, text: contentText(m.content), reasoning: m.reasoning_content, calls: m.tool_calls }))

const indexOf = (messages, text) => messages.findIndex((m) => m.text.includes(text))

const observed = (sessionID) => JSON.parse(readFileSync(join(OBSERVED, `${sessionID}.json`), "utf8"))

/** Independent re-statement of opencode's join for a template: lines holding only an empty placeholder vanish. */
function expected(template, segments, original) {
  const values = {
    prompt: segments.prompt,
    environment: segments.environment,
    references: segments.references,
    instructions: segments.instructions,
    mcp: segments.mcp,
    skills: segments.skills,
    structured_output: segments.structuredOutput,
    client_system: segments.clientSystem,
    opencode: original,
  }
  const known = (name) => Object.hasOwn(values, name)
  const lines = []
  for (const line of template.split("\n")) {
    const only = /^\{\{(\w+)\}\}$/.exec(line)
    if (only && known(only[1])) {
      if (values[only[1]]) lines.push(values[only[1]])
      continue
    }
    lines.push(line.replace(/\{\{(\w+)\}\}/g, (token, name) => (known(name) ? values[name] : token)))
  }
  return lines.join("\n")
}

const opencodeDefault = (segments) =>
  ["prompt", "environment", "references", "instructions", "mcp", "skills", "structuredOutput", "clientSystem"]
    .map((key) => segments[key])
    .filter(Boolean)
    .join("\n")

function firstDiff(got, want) {
  let i = 0
  while (i < got.length && got[i] === want[i]) i++
  return `differs at ${i}: got ${JSON.stringify(got.slice(i, i + 50))}, want ${JSON.stringify(want.slice(i, i + 50))}`
}

// ───────── session driving ─────────

const script = (replies) => fetch(`${MOCK}/mock/script`, { method: "POST", body: JSON.stringify(replies) })

async function createSession() {
  return (await api.post("/session", { directory: WORK, body: {} })).data.id
}

async function statusOf(sessionID) {
  return (await api.get("/session/status", { directory: WORK })).data[sessionID]
}

async function idle(sessionID) {
  await waitFor(
    async () => {
      const status = await statusOf(sessionID)
      if (status && status.type !== "idle") return false
      const { data } = await api.get(`/session/${encodeURIComponent(sessionID)}/message`, { query: { limit: 1 } })
      const last = data[data.length - 1]?.info
      return last?.role === "assistant" && last.time.completed !== undefined
    },
    60_000,
    `session ${sessionID} to settle`,
  )
}

async function turn(sessionID, run) {
  const before = records().length
  await run()
  await waitFor(() => records().slice(before).some((r) => r.kind === "main"), 30_000, "a model call")
  await idle(sessionID)
  const fresh = records().slice(before)
  const mains = fresh.filter((r) => r.kind === "main")
  return { fresh, mains, last: mains[mains.length - 1], before }
}

const promptBody = (text, model = MODEL) => ({ agent: "build", model, parts: text === undefined ? [] : [{ type: "text", text }] })
const send = (sessionID, text, model) =>
  turn(sessionID, () => api.post(`/session/${encodeURIComponent(sessionID)}/prompt_async`, { body: promptBody(text, model) }))

const store = new Map()

async function refresh(sessionID) {
  const [{ data: info }, { data: list }] = await Promise.all([api.get(`/session/${sessionID}`), api.get(`/session/${sessionID}/message`)])
  list.sort((a, b) => a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : 1))
  store.set(sessionID, {
    info,
    content: {
      messages: list.map((m) => m.info),
      parts: Object.fromEntries(list.map((m) => [m.info.id, m.parts])),
      loaded: true,
      hasOlder: false,
      loadingOlder: false,
    },
  })
  return store.get(sessionID)
}

const entries = (sessionID) => {
  const { content } = store.get(sessionID)
  return content.messages.map((info) => ({ info, parts: content.parts[info.id] ?? [] }))
}
const withText = (sessionID, text, role) =>
  entries(sessionID).find((e) => (!role || e.info.role === role) && e.parts.some((p) => p.type === "text" && p.text === text))
const repliesTo = (sessionID, userID) => entries(sessionID).filter((e) => e.info.role === "assistant" && e.info.parentID === userID)
const metaOf = (sessionID) => readMeta(store.get(sessionID).info)

const lib = createLiberation({
  http: api,
  info: (sessionID) => store.get(sessionID)?.info,
  content: (sessionID) => store.get(sessionID)?.content,
  directory: () => WORK,
  continueSession: async (sessionID) => {
    await api.post(`/session/${sessionID}/prompt_async`, { body: promptBody(undefined) })
  },
})

// ───────── checks ─────────

const results = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function check(name, run) {
  try {
    const detail = await run()
    results.push({ name, ok: true, detail: detail ?? "" })
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
  }
}

async function scenario() {
  await check("canary weft_canary in /experimental/tool/ids", async () => {
    const { data } = await api.get("/experimental/tool/ids", { directory: WORK })
    assert(data.includes("weft_canary"), `ids: ${data.join(", ")}`)
    return `${data.length} tool ids`
  })

  const S = await createSession()

  await script([{ reasoning: "secret chain", text: "answer one" }])
  const t1 = await send(S, "q1 hello")
  await check("seed: default system = default.txt + SEED_TAIL, byte-exact", () => {
    const obs = observed(S)
    const file = providerPromptFile({ providerID: MODEL.providerID, apiID: MODEL.modelID }).file
    const [system, ...more] = systemOf(t1.last)
    assert(file === "default.txt", `selected ${file}`)
    assert(more.length === 0 && system === obs.sent, "wire system differs from observed.sent")
    assert(obs.exact && !obs.rewritten, `observed exact=${obs.exact} rewritten=${obs.rewritten}`)
    assert(obs.segments.prompt === prompt(file), "observed {{prompt}} differs from vendored default.txt")
    const seeded = expected(`${prompt(file)}\n${SEED_TAIL}`, obs.segments, system)
    assert(seeded === system, firstDiff(seeded, system))
    return `${system.length} chars`
  })
  await check("engine workspace root is the isolated work dir", () => {
    const env = observed(S).segments.environment
    const root = /Workspace root folder: ([^\n]*)/.exec(env)?.[1] ?? ""
    const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
    assert(same(root, WORK) && env.includes("Is directory a git repo: yes"), env)
  })
  await check("title call untouched (default session)", async () => {
    const title = await waitFor(() => records().find((r) => r.kind === "title"), 15_000, "title call")
    const system = systemOf(title)
    assert(system.length === 1 && system[0] === prompt("title.txt"), firstDiff(system[0] ?? "", prompt("title.txt")))
    return "system = title.txt"
  })

  await script([{ tool: { name: "glob", arguments: { pattern: "*.md" } } }, { text: "found files" }])
  const t2 = await send(S, "q2 list files")
  await check("baseline: tool turn + same-model reasoning replay", () => {
    assert(t2.mains.length === 2, `${t2.mains.length} model calls`)
    const a1 = convo(t2.mains[0]).find((m) => m.role === "assistant" && m.text.includes("answer one"))
    assert(a1?.reasoning === "secret chain", `reasoning_content ${JSON.stringify(a1?.reasoning)}`)
    assert(convo(t2.mains[1]).some((m) => m.role === "tool"), "no tool result in step 2")
  })
  await send(S, "q3 third")

  await refresh(S)
  const u1 = withText(S, "q1 hello", "user")
  const a1 = repliesTo(S, u1.info.id)[0]
  const u2 = withText(S, "q2 list files", "user")
  const a2tool = repliesTo(S, u2.info.id).find((e) => e.parts.some((p) => p.type === "tool"))
  const u3 = withText(S, "q3 third", "user")
  const reasoning = a1.parts.find((p) => p.type === "reasoning")
  const toolPart = a2tool.parts.find((p) => p.type === "tool")

  const template = "WEFT HEAD $& $1\n{{prompt}}\n{{environment}}\n{{instructions}}\n{{skills}}\n{{client_system}}\nWEFT TAIL"
  await lib.editSystem(S, template)
  const tSystem = await send(S, "q4 system")
  await check("editSystem: system replaced byte-exact, placeholders expanded", async () => {
    const obs = observed(S)
    const system = systemOf(tSystem.last)
    assert(system.length === 1, `${system.length} system messages`)
    assert(obs.rewritten && obs.exact, `observed rewritten=${obs.rewritten} exact=${obs.exact}`)
    assert(system[0] === obs.sent, "wire system differs from observed.sent")
    const want = expected(template, obs.segments, "")
    assert(system[0] === want, firstDiff(system[0], want))
    assert(system[0].startsWith(`WEFT HEAD $& $1\n${prompt("default.txt")}\n`), "head or {{prompt}} wrong")
    assert(obs.segments.instructions.includes("PROJECT RULES") && system[0].includes(obs.segments.instructions), "{{instructions}} missing")
    assert(system[0].endsWith("\nWEFT TAIL"), "tail wrong")
    await refresh(S)
    const meta = metaOf(S)
    assert(meta.system?.text === template && meta.system?.seed === "default.txt", `meta.system ${JSON.stringify(meta.system)}`)
    return `${system[0].length} chars`
  })

  await lib.setRole(S, u1.info.id, "assistant")
  await lib.setRole(S, a1.info.id, "user")
  await lib.setRole(S, u2.info.id, "system")
  await lib.setRole(S, a2tool.info.id, "user")
  const tRoles = await send(S, "q5 roles")
  const roles = convo(tRoles.last)
  await check("setRole user -> assistant", () => {
    const m = roles.find((x) => x.text === "q1 hello")
    assert(m?.role === "assistant", `role ${m?.role}`)
  })
  await check("setRole assistant -> user (reasoning dropped)", () => {
    const m = roles.find((x) => x.text.includes("answer one"))
    assert(m?.role === "user" && !m.reasoning && !m.text.includes("secret chain"), JSON.stringify(m))
  })
  await check("setRole system -> <system-reminder> user", () => {
    assert(roles.some((x) => x.role === "user" && x.text === "<system-reminder>\nq2 list files\n</system-reminder>"), "no wrapped reminder")
  })
  await check("setRole tool turn -> user text", () => {
    assert(roles.some((x) => x.role === "user" && x.text.startsWith('[glob] {"pattern":"*.md"}')), "no [glob] text")
    assert(!roles.some((x) => x.calls?.length || x.role === "tool"), "tool call still on the wire")
  })
  await refresh(S)
  for (const entry of [u1, a1, u2, a2tool]) await lib.setRole(S, entry.info.id, entry.info.role)
  await check("setRole back to stored role clears meta.roles; mends kept", async () => {
    await refresh(S)
    const meta = metaOf(S)
    assert(meta.roles === undefined, JSON.stringify(meta.roles))
    assert(meta.mends?.[u1.info.id]?.[0]?.text === "q1 hello", JSON.stringify(meta.mends))
  })

  await lib.setMuted(S, u3.info.id, true)
  const tMute = await send(S, "q6 mute")
  await check("setMuted: muted message absent from the wire, kept in storage", async () => {
    assert(!convo(tMute.last).some((m) => m.text.includes("q3 third")), "q3 still sent")
    await refresh(S)
    assert(withText(S, "q3 third", "user"), "q3 deleted from storage")
  })
  await check("deriveCloth: pick 00 template, roles, muted flag", async () => {
    const { info, content } = store.get(S)
    const obs = observed(S)
    const cloth = deriveCloth({ session: info, messages: content.messages, parts: content.parts, seed: { file: "default.txt", text: prompt("default.txt") }, observed: obs })
    const [warp, ...picks] = cloth
    assert(warp.id === WARP_ID && warp.role === "system" && warp.warp?.rewritten && warp.warp.template === template, "pick 00 wrong")
    assert(warp.warp.values?.environment === obs.segments.environment, "pick 00 values missing")
    assert(picks.find((p) => p.id === u3.info.id)?.muted === true, "muted flag missing")
    assert(picks.every((p) => p.parts.every((part) => ["text", "reasoning", "tool", "file"].includes(part.type))), "unfiltered parts")
    assert(picks.length === content.messages.length, `${picks.length} picks for ${content.messages.length} messages`)
    return `${cloth.length} picks`
  })
  await lib.setMuted(S, u3.info.id, false)

  await lib.editPart(S, a1.info.id, reasoning.id, "edited chain")
  const tThought = await send(S, "q7 thought")
  await check("editPart reasoning: sent as text, no reasoning_content", async () => {
    const m = convo(tThought.last).find((x) => x.role === "assistant" && x.text.includes("answer one"))
    assert(m?.text.includes("<thinking>\nedited chain\n</thinking>"), JSON.stringify(m))
    assert(!m.reasoning, `reasoning_content ${JSON.stringify(m.reasoning)}`)
    assert(!JSON.stringify(tThought.last.body).includes("secret chain"), "old reasoning leaked")
    await refresh(S)
    assert(metaOf(S).thought?.[reasoning.id] === true, "meta.thought not set")
  })

  await sleep(2_100)
  await refresh(S)
  const mendsBefore = metaOf(S).mends?.[u1.info.id]?.length ?? 0
  const u1Text = u1.parts.find((p) => p.type === "text")
  await lib.editPart(S, u1.info.id, u1Text.id, "q1 hello EDITED")
  await lib.setRole(S, u1.info.id, "user")
  const tEdit = await send(S, "q8 edit")
  await check("editPart text: edited text on the wire, one mend per edit", async () => {
    const c = convo(tEdit.last)
    assert(c.some((m) => m.role === "user" && m.text === "q1 hello EDITED") && !c.some((m) => m.text === "q1 hello"), "edit not sent")
    await refresh(S)
    const mends = metaOf(S).mends?.[u1.info.id] ?? []
    const last = mends[mends.length - 1]
    assert(mends.length === mendsBefore + 1 && last.text === "q1 hello" && last.role === "user", JSON.stringify(mends))
    return `${mends.length} mends`
  })

  await refresh(S)
  await lib.insertAfter(S, u1.info.id, "inserted user note", "user")
  await lib.insertAfter(S, a1.info.id, "inserted assistant note", "assistant")
  await lib.insertAfter(S, undefined, "inserted at start", "user")
  const tInsert = await send(S, "q9 insert")
  await check("insertAfter: positions and roles on the wire", () => {
    const c = convo(tInsert.last)
    assert(indexOf(c, "inserted at start") === 0, `start at ${indexOf(c, "inserted at start")}`)
    assert(indexOf(c, "inserted user note") === indexOf(c, "q1 hello EDITED") + 1, "user note misplaced")
    const note = indexOf(c, "inserted assistant note")
    assert(note === indexOf(c, "answer one") + 1 && c[note].role === "assistant", `assistant note at ${note} as ${c[note]?.role}`)
    assert(indexOf(c, "q9 insert") === c.length - 1, "new prompt not last")
    return c.map((m) => m.role[0]).join("")
  })

  await refresh(S)
  await lib.move(S, u3.info.id, u1.info.id)
  const tMove = await send(S, "q10 move")
  await check("move: pick lands before its target", () => {
    const c = convo(tMove.last)
    assert(indexOf(c, "q3 third") === indexOf(c, "q1 hello EDITED") - 1, `q3 at ${indexOf(c, "q3 third")}`)
  })
  await check("order respected: cloth order == wire order", async () => {
    await refresh(S)
    const { info, content } = store.get(S)
    const c = convo(tMove.last)
    const cloth = deriveCloth({ session: info, messages: content.messages, parts: content.parts, seed: { file: "default.txt", text: "" } }).slice(1)
    const texts = cloth
      .filter((p) => p.role === "user" && p.info.role === "user")
      .map((p) => p.parts.find((x) => x.type === "text")?.text)
      .filter((t) => t && indexOf(c, t) >= 0)
    const positions = texts.map((t) => indexOf(c, t))
    assert(positions.every((p, i) => i === 0 || p > positions[i - 1]), `positions ${positions.join(",")}`)
    return `${texts.length} user picks in order`
  })

  await refresh(S)
  const atStart = withText(S, "inserted at start", "user")
  await lib.removePart(S, a2tool.info.id, toolPart.id)
  await lib.removeMessage(S, atStart.info.id)
  const tRemove = await send(S, "q11 remove")
  await check("removePart / removeMessage: gone from the wire and storage", async () => {
    const c = convo(tRemove.last)
    assert(!c.some((m) => m.calls?.length || m.role === "tool"), "tool call still sent")
    assert(indexOf(c, "inserted at start") < 0, "removed message still sent")
    await refresh(S)
    assert(!withText(S, "inserted at start"), "message still stored")
    assert(!entries(S).some((e) => e.parts.some((p) => p.id === toolPart.id)), "part still stored")
    assert(metaOf(S).order?.[atStart.info.id] === undefined, "order kept a removed id")
  })

  await script([{ text: "slow reply", delayMs: 4_000 }])
  let busyError
  await turn(S, async () => {
    await api.post(`/session/${S}/prompt_async`, { body: promptBody("q12 slow") })
    await waitFor(async () => (await statusOf(S))?.type === "busy", 10_000, "busy status")
    await refresh(S)
    busyError = await lib.removeMessage(S, withText(S, "inserted user note", "user").info.id).then(
      () => new Error("DELETE succeeded while busy"),
      (error) => error,
    )
  })
  await check("busy: removeMessage -> 409 HttpError, nothing removed", async () => {
    assert(busyError instanceof HttpError && isBusy(busyError), String(busyError?.message ?? busyError))
    assert(busyError.body?._tag === "SessionBusyError", JSON.stringify(busyError.body))
    await refresh(S)
    assert(withText(S, "inserted user note", "user"), "message was removed")
    return `${busyError.status} ${busyError.body._tag}`
  })

  await refresh(S)
  const u2now = withText(S, "q2 list files", "user")
  const ids = clothOrder(store.get(S).content.messages, metaOf(S)).map((m) => m.id)
  const later = ids.slice(ids.indexOf(u2now.info.id) + 1)
  const tResend = await turn(S, () => lib.resendFrom(S, u2now.info.id, "q2 RESENT"))
  await check("resendFrom: text patched, later picks deleted, continued", async () => {
    const c = convo(tResend.last)
    assert(c[c.length - 1]?.role === "user" && c[c.length - 1].text === "q2 RESENT", `last ${JSON.stringify(c[c.length - 1])}`)
    for (const gone of ["found files", "q4 system", "q11 remove", "slow reply"]) assert(indexOf(c, gone) < 0, `${gone} still sent`)
    await refresh(S)
    const stored = new Set(store.get(S).content.messages.map((m) => m.id))
    assert(later.every((id) => !stored.has(id)), "later messages still stored")
    assert(repliesTo(S, u2now.info.id).length === 0 && withText(S, "q2 RESENT", "user"), "resend state wrong")
    return `${later.length} later messages deleted`
  })

  await refresh(S)
  const q3 = withText(S, "q3 third", "user")
  await lib.setRole(S, q3.info.id, "assistant")
  const fork = (await api.post(`/session/${S}/fork`, { body: {} })).data
  await carryMetaToFork(api, S, fork)
  await check("fork: metadata.weft carried onto the fork's ids", async () => {
    await refresh(fork.id)
    await refresh(S)
    const meta = metaOf(fork.id)
    const forkIDs = new Set(entries(fork.id).map((e) => e.info.id))
    const roleIDs = Object.keys(meta.roles ?? {})
    assert(roleIDs.length === Object.keys(metaOf(S).roles ?? {}).length && roleIDs.every((id) => forkIDs.has(id)), JSON.stringify(meta.roles))
    assert(meta.roles[withText(fork.id, "q3 third", "user").info.id] === "assistant", "q3 role not carried")
    assert(Object.keys(meta.order ?? {}).every((id) => forkIDs.has(id)), "order keeps source ids")
    assert(meta.system?.text === template, "system not carried")
    const tFork = await send(fork.id, "q fork")
    const c = convo(tFork.last)
    assert(c[indexOf(c, "q3 third")]?.role === "assistant", "role not applied in the fork")
    assert(indexOf(c, "q3 third") === indexOf(c, "q1 hello EDITED") - 1, "order not applied in the fork")
  })

  const beforeCompaction = records().length
  await api.post(`/session/${S}/summarize`, { body: { providerID: MODEL.providerID, modelID: MODEL.modelID, auto: false } })
  await check("compaction call untouched (compaction.txt) while system is rewritten", async () => {
    const compaction = await waitFor(() => records().slice(beforeCompaction).find((r) => r.kind === "compaction"), 20_000, "compaction call")
    const system = systemOf(compaction)
    assert(system.length === 1 && system[0] === prompt("compaction.txt"), firstDiff(system[0] ?? "", prompt("compaction.txt")))
    await idle(S)
  })
  await refresh(S)
  const orderedTail = Object.keys(metaOf(S).order ?? {}).length
  const tCompacted = await send(S, "q after compaction")
  await check("after compaction: summary leads, ahead of the ordered tail", () => {
    const c = convo(tCompacted.last)
    assert(c[0]?.role === "user" && c[0].text.includes("What did we do so far?"), `first ${JSON.stringify(c[0])}`)
    assert(c[1]?.role === "assistant" && c[1].text.includes("mock summary"), `second ${JSON.stringify(c[1])}`)
    assert(c.length > 3 && orderedTail > 0, `no ordered tail retained (${c.length} messages, ${orderedTail} ordered)`)
    assert(indexOf(c, "q after compaction") === c.length - 1, "new prompt not last")
    return c.map((m) => m.role[0]).join("")
  })

  const T = await createSession()
  await refresh(T)
  await lib.editSystem(T, "T HEAD {{constructor}}\n{{opencode}}")
  const beforeT = records().length
  const tT = await send(T, "hello claude", CLAUDE)
  await check("seed for claude-mock = anthropic.txt (observed)", () => {
    const obs = observed(T)
    assert(providerPromptFile({ providerID: CLAUDE.providerID, apiID: CLAUDE.modelID }).file === "anthropic.txt", "rule")
    assert(obs.segments.prompt === prompt("anthropic.txt"), firstDiff(obs.segments.prompt, prompt("anthropic.txt")))
  })
  await check("{{opencode}} expands to opencode's whole default; unknown names stay literal", () => {
    const obs = observed(T)
    const [system] = systemOf(tT.last)
    const want = `T HEAD {{constructor}}\n${opencodeDefault(obs.segments)}`
    assert(system === want && system === obs.sent, firstDiff(system, want))
  })
  await check("title call untouched while system is rewritten", async () => {
    const title = await waitFor(() => records().slice(beforeT).find((r) => r.kind === "title"), 15_000, "title call")
    const system = systemOf(title)
    assert(system.length === 1 && system[0] === prompt("title.txt"), firstDiff(system[0] ?? "", prompt("title.txt")))
  })
  await check("canary tool is not offered to the model", () => {
    const tools = (tT.last.body.tools ?? []).map((t) => t.function?.name)
    assert(!tools.includes("weft_canary"), `tools: ${tools.join(", ")}`)
    return `${tools.length} tools offered`
  })

  const P = await createSession()
  for (const text of ["p1 oldest", "p2", "p3", "p4"]) await send(P, text)
  await refresh(P)
  const latestPage = { ...store.get(P).content, hasOlder: true }
  latestPage.messages = latestPage.messages.slice(-4)
  const paged = createLiberation({
    http: api,
    info: () => store.get(P).info,
    content: () => latestPage,
    directory: () => WORK,
    continueSession: async () => {},
  })
  await paged.insertAfter(P, withText(P, "p3", "user").info.id, "paged insert", "user")
  const tPaged = await send(P, "p5 newest")
  await check("insertAfter with older pages unloaded: earlier picks keep their place", () => {
    const c = convo(tPaged.last)
    const positions = ["p1 oldest", "p2", "p3", "paged insert", "p4", "p5 newest"].map((text) => c.findIndex((m) => m.text === text))
    assert(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), `positions ${positions.join(",")}`)
    return c.map((m) => m.role[0]).join("")
  })

  const M = await createSession()
  const splitParts = [
    { type: "text", text: "Look at src/parser.ts" },
    { type: "text", text: " and fix the overflow bug." },
  ]
  await turn(M, () => api.post(`/session/${M}/prompt_async`, { body: { ...promptBody(undefined), parts: splitParts } }))
  await refresh(M)
  const split = withText(M, "Look at src/parser.ts", "user")
  const [lead, edited] = split.parts.filter((p) => p.type === "text")
  const tSplit = await turn(M, () => lib.resendFrom(M, split.info.id, " and fix the underflow bug.", edited.id))
  await check("resendFrom: only the edited prose part changes, the others stay", async () => {
    await refresh(M)
    const texts = entries(M)
      .find((e) => e.info.id === split.info.id)
      .parts.filter((p) => p.type === "text")
      .map((p) => [p.id, p.text])
    const want = [
      [lead.id, "Look at src/parser.ts"],
      [edited.id, " and fix the underflow bug."],
    ]
    assert(JSON.stringify(texts) === JSON.stringify(want), JSON.stringify(texts))
    const c = convo(tSplit.last)
    assert(c[c.length - 1]?.text === "Look at src/parser.ts and fix the underflow bug.", JSON.stringify(c[c.length - 1]))
  })

  await send(M, "turn two")
  await send(M, "turn three")
  await refresh(M)
  const two = withText(M, "turn two", "user")
  const three = withText(M, "turn three", "user")
  const counted = deriveCloth({ session: store.get(M).info, messages: store.get(M).content.messages, parts: store.get(M).content.parts, seed: { file: "", text: "" } })
  await lib.removeMessage(M, two.info.id)
  await lib.removeMessage(M, three.info.id, true)
  await check("removeMessage: a user pick goes with its replies unless keepReplies", async () => {
    assert(counted.find((p) => p.id === two.info.id)?.replies === 1, `replies ${counted.find((p) => p.id === two.info.id)?.replies}`)
    await refresh(M)
    assert(!entries(M).some((e) => e.info.id === two.info.id || e.info.parentID === two.info.id), "turn two left a message behind")
    assert(!withText(M, "turn three", "user") && repliesTo(M, three.info.id).length === 1, "keepReplies did not keep the reply")
  })

  const V = await createSession()
  await send(V, "v1 kept")
  await send(V, "v2 undone")
  await refresh(V)
  const v2 = withText(V, "v2 undone", "user")
  const v2reply = repliesTo(V, v2.info.id)[0]
  await api.post(`/session/${V}/revert`, { body: { messageID: v2.info.id } })
  await refresh(V)
  const clothOf = (sessionID) => {
    const { info, content } = store.get(sessionID)
    return deriveCloth({ session: info, messages: content.messages, parts: content.parts, seed: { file: "", text: "" } }).slice(1)
  }
  const flags = (picks) => picks.map((p) => `${p.info.role[0]}${p.reverted ? "R" : ""}${p.live ? "L" : ""}`).join(" ")
  const storedIDs = () => entries(V).map((e) => e.info.id).join()
  const beforeRefusals = storedIDs()
  const refusals = []
  for (const run of [
    () => lib.insertAfter(V, v2reply.info.id, "note after an undone reply", "user"),
    () => lib.resendFrom(V, v2.info.id, "v2 again"),
    () => lib.regenerate(V, v2reply.info.id),
  ])
    refusals.push(await run().then(() => "ran", (error) => error.message))
  await check("revert: picks from the revert point are reverted, not live", () => {
    assert(store.get(V).info.revert?.messageID === v2.info.id, `revert ${JSON.stringify(store.get(V).info.revert)}`)
    assert(flags(clothOf(V)) === "u a uR aR", flags(clothOf(V)))
  })
  await check("revert: insert, resend and regenerate refuse a reverted pick, storage untouched", async () => {
    assert(refusals.every((message) => message.includes("Unrevert")), refusals.join(" | "))
    await refresh(V)
    assert(storedIDs() === beforeRefusals && store.get(V).info.revert?.messageID === v2.info.id, "storage or revert changed")
  })
  await api.post(`/session/${V}/unrevert`)
  await check("unrevert: the picks are back in the cloth", async () => {
    await refresh(V)
    assert(!store.get(V).info.revert && flags(clothOf(V)) === "u a u a", flags(clothOf(V)))
  })

  const evilID = "ses_x\\..\\..\\canary"
  const canary = at("canary.json")
  writeFileSync(canary, "untouched")
  const now = Date.now()
  const evilExport = {
    info: {
      id: evilID,
      slug: "evil-canary",
      projectID: "global",
      directory: WORK,
      path: "",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      title: "shared session",
      version: "1.19.1",
      time: { created: now, updated: now },
    },
    messages: [],
  }
  writeFileSync(at("evil-export.json"), JSON.stringify(evilExport))
  const imported = spawnSync(EXE, ["import", at("evil-export.json")], { cwd: WORK, env: engineEnv(), encoding: "utf8", windowsHide: true, timeout: 120_000 })
  const evilPath = `/session/${encodeURIComponent(evilID)}`
  await check("plugin: a session id that is a path never reaches the file system", async () => {
    assert(imported.status === 0, `import exited ${imported.status}: ${imported.stderr || imported.stdout}`)
    assert((await api.get(evilPath)).data.id === evilID, "imported session not found")
    await send(evilID, "evil hello")
    await api.del(evilPath)
    await sleep(1_000)
    assert(readFileSync(canary, "utf8") === "untouched", "canary.json overwritten")
    assert(readdirSync(OBSERVED).every((name) => /^ses_[A-Za-z0-9]+\.json$/.test(name)), readdirSync(OBSERVED).join(", "))
  })

  await check("deleting a session removes its observed record", async () => {
    assert(existsSync(join(OBSERVED, `${T}.json`)), "no observed record to begin with")
    await api.del(`/session/${T}`)
    await waitFor(() => !existsSync(join(OBSERVED, `${T}.json`)), 10_000, "observed record removal")
  })

  await check("no npm install ran in any scanned config dir", () => {
    const installed = CONFIG_DIRS.filter((dir) => readdirSync(join(dir, "node_modules")).length > 0)
    assert(installed.length === 0, `installed into ${installed.join(", ")}`)
  })
}

function report() {
  const width = Math.max(...results.map((r) => r.name.length))
  console.log(`\n ${"#".padStart(2)}  RESULT  ${"CHECK".padEnd(width)}  DETAIL`)
  results.forEach((r, i) => console.log(` ${String(i + 1).padStart(2)}  ${r.ok ? "PASS  " : "FAIL  "}  ${r.name.padEnd(width)}  ${r.detail}`))
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ""}`)
  return failed
}

let failed = 1
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop().then(() => process.exit(130)))
try {
  prepare()
  await start()
  await scenario()
  failed = report()
} catch (error) {
  report()
  console.error(`\nFATAL: ${error.stack ?? error}`)
  if (existsSync(at("engine.log"))) console.error(readFileSync(at("engine.log"), "utf8").split("\n").slice(-30).join("\n"))
} finally {
  await stop()
}
process.exit(failed ? 1 : 0)
