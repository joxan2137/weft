#!/usr/bin/env node
// End-to-end check of liberation through the integrated UI (docs/DESIGN.md B.5). Starts
// tools/mock-provider.mjs, an isolated opencode 1.19.1 engine that loads plugin/weft-liberated.ts,
// Vite pointed at that engine and headless Edge; drives the real App with mouse and keys over the
// DevTools protocol (plain WebSocket, no extra deps) and asserts on the request the model received.
//
//   node tools/e2e-ui.mjs [--keep] [--shots]
//     --keep   leaves %TEMP%\weft-qa-wire for inspection
//     --shots  also writes .shots/e2e-ui-{knot,final,final-top}.png through tools/shoot.mjs
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readMeta, SEED_TAIL } from "../src/engine/liberate.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const EXE = join(ROOT, ".ref", "bin", "package", "bin", "opencode.exe")
const VITE_BIN = join(ROOT, "node_modules", "vite", "bin", "vite.js")
const PROMPTS = join(ROOT, "src", "assets", "prompts")
const SHOTS = join(ROOT, ".shots")
const TEMP = join(tmpdir(), "weft-qa-wire")
const PROFILE = join(tmpdir(), "es-qa")
const ENGINE_PORT = 48750
const MOCK_PORT = 48751
const VITE_PORT = 48752
const CDP_PORT = 48753
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const APP = `http://localhost:${VITE_PORT}/`
const CDP = `http://127.0.0.1:${CDP_PORT}`
const USER = "weft"
const PASSWORD = randomUUID()
const WIDTH = 1440
const HEIGHT = 900
const KEEP = process.argv.includes("--keep")
const WANT_SHOTS = process.argv.includes("--shots")
const EDGES = [  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
]

const at = (...names) => join(TEMP, ...names)
const WORK = at("w")
const OBSERVED = at("obs")
const LOG = at("mock.jsonl")
const prompt = (file) => readFileSync(join(PROMPTS, file), "utf8")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ───────── engine transport ─────────

function nodeHttp(base, user, password) {
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
  const call = async (method, path, opts = {}) => {
    const target = new URL(path, base)
    for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) target.searchParams.set(key, String(value))
    const headers = { authorization: auth }
    if (opts.directory) headers["x-opencode-directory"] = encodeURIComponent(opts.directory)
    if (opts.body !== undefined) headers["content-type"] = "application/json"
    const res = await fetch(target, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
    return { data: text ? JSON.parse(text) : undefined }
  }
  return { get: (path, opts) => call("GET", path, opts), post: (path, opts) => call("POST", path, opts) }
}

const api = nodeHttp(ENGINE, USER, PASSWORD)

// ───────── processes ─────────

const children = []
const logs = []

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
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ""}`)
}

const CONFIG_DIRS = [at("cfg"), at("c", "opencode")]

function prepare() {
  rmSync(TEMP, { recursive: true, force: true })
  rmSync(PROFILE, { recursive: true, force: true })
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
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    enabled_providers: ["mock"],
    model: "mock/mock-model",
    small_model: "mock/mock-model",
    permission: { bash: "ask" },
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `${MOCK}/v1`, apiKey: "mock-key" },
        models: { "mock-model": { name: "Mock model", tool_call: true, limit: { context: 100000, output: 4096 } } },
      },
    },
  }
  writeFileSync(at("cfg", "opencode.json"), JSON.stringify(config, null, 2))
  writeFileSync(join(WORK, "AGENTS.md"), "PROJECT RULES\nPrices like $& and $1 stay literal.\n")
  writeFileSync(join(WORK, "README.md"), "# e2e-ui workspace\n")
  if (spawnSync("git", ["init", "-q"], { cwd: WORK }).status !== 0) throw new Error("git init failed in the work dir")
}

function engineEnv() {
  const inherited = Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|WEFT_|VITE_)/i.test(key))
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

function launch(name, exe, args, opts) {
  const log = openSync(at(`${name}.log`), "w")
  logs.push(log)
  const child = spawn(exe, args, { stdio: ["ignore", log, log], windowsHide: true, ...opts })
  child.label = name
  children.push(child)
  return child
}

async function start() {
  for (const port of [ENGINE_PORT, MOCK_PORT, VITE_PORT, CDP_PORT]) if (!(await portFree(port))) throw new Error(`port ${port} is in use`)
  launch("mock", process.execPath, [join(ROOT, "tools", "mock-provider.mjs"), "--port", String(MOCK_PORT), "--log", LOG], {})
  await waitFor(() => fetch(`${MOCK}/mock/requests`).then((r) => r.ok), 10_000, "mock provider")

  launch("engine", EXE, ["serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1", "--print-logs"], { cwd: WORK, env: engineEnv() })
  // A request that reaches opencode 1.19.1 right as it starts listening can hang forever: probe with a timeout.
  await waitFor(async () => (await api.get("/global/health", { signal: AbortSignal.timeout(2_000) })).data?.healthy, 60_000, "engine health")

  const viteEnv = {
    ...process.env,
    VITE_ENGINE_URL: ENGINE,
    VITE_ENGINE_USER: USER,
    VITE_ENGINE_PASSWORD: PASSWORD,
    VITE_OBSERVED_DIR: OBSERVED,
  }
  launch("vite", process.execPath, [VITE_BIN, "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, env: viteEnv })
  await waitFor(() => fetch(`http://127.0.0.1:${VITE_PORT}/`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok), 60_000, "vite")

  const edge = EDGES.find(existsSync)
  if (!edge) throw new Error("msedge.exe not found")
  launch("edge", edge, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ], {})
  await waitFor(() => fetch(`${CDP}/json/version`).then((r) => r.ok), 20_000, "edge devtools")
}

async function stop() {
  page?.close()
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise((done) => child.once("exit", done))
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    await Promise.race([exited, sleep(5_000)])
  }
  for (const log of logs) closeSync(log)
  const dirs = KEEP ? [PROFILE] : [PROFILE, TEMP]
  for (const dir of dirs)
    for (let attempt = 0; attempt < 20 && existsSync(dir); attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        await sleep(250)
      }
    }
}

// ───────── DevTools protocol over a plain WebSocket ─────────

let page
const pageErrors = []

async function attach() {
  const target = await waitFor(
    async () => (await (await fetch(`${CDP}/json/list`)).json()).find((t) => t.type === "page"),
    10_000,
    "a page target",
  )
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((open, fail) => {
    socket.onopen = open
    socket.onerror = () => fail(new Error("devtools socket failed"))
  })
  let seq = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) call.fail(new Error(`${call.method}: ${message.error.message}`))
      else call.done(message.result)
    } else if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      pageErrors.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`)
    }
  }
  page = {
    send: (method, params = {}) =>
      new Promise((done, fail) => {
        const id = ++seq
        pending.set(id, { done, fail, method })
        socket.send(JSON.stringify({ id, method, params }))
      }),
    close: () => socket.close(),
  }
  await page.send("Page.enable")
  await page.send("Runtime.enable")
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS })
}

/** In-page lookups: the open project, picks by their visible text, and a point to press on for an element. */
const PAGE_HELPERS = `
window.__qa = {
  project: () => document.querySelector(".book .project")?.title.replace(/: open another project$/, ""),
  picks: () => [...document.querySelectorAll("article.pick")],
  pick: (text) => window.__qa.picks().find((a) => (a.querySelector(".pick-body")?.textContent ?? "").includes(text)),
  point: (el) => {
    if (!el) return null
    el.scrollIntoView({ block: "center" })
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: Math.round(r.left + Math.min(r.width / 2, 24)), y: Math.round(r.top + r.height / 2) }
  },
}`

/** What a failed run prints about the page. */
const PAGE_STATE = `JSON.stringify({
  fell: document.querySelector(".fell-input")?.value,
  picks: window.__qa?.picks().map((a) => a.dataset.role + (a.classList.contains("live") ? "*" : "") + ":" + a.querySelector(".pick-body")?.textContent.slice(0, 30)),
  dialog: document.querySelector("[role=dialog]")?.textContent.slice(0, 80),
  toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent),
  notice: document.querySelector(".notice-band")?.textContent,
})`

async function evaluate(expression) {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(`page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
  return result.value
}

const until = (expression, ms, label) => waitFor(() => evaluate(expression), ms, label)

async function pointer(type, x, y, clickCount = 0) {
  await page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount })
}

/** Presses on the element `expression` finds; `count` 2 is a real double-click (dblclick fires). */
async function click(expression, label, count = 1) {
  const point = await evaluate(`window.__qa.point(${expression})`)
  if (!point) throw new Error(`nothing to click: ${label}`)
  await pointer("mouseMoved", point.x, point.y)
  for (let n = 1; n <= count; n++) {
    await pointer("mousePressed", point.x, point.y, n)
    await pointer("mouseReleased", point.x, point.y, n)
  }
}

const KEY_CODES = { Enter: 13, Escape: 27 }

async function press(key, { ctrl = false, shift = false } = {}) {
  const code = KEY_CODES[key]
  const event = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0) }
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event })
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event })
}

/** Selects everything in the field and types `text` over it (input events fire as for a user). */
async function retype(expression, text) {
  const found = await evaluate(`(() => { const el = ${expression}; if (!el) return false; el.focus(); el.select(); return true })()`)
  if (!found) throw new Error(`no field: ${expression}`)
  await page.send("Input.insertText", { text })
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
    .map((m) => ({ role: m.role, text: contentText(m.content), reasoning: m.reasoning_content, calls: m.tool_calls?.map((c) => c.function.name) }))

const indexOf = (messages, text) => messages.findIndex((m) => m.text.includes(text))
const shape = (messages) => messages.map((m) => `${m.role}:${m.calls ? `[${m.calls.join(",")}]` : JSON.stringify(m.text.slice(0, 40))}`).join(" ")

const observed = (sessionID) => JSON.parse(readFileSync(join(OBSERVED, `${sessionID}.json`), "utf8"))

/** Independent re-statement of the plugin's join: lines holding only an empty placeholder vanish. */
function expected(template, segments) {
  const values = {
    prompt: segments.prompt,
    environment: segments.environment,
    references: segments.references,
    instructions: segments.instructions,
    mcp: segments.mcp,
    skills: segments.skills,
    structured_output: segments.structuredOutput,
    client_system: segments.clientSystem,
    opencode: ["prompt", "environment", "references", "instructions", "mcp", "skills", "structuredOutput", "clientSystem"]
      .map((key) => segments[key])
      .filter(Boolean)
      .join("\n"),
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

function firstDiff(got, want) {
  let i = 0
  while (i < got.length && got[i] === want[i]) i++
  return `differs at ${i}: got ${JSON.stringify(got.slice(i, i + 50))}, want ${JSON.stringify(want.slice(i, i + 50))}`
}

// ───────── engine-side probes ─────────

const script = (replies) => fetch(`${MOCK}/mock/script`, { method: "POST", body: JSON.stringify(replies) })

async function settled(sessionID) {
  const status = (await api.get("/session/status", { directory: WORK })).data[sessionID]
  if (status && status.type !== "idle") return false
  const { data } = await api.get(`/session/${sessionID}/message`, { query: { limit: 1 } })
  const last = data[data.length - 1]?.info
  return last?.role === "assistant" && last.time.completed !== undefined
}

async function turnAfter(sessionID, before) {
  await waitFor(() => records().slice(before).some((r) => r.kind === "main"), 30_000, "a model call")
  await waitFor(() => settled(sessionID), 60_000, `session ${sessionID} to settle`)
  const mains = records()
    .slice(before)
    .filter((r) => r.kind === "main")
  return { mains, last: mains[mains.length - 1] }
}

const metaOf = async (sessionID) => readMeta((await api.get(`/session/${sessionID}`)).data)

async function messages(sessionID) {
  const { data } = await api.get(`/session/${sessionID}/message`)
  return data
}

const storedWith = (list, text, role) =>
  list.find((m) => (!role || m.info.role === role) && m.parts.some((p) => p.type === "text" && p.text.includes(text)))

// ───────── UI gestures ─────────

const js = JSON.stringify
const pickExpr = (text) => `window.__qa.pick(${js(text)})`

async function sendFromFell(text) {
  const before = records().length
  await click(`document.querySelector(".fell-input")`, "the fell")
  await page.send("Input.insertText", { text })
  await press("Enter")
  return before
}

async function openMenu(text) {
  await click(`${pickExpr(text)}?.querySelector('.pick-tools button[title="More"]')`, `More on "${text}"`)
  await until(`!!document.querySelector(".pick-menu")`, 5_000, "the pick menu")
}

async function fromMenu(text, item) {
  await openMenu(text)
  await click(`[...document.querySelectorAll(".pick-menu .menu-item")].find((b) => b.textContent.startsWith(${js(item)}))`, `${item} on "${text}"`)
}

/** Pick actions that delete stored messages ask first; presses the dialog's confirm button. */
async function confirmCut(label) {
  await until(`!!document.querySelector(".dialog.confirm")`, 5_000, `the "${label}" confirmation`)
  await click(`[...document.querySelectorAll(".dialog.confirm .btn.danger")].find((b) => b.textContent.includes(${js(label)}))`, label)
}

function shoot(name, query) {
  if (!WANT_SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const out = join(SHOTS, `e2e-ui-${name}.png`)
  spawnSync(process.execPath, [join(ROOT, "tools", "shoot.mjs"), `${APP}?${query}`, out, String(WIDTH), String(HEIGHT), "9000"], { stdio: "ignore" })
  shots.push(out)
}

// ───────── checks ─────────

const results = []
const shots = []

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

const ALPHA = "Alpha answer, streamed in two halves."
const ALPHA_HALF = ALPHA.slice(0, Math.ceil(ALPHA.length / 2))
const EDITED = "alpha question, edited in the UI"
const INSERTED = "inserted through the pick menu"
const MARKER = "weft-ui-ok"

async function scenario() {
  await page.send("Page.navigate", { url: APP })
  await check("boot: the boot screen hands over only once the project is open", async () => {
    await until(`!document.querySelector(".boot") && !!document.querySelector(".new-session")`, 30_000, "the loom")
    const directory = await evaluate(`window.__qa.project()`)
    assert(directory, "loom shown with no project yet: New session would open the project picker")
    assert(resolve(directory).toLowerCase() === resolve(WORK).toLowerCase(), `project ${directory}`)
    return directory
  })
  await until(`window.__qa.project()`, 30_000, "the project")

  await click(`document.querySelector(".new-session")`, "new session")
  const S = await waitFor(async () => (await api.get("/session", { directory: WORK })).data[0]?.id, 10_000, "a session")
  await check("new session: pick 00 (warp) on the loom, plugin detected", async () => {
    await until(`!!document.querySelector('article.pick.warp[data-pick="0"]')`, 10_000, "pick 00")
    await sleep(500)
    assert(!(await evaluate(`!!document.querySelector(".liberation-banner")`)), "'plugin not loaded' banner shown")
    return S
  })

  await script([{ reasoning: "chain alpha", text: ALPHA, delayMs: 3_000 }])
  const tAlpha = await sendFromFell("alpha question")
  await check("stream: first half shown on a live pick before the rest arrives", async () => {
    await until(
      `(() => { const a = window.__qa.pick(${js(ALPHA_HALF)}); return !!a && a.classList.contains("live") && !a.textContent.includes(${js(ALPHA)}) })()`,
      15_000,
      "the first streamed half",
    )
  })
  await turnAfter(S, tAlpha)
  await check("stream: full reply settles, composer cleared", async () => {
    await until(`!!window.__qa.pick(${js(ALPHA)}) && !document.querySelector("article.pick.live")`, 10_000, "the full reply")
    assert((await evaluate(`document.querySelector(".fell-input").value`)) === "", "composer not cleared")
  })

  await script([{ tool: { name: "bash", arguments: { command: `echo ${MARKER}`, description: "Print a marker" } } }, { text: "Bravo done." }])
  const tBravo = await sendFromFell("bravo run a command")
  await check("permission: bash ask shows the Knot with the command", async () => {
    await until(`!!document.querySelector("section.knot")`, 20_000, "the Knot")
    const what = await evaluate(`document.querySelector("section.knot .knot-what")?.textContent`)
    assert(what === `echo ${MARKER}`, `knot shows ${js(what)}`)
    return what
  })
  shoot("knot", `open=${S}`)
  await click(`[...document.querySelectorAll("section.knot .btn")].find((b) => b.textContent.includes("Allow once"))`, "Allow once")
  await check("permission: Allow once unties the Knot and the turn finishes", async () => {
    await until(`!document.querySelector("section.knot")`, 10_000, "the Knot to go")
    await turnAfter(S, tBravo)
    const tool = (await messages(S)).flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash")
    assert(tool?.state.status === "completed" && tool.state.output.includes(MARKER), `bash ${tool?.state.status}: ${tool?.state.output ?? tool?.state.error}`)
    const toolMessage = convo(records().filter((r) => r.kind === "main").at(-1)).find((m) => m.role === "tool")
    assert(toolMessage?.text.includes(MARKER), "tool result not sent to the model")
  })
  await check("tool card: completed bash Brocade with its description", async () => {
    await until(`!!document.querySelector('.brocade.tool-bash[data-status="completed"]') && !!window.__qa.pick("Bravo done.")`, 10_000, "the bash card")
    const head = await evaluate(`document.querySelector(".brocade.tool-bash .brocade-head").textContent`)
    assert(head.includes("Print a marker"), `card head ${js(head)}`)
  })

  // 1. Double-click the user pick, retype it, re-voice it as assistant, save.
  const stored = await messages(S)
  const alphaUser = storedWith(stored, "alpha question", "user")
  const alphaReply = storedWith(stored, ALPHA, "assistant")
  const bravoDone = storedWith(stored, "Bravo done.", "assistant")
  await click(`${pickExpr("alpha question")}?.querySelector("[data-part] .prose")`, "the user pick", 2)
  await check("edit: double-click opens the editor on the part's text", async () => {
    const value = await until(`document.querySelector("article.pick.editing textarea.editor-text")?.value`, 5_000, "the editor")
    assert(value === "alpha question", `editor holds ${js(value)}`)
  })
  await retype(`document.querySelector("article.pick.editing textarea.editor-text")`, EDITED)
  await click(`document.querySelector('article.pick.editing .spools .spool[data-role="assistant"]')`, "assistant spool")
  await click(`[...document.querySelectorAll("article.pick.editing .editor-actions .btn.primary")].find((b) => b.textContent.startsWith("Save"))`, "Save")
  await check("edit: saved pick shows the new text, the assistant role and a mend", async () => {
    await until(`!document.querySelector("article.pick.editing") && window.__qa.pick(${js(EDITED)})?.dataset.role === "assistant"`, 10_000, "the re-voiced pick")
    assert(await evaluate(`!!window.__qa.pick(${js(EDITED)}).querySelector(".darn")`), "no mended mark")
    const meta = await waitFor(async () => {
      const m = await metaOf(S)
      return m.roles?.[alphaUser.info.id] === "assistant" && m.mends?.[alphaUser.info.id]?.length ? m : undefined
    }, 10_000, "stored role and mend")
    const mends = meta.mends[alphaUser.info.id]
    assert(mends.length === 1 && mends[0].text === "alpha question" && mends[0].role === "user", `mends ${js(mends)}`)
  })

  // 2. Restring the warp: double-click pick 00, wrap the seeded template, save with Ctrl+Enter.
  await click(`document.querySelector('article.pick.warp[data-pick="0"] .pick-body')`, "pick 00", 2)
  const seeded = `${prompt("default.txt")}\n${SEED_TAIL}`
  const original = await until(`document.querySelector("article.pick.warp.editing textarea.editor-text")?.value`, 5_000, "the warp editor")
  await check("warp: editor starts from default.txt + the placeholder tail", () => {
    assert(original === seeded, firstDiff(original, seeded))
    return `${original.length} chars`
  })
  const template = `WEFT-UI HEAD $& {{constructor}}\n${original}\nWEFT-UI TAIL {{opencode}}`
  await retype(`document.querySelector("article.pick.warp.editing textarea.editor-text")`, template)
  await press("Enter", { ctrl: true })
  await check("warp: saved template stored verbatim", async () => {
    await until(`!document.querySelector("article.pick.editing")`, 5_000, "the editor to close")
    const meta = await waitFor(async () => {
      const m = await metaOf(S)
      return m.system ? m : undefined
    }, 10_000, "stored system")
    assert(meta.system.text === template, firstDiff(meta.system.text, template))
  })

  // 3. Mute the last reply through the pick menu.
  await fromMenu("Bravo done.", "Mute")
  await check("mute: pick dimmed with the muted label, stored", async () => {
    await until(`!!window.__qa.pick("Bravo done.")?.classList.contains("muted") && !!window.__qa.pick("Bravo done.").querySelector(".muted-label")`, 10_000, "the muted pick")
    await waitFor(async () => (await metaOf(S)).muted?.[bravoDone.info.id], 10_000, "stored mute")
  })

  // 4. Insert a user pick after the first reply through the pick menu.
  await openMenu(ALPHA)
  await click(`document.querySelector('.pick-menu .spool.mini[data-role="user"]')`, "Insert after: user")
  await until(`!!document.querySelector(".pick-insert textarea.editor-text")`, 5_000, "the insert editor")
  await retype(`document.querySelector(".pick-insert textarea.editor-text")`, INSERTED)
  await click(`[...document.querySelectorAll(".pick-insert .btn.primary")].find((b) => b.textContent.startsWith("Insert"))`, "Insert")
  await check("insert: new user pick right after its anchor", async () => {
    await until(
      `(() => { const picks = window.__qa.picks(); const i = picks.indexOf(window.__qa.pick(${js(ALPHA)})); return i >= 0 && picks[i + 1]?.dataset.role === "user" && picks[i + 1].textContent.includes(${js(INSERTED)}) })()`,
      10_000,
      "the inserted pick",
    )
    await waitFor(async () => storedWith(await messages(S), INSERTED, "user"), 10_000, "the stored insert")
  })

  // 5. Send again and read what the model received.
  await script([{ text: "Charlie reply." }])
  const tCharlie = await sendFromFell("charlie final prompt")
  const { last } = await turnAfter(S, tCharlie)
  await until(`!!window.__qa.pick("Charlie reply.")`, 10_000, "the last reply")
  const wire = convo(last)

  await check("wire: pick 00 rewrite sent byte-exact, placeholders expanded", () => {
    const obs = observed(S)
    const system = systemOf(last)
    assert(system.length === 1, `${system.length} system messages`)
    assert(obs.rewritten && obs.exact && system[0] === obs.sent, `observed rewritten=${obs.rewritten} exact=${obs.exact}`)
    const want = expected(template, obs.segments)
    assert(system[0] === want, firstDiff(system[0], want))
    assert(system[0].startsWith(`WEFT-UI HEAD $& {{constructor}}\n${prompt("default.txt")}\n`), "head or prompt wrong")
    assert(obs.segments.instructions.includes("PROJECT RULES") && system[0].includes(obs.segments.instructions), "{{instructions}} not expanded")
    return `${system[0].length} chars`
  })
  await check("wire: edited user pick sent as assistant with the new text", () => {
    const m = wire.find((x) => x.text === EDITED)
    assert(m?.role === "assistant", `sent as ${m?.role}`)
    assert(!wire.some((x) => x.text === "alpha question"), "original text still sent")
  })
  await check("wire: muted pick left out", () => {
    assert(indexOf(wire, "Bravo done.") < 0, "muted reply still sent")
  })
  await check("wire: inserted pick follows its anchor as user", () => {
    const i = indexOf(wire, INSERTED)
    assert(i === indexOf(wire, ALPHA) + 1 && wire[i].role === "user" && wire[i].text === INSERTED, shape(wire))
  })
  await check("wire: whole conversation in cloth order", () => {
    const want = [
      (m) => m.role === "assistant" && m.text === EDITED,
      (m) => m.role === "assistant" && m.text === ALPHA,
      (m) => m.role === "user" && m.text === INSERTED,
      (m) => m.role === "user" && m.text === "bravo run a command",
      (m) => m.role === "assistant" && m.calls?.join() === "bash",
      (m) => m.role === "tool" && m.text.includes(MARKER),
      (m) => m.role === "user" && m.text === "charlie final prompt",
    ]
    assert(wire.length === want.length && want.every((ok, i) => ok(wire[i])), shape(wire))
    return wire.map((m) => m.role[0]).join("")
  })
  await check("storage: edits kept as metadata, originals untouched", async () => {
    const list = await messages(S)
    const meta = await metaOf(S)
    assert(storedWith(list, EDITED, "user")?.info.id === alphaUser.info.id, "edited text not stored on the user message")
    assert(storedWith(list, "Bravo done.", "assistant"), "muted reply deleted")
    const inserted = storedWith(list, INSERTED, "user")
    assert(meta.order?.[inserted.info.id] > meta.order?.[alphaReply.info.id], `order ${js(meta.order)}`)
  })
  shoot("final", `open=${S}`)
  shoot("final-top", `open=${S}&top`)

  // ───── second pass: the remaining pick operations, each through the UI ─────

  // 6. Unmute, turn the reverse over and rethink the reasoning, move the inserted pick up; send.
  await fromMenu("Bravo done.", "Unmute")
  await until(`!window.__qa.pick("Bravo done.").classList.contains("muted")`, 10_000, "the unmuted pick")
  const reasoning = alphaReply.parts.find((p) => p.type === "reasoning")
  await click(`${pickExpr(ALPHA)}?.querySelector(".reverse-tab")`, "the reverse tab")
  await until(`!!${pickExpr(ALPHA)}?.querySelector(".reverse.open")`, 5_000, "the open reverse")
  await click(`${pickExpr(ALPHA)}?.querySelector(".reverse-body")`, "the reasoning", 2)
  await check("reasoning: double-click on the turned reverse edits the reasoning part", async () => {
    const value = await until(`document.querySelector("article.pick.editing textarea.editor-text")?.value`, 5_000, "the editor")
    const hint = await evaluate(`document.querySelector("article.pick.editing .editor-hint").textContent`)
    assert(value === "chain alpha" && hint.includes("reasoning"), `editor ${js(value)} · ${hint}`)
  })
  await retype(`document.querySelector("article.pick.editing textarea.editor-text")`, "chain alpha, rethought")
  await click(`[...document.querySelectorAll("article.pick.editing .editor-actions .btn.primary")].find((b) => b.textContent.startsWith("Save"))`, "Save")
  await until(`!document.querySelector("article.pick.editing")`, 5_000, "the editor to close")
  await waitFor(async () => (await metaOf(S)).thought?.[reasoning.id], 10_000, "stored thought")
  await fromMenu(INSERTED, "Move up")
  await check("move: Move up puts the inserted pick before its anchor", async () => {
    await until(
      `(() => { const picks = window.__qa.picks(); const i = picks.indexOf(window.__qa.pick(${js(INSERTED)})); return i > 0 && picks[i + 1] === window.__qa.pick(${js(ALPHA)}) })()`,
      10_000,
      "the moved pick",
    )
  })
  await script([{ text: "Delta reply." }])
  const tDelta = await sendFromFell("delta prompt")
  const delta = convo((await turnAfter(S, tDelta)).last)
  await check("wire: unmuted, rethought and moved picks as edited", () => {
    const thought = delta.find((m) => m.text.includes(ALPHA))
    assert(thought?.role === "assistant" && thought.text.includes("<thinking>\nchain alpha, rethought\n</thinking>"), js(thought))
    assert(!thought.reasoning, `reasoning_content ${js(thought.reasoning)}`)
    const want = [
      (m) => m.role === "assistant" && m.text === EDITED,
      (m) => m.role === "user" && m.text === INSERTED,
      (m) => m === thought,
      (m) => m.role === "user" && m.text === "bravo run a command",
      (m) => m.role === "assistant" && m.calls?.join() === "bash",
      (m) => m.role === "tool" && m.text.includes(MARKER),
      (m) => m.role === "assistant" && m.text === "Bravo done.",
      (m) => m.role === "user" && m.text === "charlie final prompt",
      (m) => m.role === "assistant" && m.text === "Charlie reply.",
      (m) => m.role === "user" && m.text === "delta prompt",
    ]
    assert(delta.length === want.length && want.every((ok, i) => ok(delta[i])), shape(delta))
    return delta.map((m) => m.role[0]).join("")
  })

  // 7. Delete the inserted pick with the scissors, then 8. Save and resend the second prompt.
  await until(`!!window.__qa.pick("Delta reply.")`, 10_000, "the delta reply")
  await click(`${pickExpr(INSERTED)}?.querySelector('.pick-tools button[title="Delete"]')`, "Delete")
  await confirmCut("Delete message")
  await check("delete: scissors remove the pick from the cloth and storage", async () => {
    await until(`!window.__qa.pick(${js(INSERTED)})`, 10_000, "the pick to go")
    await waitFor(async () => !storedWith(await messages(S), INSERTED), 10_000, "the stored message to go")
  })
  const RESENT = "bravo, resent from the editor"
  await click(`${pickExpr("bravo run a command")}?.querySelector("[data-part] .prose")`, "the bravo pick", 2)
  await until(`document.querySelector("article.pick.editing textarea.editor-text")?.value === "bravo run a command"`, 5_000, "the bravo editor")
  await retype(`document.querySelector("article.pick.editing textarea.editor-text")`, RESENT)
  await script([{ text: "Resent reply." }])
  const tResend = records().length
  await click(`[...document.querySelectorAll("article.pick.editing .editor-actions .btn")].find((b) => b.textContent.startsWith("Save and resend"))`, "Save and resend")
  await confirmCut("Delete and resend")
  const resent = convo((await turnAfter(S, tResend)).last)
  await check("resend: later picks cut, edited prompt answered", async () => {
    await until(`!!window.__qa.pick("Resent reply.") && !window.__qa.pick("Charlie reply.") && !window.__qa.pick("Bravo done.")`, 10_000, "the resent cloth")
    const want = [
      (m) => m.role === "assistant" && m.text === EDITED,
      (m) => m.role === "assistant" && m.text.includes(ALPHA),
      (m) => m.role === "user" && m.text === RESENT,
    ]
    assert(resent.length === want.length && want.every((ok, i) => ok(resent[i])), shape(resent))
    const list = await messages(S)
    assert(!storedWith(list, "delta prompt") && !storedWith(list, "Charlie reply.") && !list.some((m) => m.parts.some((p) => p.type === "tool")), "later messages still stored")
    return resent.map((m) => m.role[0]).join("")
  })

  // 9. Regenerate the answer from the pick menu.
  await script([{ text: "Regenerated reply." }])
  const tRegen = records().length
  await fromMenu("Resent reply.", "Regenerate")
  const regenerated = convo((await turnAfter(S, tRegen)).last)
  await check("regenerate: reply replaced, same context sent again", async () => {
    await until(`!!window.__qa.pick("Regenerated reply.") && !window.__qa.pick("Resent reply.")`, 10_000, "the regenerated reply")
    assert(shape(regenerated) === shape(resent), `${shape(regenerated)} vs ${shape(resent)}`)
    assert(!storedWith(await messages(S), "Resent reply."), "old reply still stored")
  })

  // 10. Fork from the last pick: the fork opens and keeps every edit on the wire.
  await click(`${pickExpr("Regenerated reply.")}?.querySelector('.pick-tools button[title="Fork from here"]')`, "Fork from here")
  const F = await waitFor(
    async () => (await api.get("/session", { directory: WORK })).data.find((s) => s.id !== S)?.id,
    10_000,
    "the fork",
  )
  await until(
    `Object.keys(localStorage).some((k) => k.startsWith("weft.lastSession.") && localStorage.getItem(k) === ${js(F)}) && !!window.__qa.pick("Regenerated reply.")`,
    10_000,
    "the fork on the loom",
  )
  await script([{ text: "Fork reply." }])
  const tFork = await sendFromFell("echo prompt in the fork")
  const forked = await turnAfter(F, tFork)
  await check("fork: opened from the pick menu, edits carried to the fork's wire", async () => {
    await until(`!!window.__qa.pick("Fork reply.")`, 10_000, "the fork reply")
    const c = convo(forked.last)
    const want = [
      (m) => m.role === "assistant" && m.text === EDITED,
      (m) => m.role === "assistant" && m.text.includes("<thinking>\nchain alpha, rethought\n</thinking>"),
      (m) => m.role === "user" && m.text === RESENT,
      (m) => m.role === "assistant" && m.text === "Regenerated reply.",
      (m) => m.role === "user" && m.text === "echo prompt in the fork",
    ]
    assert(c.length === want.length && want.every((ok, i) => ok(c[i])), shape(c))
    const [system] = systemOf(forked.last)
    assert(system === expected(template, observed(F).segments), "fork system is not the rewritten template")
    return F
  })

  // 11. Restore pick 00 to opencode's default in the fork.
  await click(`document.querySelector('article.pick.warp[data-pick="0"] .pick-body')`, "pick 00", 2)
  await click(
    `[...document.querySelectorAll("article.pick.warp.editing .editor-actions .btn")].find((b) => b.textContent.includes("Restore the default"))`,
    "Restore the default",
  )
  await waitFor(async () => !(await metaOf(F)).system, 10_000, "the rewrite to be dropped")
  await script([{ text: "Default reply." }])
  const tDefault = await sendFromFell("back to the default prompt")
  const restored = await turnAfter(F, tDefault)
  await check("warp: Restore default sends opencode's own system prompt again", async () => {
    const obs = observed(F)
    const [system, ...more] = systemOf(restored.last)
    assert(more.length === 0 && system === obs.sent && !obs.rewritten, `observed rewritten=${obs.rewritten}`)
    assert(!system.includes("WEFT-UI HEAD") && system.startsWith(prompt("default.txt")), firstDiff(system, prompt("default.txt")))
    const warp = await evaluate(`document.querySelector('article.pick.warp[data-pick="0"] .pick-body').textContent`)
    assert(!warp.includes("WEFT-UI HEAD"), "pick 00 still shows the rewrite")
  })

  // 12. Fork from a pick that has a later-stored pick inserted above it: the fork is the cloth up to it.
  const ABOVE = "inserted above the fork point"
  await openMenu(EDITED)
  await click(`document.querySelector('.pick-menu .spool.mini[data-role="user"]')`, "Insert after: user")
  await retype(`document.querySelector(".pick-insert textarea.editor-text")`, ABOVE)
  await click(`[...document.querySelectorAll(".pick-insert .btn.primary")].find((b) => b.textContent.startsWith("Insert"))`, "Insert")
  await until(`(() => { const picks = window.__qa.picks(); return picks[picks.indexOf(window.__qa.pick(${js(EDITED)})) + 1] === window.__qa.pick(${js(ABOVE)}) })()`, 10_000, "the pick above")
  await click(`${pickExpr(ALPHA)}?.querySelector('.pick-tools button[title="Fork from here"]')`, "Fork from here")
  const G = await waitFor(
    async () => (await api.get("/session", { directory: WORK })).data.find((s) => s.id !== S && s.id !== F)?.id,
    10_000,
    "the second fork",
  )
  await until(`Object.keys(localStorage).some((k) => k.startsWith("weft.lastSession.") && localStorage.getItem(k) === ${js(G)})`, 10_000, "the second fork on the loom")
  await check("fork from here: keeps exactly the picks at and above the pick, in cloth order", async () => {
    const picks = await until(
      `(() => { const picks = window.__qa.picks().filter((a) => !a.classList.contains("warp")).map((a) => a.querySelector(".pick-body").textContent); return picks.some((t) => t.includes(${js(ALPHA)})) && picks })()`,
      10_000,
      "the forked cloth",
    )
    const want = [EDITED, ABOVE, ALPHA]
    assert(picks.length === want.length && want.every((text, i) => picks[i].includes(text)), js(picks.map((t) => t.slice(0, 30))))
  })
  await script([{ text: "Second fork reply." }])
  const tSecond = await sendFromFell("prompt in the second fork")
  const second = convo((await turnAfter(G, tSecond)).last)
  await check("fork from here: the fork's wire matches its cloth", () => {
    const want = [
      (m) => m.role === "assistant" && m.text === EDITED,
      (m) => m.role === "user" && m.text === ABOVE,
      (m) => m.role === "assistant" && m.text.includes(ALPHA),
      (m) => m.role === "user" && m.text === "prompt in the second fork",
    ]
    assert(second.length === want.length && want.every((ok, i) => ok(second[i])), shape(second))
    return second.map((m) => m.role[0]).join("")
  })

  await check("page: no uncaught exceptions or console errors", () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
  })
}

function report() {
  const width = Math.max(...results.map((r) => r.name.length))
  console.log(`\n ${"#".padStart(2)}  RESULT  ${"CHECK".padEnd(width)}  DETAIL`)
  results.forEach((r, i) => console.log(` ${String(i + 1).padStart(2)}  ${r.ok ? "PASS  " : "FAIL  "}  ${r.name.padEnd(width)}  ${r.detail}`))
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ""}`)
  for (const shot of shots) console.log(`shot: ${shot}`)
  return failed
}

let failed = 1
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop().then(() => process.exit(130)))
try {
  prepare()
  await start()
  await attach()
  await scenario()
  failed = report()
} catch (error) {
  report()
  console.error(`\nFATAL: ${error.stack ?? error}`)
  if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join("\n  ")}`)
  for (const name of ["engine", "vite"])
    if (existsSync(at(`${name}.log`))) console.error(`--- ${name}.log (tail)\n${readFileSync(at(`${name}.log`), "utf8").split("\n").slice(-15).join("\n")}`)
} finally {
  await stop()
}
process.exit(failed ? 1 : 0)
