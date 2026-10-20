#!/usr/bin/env node
// End-to-end smoke test of the built app. Launches the release weft.exe itself (no Vite, no dev engine),
// lets it find, install and start its own engine on isolated opencode data with tools/mock-provider.mjs as
// the only model, attaches to its WebView2 over the DevTools protocol (plain WebSocket, no extra deps) and
// drives boot, a project, a session, a reply, an edit, the theme, Settings and a graceful close.
//
//   node tools/e2e-release.mjs [--exe <path>] [--keep]
//     --exe    the app to test; default: weft.exe in the release dir of the Cargo target folder. The
//              NSIS-installed Weft.exe works too.
//     --keep   leaves %TEMP%\weft-qa-release for inspection
//
// Screenshots land in .shots/release/. Close Weft first: its single-instance guard hands a second launch
// over to the open window. The engine comes from Weft's own engine folder, so a first run may download it.
// Prefix with tools/low.mjs to run the app and its engine at idle CPU priority.
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { values: args } = parseArgs({ options: { exe: { type: "string" }, keep: { type: "boolean", default: false } } })
const EXE = resolve(args.exe ?? join(cargoTarget(), "release", "weft.exe"))
const KEEP = args.keep
const TEMP = join(tmpdir(), "weft-qa-release")
const SHOTS = join(ROOT, ".shots", "release")
const TAURI = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"))
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
/** Tauri's app config dir, which the release app shares with real use: it holds the observed system prompts. */
const CONFIG_DIR = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), TAURI.identifier)
const MOCK_PORT = await freePort()
const CDP_PORT = await freePort()
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const CDP = `http://127.0.0.1:${CDP_PORT}`
const APP_ORIGIN = /^https?:\/\/tauri\.localhost(\/|$)/
const WEBVIEW = /^msedgewebview2\.exe$/i
const CANARY = "weft_canary"
const BOOT_TIMEOUT_MS = 10 * 60_000
const CDP_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 30_000
const SETTLE_MS = 700

const at = (...names) => join(TEMP, ...names)
const PROJECT = at("project")
const LOG = at("mock.jsonl")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const js = JSON.stringify

// Appended to wry's own WebView2 arguments: the DevTools port, and a page that keeps rendering while a
// full-screen window covers the app. wry's disabled features are repeated in case this list replaces them.
const BROWSER_ARGS = [
  `--remote-debugging-port=${CDP_PORT}`,
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
].join(" ")

function cargoTarget() {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR
  try {
    const local = readFileSync(join(ROOT, "src-tauri", ".cargo", "config.toml"), "utf8")
    const dir = /^\s*target-dir\s*=\s*"([^"]+)"/m.exec(local)?.[1]
    if (dir) return resolve(ROOT, "src-tauri", dir)
  } catch {}
  return join(ROOT, "src-tauri", "target")
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

function inside(path, dir) {
  const rel = relative(resolve(dir).toLowerCase(), resolve(path).toLowerCase())
  return !rel.startsWith("..") && !isAbsolute(rel)
}

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
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
    return { data: text ? JSON.parse(text) : undefined }
  }
  return { get: (path, opts) => call("GET", path, opts), post: (path, opts) => call("POST", path, opts) }
}

/** Set once the app reports its engine ready: the URL and credentials come from the app itself. */
let api
let engine

async function answers(url) {
  try {
    await fetch(new URL("/global/health", url), { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

// ───────── processes ─────────

const children = []
const logs = []
let weft
/** weft.exe's descendants, taken while it runs: the engine tree and WebView2. */
let tree = []

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

async function removeDir(dir) {
  for (let attempt = 0; attempt < 40 && existsSync(dir); attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      await sleep(250)
    }
  }
}

/**
 * The global opencode dir under the isolated XDG_CONFIG_HOME: the mock as the only provider. The app adds its
 * plugin through OPENCODE_CONFIG_CONTENT, which opencode merges over this file. The lockfile names the plugin
 * package, so the engine skips npm here.
 */
function writeEngineConfig() {
  const dir = at("config", "opencode")
  mkdirSync(join(dir, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "1.19.1" }
  writeFileSync(join(dir, "package.json"), js({ name: "weft-engine", private: true, dependencies }, null, 2))
  writeFileSync(
    join(dir, "package-lock.json"),
    js({ name: "weft-engine", lockfileVersion: 3, requires: true, packages: { "": { name: "weft-engine", dependencies } } }, null, 2),
  )
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    enabled_providers: ["mock"],
    model: "mock/mock-model",
    small_model: "mock/mock-model",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `${MOCK}/v1`, apiKey: "mock-key" },
        models: { "mock-model": { name: "Mock model", tool_call: true, limit: { context: 100000, output: 4096 } } },
      },
    },
  }
  writeFileSync(join(dir, "opencode.json"), js(config, null, 2))
}

async function prepare() {
  await removeDir(TEMP)
  if (existsSync(TEMP)) throw new Error(`${TEMP} is still in use: is an earlier run still going?`)
  await removeDir(SHOTS)
  for (const name of ["data", "cache", "state", "home", "tmp", "wv", "project"]) mkdirSync(at(name), { recursive: true })
  writeEngineConfig()
  writeFileSync(join(PROJECT, "README.md"), "# weft release smoke test\n")
  // Its own repo keeps the engine from resolving the folder to an enclosing one (the home folder may be a
  // repo); the origin gives it a project id of its own without a commit.
  for (const git of [["init", "-q"], ["remote", "add", "origin", "https://weft-qa.invalid/release-smoke.git"]])
    if (spawnSync("git", git, { cwd: PROJECT }).status !== 0) throw new Error(`git ${git[0]} failed in ${PROJECT}`)
}

/**
 * weft.exe passes its environment on to the engine: the XDG dirs isolate opencode's data, config, cache and
 * state (an inherited XDG_STATE_HOME wins over OpenCode Desktop's), and WebView2 gets its own profile, so the
 * DevTools port applies to a browser process of its own.
 */
function appEnv() {
  const inherited = Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|WEFT_|VITE_|WEBVIEW2_)/i.test(key))
  return {
    ...Object.fromEntries(inherited),
    WEFT_QA_BACKGROUND: "1",
    XDG_DATA_HOME: at("data"),
    XDG_CONFIG_HOME: at("config"),
    XDG_CACHE_HOME: at("cache"),
    XDG_STATE_HOME: at("state"),
    TEMP: at("tmp"),
    TMP: at("tmp"),
    OPENCODE_TEST_HOME: at("home"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    WEBVIEW2_USER_DATA_FOLDER: at("wv"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: BROWSER_ARGS,
  }
}

function launch(name, exe, args, opts) {
  const log = openSync(at(`${name}.log`), "w")
  logs.push(log)
  const child = spawn(exe, args, { stdio: ["ignore", log, log], windowsHide: true, ...opts })
  child.done = new Promise((done) => {
    child.once("exit", (code, signal) => done(code ?? signal))
    child.once("error", (error) => done(error.message))
  })
  children.push(child)
  return child
}

const exited = (child) => child.pid === undefined || child.exitCode !== null || child.signalCode !== null

async function start() {
  if (!existsSync(EXE)) throw new Error(`${EXE} not found: build it with npm run tauri build, or pass --exe`)
  // A second launch would hand over to the open Weft and bring it to the front.
  const open = processTable().filter((p) => /^weft\b.*\.exe$/i.test(p.name))
  if (open.length) throw new Error(`Weft is already running (${open.map((p) => `${p.name} ${p.pid}`).join(", ")}): close it first`)
  console.log(`# app: ${EXE} (built ${statSync(EXE).mtime.toISOString()})`)
  console.log(`# isolated data: ${TEMP}`)
  launch("mock", process.execPath, [join(ROOT, "tools", "mock-provider.mjs"), "--port", String(MOCK_PORT), "--log", LOG], {})
  await waitFor(() => fetch(`${MOCK}/mock/requests`).then((r) => r.ok), 10_000, "mock provider")
  weft = launch("weft", EXE, [], { cwd: TEMP, env: appEnv(), windowsHide: false })
  console.log(`# weft.exe pid ${weft.pid}, DevTools port ${CDP_PORT}, mock port ${MOCK_PORT}`)
}

const killTree = (pid) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })

const PROCESS_TABLE =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | " +
  "Select-Object ProcessId,ParentProcessId,Name,@{n='Created';e={[string]$_.CreationDate.Ticks}} | ConvertTo-Json -Compress"

/** Every process with its parent and start time; a PID alone may be reused once its process is gone. */
function processTable() {
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PROCESS_TABLE, "utf16le").toString("base64")], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 << 20,
  })
  if (out.status !== 0) throw new Error(`listing processes failed: ${out.stderr.trim().slice(0, 200)}`)
  return [JSON.parse(out.stdout)].flat().map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, created: p.Created || "0" }))
}

function descendants(table, pid) {
  const root = table.find((p) => p.pid === pid)
  if (!root) return []
  const found = []
  for (const queue = [root]; queue.length; ) {
    const parent = queue.shift()
    for (const p of table)
      if (p.ppid === parent.pid && p !== parent && !found.includes(p) && BigInt(p.created) >= BigInt(parent.created)) {
        found.push(p)
        queue.push(p)
      }
  }
  return found
}

function stillRunning(processes) {
  if (!processes.length) return []
  const table = processTable()
  return processes.filter((p) => table.some((q) => q.pid === p.pid && q.created === p.created))
}

let stopping
const stop = () => (stopping ??= halt())

async function halt() {
  page?.close()
  for (const child of children.reverse()) {
    if (exited(child)) continue
    killTree(child.pid)
    await Promise.race([child.done, sleep(5_000)])
  }
  try {
    for (const p of stillRunning(tree)) killTree(p.pid)
  } catch {}
  for (const log of logs) closeSync(log)
  forgetObserved()
  if (!KEEP) await removeDir(TEMP)
}

// ───────── DevTools protocol over a plain WebSocket ─────────

let page
let watching = true
const pageErrors = []
const networkErrors = []

/** A WebView2 that ignored WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS never opens the port. */
async function pageTarget(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (exited(weft))
      throw new Error(`weft.exe exited (${await weft.done}) before its page opened: is Weft already running? A second launch hands over to it`)
    try {
      const targets = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(2_000) })).json()
      const target = targets.find((t) => t.type === "page" && APP_ORIGIN.test(t.url))
      if (target) return target
    } catch {}
    await sleep(250)
  }
  throw new Error(`no tauri.localhost page on DevTools port ${CDP_PORT} within ${ms / 1000} s`)
}

function noteEvent({ method, params }) {
  if (method === "Runtime.exceptionThrown") {
    pageErrors.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`)
  } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
    pageErrors.push(`console.error: ${params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`)
  } else if (method === "Log.entryAdded" && params.entry.level === "error") {
    const { source, text, url } = params.entry
    ;(source === "network" ? networkErrors : pageErrors).push(`${source}: ${text}${url ? ` (${url})` : ""}`)
  }
}

async function attach() {
  const target = await pageTarget(60_000)
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
      if (!call) return
      if (message.error) call.fail(new Error(`${call.method}: ${message.error.message}`))
      else call.done(message.result)
    } else if (watching) noteEvent(message)
  }
  socket.onclose = () => {
    for (const call of pending.values()) call.fail(new Error(`${call.method}: the DevTools connection closed`))
  }
  page = {
    send: (method, params = {}, ms = CDP_TIMEOUT_MS) =>
      new Promise((done, fail) => {
        const id = ++seq
        const timer = setTimeout(() => pending.get(id)?.fail(new Error(`${method}: no answer within ${ms / 1000} s`)), ms)
        const settle = (finish) => (value) => {
          clearTimeout(timer)
          pending.delete(id)
          finish(value)
        }
        pending.set(id, { method, done: settle(done), fail: settle(fail) })
        socket.send(js({ id, method, params }))
      }),
    close: () => socket.close(),
  }
  await page.send("Page.enable")
  await page.send("Runtime.enable")
  await page.send("Log.enable")
  // The window may sit behind another one: the page still takes keys and focus as the front window would.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined)
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS })
  // One reload puts every script error since the first line on record; the engine keeps running in the app.
  await page.send("Page.reload", { ignoreCache: true })
  await waitFor(() => evaluate(`document.readyState === "complete" && !!window.__qa`), 30_000, "the reloaded page")
}

/** In-page lookups: the open project, picks by their visible text, the boot screen, a point to press on. */
const PAGE_HELPERS = `
window.__qa = {
  project: () => document.querySelector(".book .project")?.title.replace(/: open another project$/, ""),
  picks: () => [...document.querySelectorAll("article.pick")],
  pick: (text) => window.__qa.picks().find((a) => (a.querySelector(".pick-body")?.textContent ?? "").includes(text)),
  boot: () => {
    const boot = document.querySelector(".boot")
    if (!boot) return null
    const text = (selector) => boot.querySelector(selector)?.textContent.trim() || undefined
    return { status: text(".boot-status"), detail: text(".boot-detail"), failed: boot.classList.contains("failed") }
  },
  point: (el) => {
    if (!el) return null
    el.scrollIntoView({ block: "center" })
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: Math.round(r.left + Math.min(r.width / 2, 24)), y: Math.round(r.top + r.height / 2) }
  },
}`

async function evaluate(expression) {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(`page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
  return result.value
}

const until = (expression, ms, label) => waitFor(() => evaluate(expression), ms, label)

/** A Tauri command, called the way the app's own frontend calls it. */
const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${js(command)}, ${js(args)})`)

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

const KEYS = { Enter: ["Enter", 13], Escape: ["Escape", 27], ",": ["Comma", 188] }

async function press(key, { ctrl = false, shift = false } = {}) {
  const [code, virtual] = KEYS[key]
  const event = { key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0) }
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event })
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event })
}

/** Selects everything in the field and types `text` over it (input events fire as for a user). */
async function retype(expression, text) {
  const found = await evaluate(`(() => { const el = ${expression}; if (!el) return false; el.focus(); el.select(); return true })()`)
  if (!found) throw new Error(`no field: ${expression}`)
  await page.send("Input.insertText", { text })
}

/** Waits out the boot screen and prints the steps it shows; a first run downloads the engine. */
async function booted(ms) {
  const started = Date.now()
  let shown
  let phase
  let printedAt = 0
  while (Date.now() - started < ms) {
    if (exited(weft)) throw new Error(`weft.exe exited (${await weft.done}) while booting`)
    const boot = await evaluate(`window.__qa.boot()`).catch(() => undefined)
    if (boot === null && (await evaluate(`!!document.querySelector(".new-session")`).catch(() => false))) return Date.now() - started
    if (boot) {
      const line = boot.detail ? `${boot.status} (${boot.detail})` : boot.status
      const now = boot.status?.replace(/[\s·\d%]+$/, "")
      if (line !== shown && (now !== phase || Date.now() - printedAt > 5_000)) {
        console.log(`# boot ${Math.round((Date.now() - started) / 1000)} s: ${line}`)
        shown = line
        phase = now
        printedAt = Date.now()
      }
      if (boot.failed) throw new Error(`the engine did not start: ${boot.detail ?? boot.status}`)
    }
    await sleep(500)
  }
  throw new Error(`still on the boot screen after ${ms / 60_000} min (${shown})`)
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

const convo = (record) => record.body.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: contentText(m.content) }))

// ───────── engine-side probes ─────────

/** The project folder as the engine resolved it; every session call is scoped to it. */
let WORK

const script = (replies) => fetch(`${MOCK}/mock/script`, { method: "POST", body: js(replies) })

async function settled(sessionID) {
  const status = (await api.get("/session/status", { directory: WORK })).data[sessionID]
  if (status && status.type !== "idle") return false
  const { data } = await api.get(`/session/${sessionID}/message`, { directory: WORK, query: { limit: 1 } })
  const last = data[data.length - 1]?.info
  return last?.role === "assistant" && last.time.completed !== undefined
}

async function turnAfter(sessionID, before) {
  await waitFor(() => records().slice(before).some((r) => r.kind === "main"), 30_000, "a model call")
  await waitFor(() => settled(sessionID), 60_000, `session ${sessionID} to settle`)
  return records()
    .slice(before)
    .filter((r) => r.kind === "main")
    .at(-1)
}

async function messages(sessionID) {
  const { data } = await api.get(`/session/${sessionID}/message`, { directory: WORK })
  return data
}

const storedWith = (list, text, role) =>
  list.find((m) => (!role || m.info.role === role) && m.parts.some((p) => p.type === "text" && p.text.includes(text)))

const sessions = []

function forgetObserved() {
  for (const id of sessions) if (/^ses_[A-Za-z0-9]+$/.test(id)) rmSync(join(CONFIG_DIR, "observed", `${id}.json`), { force: true })
}

// ───────── UI gestures ─────────

const pickExpr = (text) => `window.__qa.pick(${js(text)})`

async function sendFromFell(text) {
  const before = records().length
  await click(`document.querySelector(".fell-input")`, "the fell")
  await page.send("Input.insertText", { text })
  await press("Enter")
  return before
}

const shots = []
const shotErrors = []

async function shoot(name) {
  try {
    mkdirSync(SHOTS, { recursive: true })
    const { data } = await page.send("Page.captureScreenshot", { format: "png" }, 15_000)
    const out = join(SHOTS, `${name}.png`)
    writeFileSync(out, Buffer.from(data, "base64"))
    shots.push(out)
  } catch (error) {
    shotErrors.push(`${name}: ${error.message}`)
  }
}

const shotOf = (theme) => (theme === "dark" ? "main-night" : "main-day")

// ───────── checks ─────────

const results = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function check(name, run) {
  try {
    const detail = await run()
    results.push({ name, ok: true, detail: detail ?? "" })
    console.log(`ok - ${name}${detail ? ` (${detail})` : ""}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
    console.log(`not ok - ${name}: ${error.message}`)
  }
}

/** Later checks need what the last one set up. */
function gate() {
  const last = results.at(-1)
  if (!last.ok) throw new Error(`cannot go on after "${last.name}"`)
}

const PROMPT = "release smoke question"
const REPLY = "Release smoke answer from the mock model."
const EDITED = "release smoke, edited in the app"

async function scenario() {
  await check("launch: the page is the bundled frontend on the tauri origin", async () => {
    const where = await evaluate(
      `({ href: location.href, tauri: "__TAURI_INTERNALS__" in window, shown: document.visibilityState, size: innerWidth + "x" + innerHeight })`,
    )
    assert(APP_ORIGIN.test(where.href), `page at ${where.href}`)
    assert(where.tauri, "no __TAURI_INTERNALS__: the page is not running inside Tauri")
    // WEFT_QA_BACKGROUND keeps the window off every screen and out of focus, so the run never covers a game.
    const window = { label: "main" }
    const [{ x, y }, focused] = await Promise.all(["outer_position", "is_focused"].map((query) => invoke(`plugin:window|${query}`, window)))
    assert(x <= -10_000, `the window sits at ${x},${y}: WEFT_QA_BACKGROUND did not take effect`)
    assert(!focused, "the window has the focus")
    assert(where.shown === "visible", `the page is ${where.shown}, so it may not render`)
    // Without its own profile the run would leave its project and theme in the real one.
    assert(existsSync(at("wv", "EBWebView")), "WebView2 ignored WEBVIEW2_USER_DATA_FOLDER and runs on the real profile")
    const status = await invoke("engine_status")
    assert(status?.state, "the engine_status command did not answer")
    const main = TAURI.app.windows.find((w) => w.label === "main")
    assert(where.size === `${main.width}x${main.height}`, `the page is ${where.size}, not the ${main.width}x${main.height} the window is set to`)
    return `${where.href} at ${x},${y}, page ${where.size}, ${TAURI.productName} ${VERSION}, engine ${status.state}`
  })
  gate()

  await check("boot: the boot screen hands over to the loom", async () => `${Math.round((await booted(BOOT_TIMEOUT_MS)) / 1000)} s`)
  gate()

  await check("engine: ready and healthy at the address the app reports", async () => {
    engine = await invoke("engine_status")
    assert(engine?.state === "ready", `engine_status is ${js(engine?.state)}${engine?.message ? `: ${engine.message}` : ""}`)
    api = nodeHttp(engine.url, engine.username, engine.password)
    const health = (await api.get("/global/health", { signal: AbortSignal.timeout(5_000) })).data
    assert(health?.healthy && health.version === engine.version, `health ${js(health)}`)
    await until(`!!document.querySelector(".book-foot .dot.ready")`, 10_000, "the ready dot in the sessions footer")
    return `opencode ${engine.version} at ${engine.url}${engine.notice ? `; ${engine.notice}` : ""}`
  })
  gate()

  await check("engine: on the isolated opencode dirs, with the mock provider", async () => {
    const paths = (await api.get("/path")).data
    assert(inside(paths.config, at("config")), `config dir ${paths.config}`)
    assert(inside(paths.state, at("state")), `state dir ${paths.state}: the inherited XDG_STATE_HOME did not win`)
    assert(inside(paths.home, at("home")), `home ${paths.home}`)
    const db = readdirSync(at("data", "opencode")).find((name) => /^opencode.*\.db$/.test(name))
    assert(db, "no opencode database under the isolated XDG_DATA_HOME")
    const config = (await api.get("/config")).data
    assert(config.model === "mock/mock-model", `model ${js(config.model)}: the isolated opencode.json was not read`)
    return `${db} in ${at("data", "opencode")}`
  })

  await check("project: opened from the project picker", async () => {
    // A folder the engine has served is a known project, listed by the picker ("Open folder…" is a native dialog).
    WORK = (await api.get("/project/current", { directory: PROJECT })).data.worktree
    assert(samePath(WORK, realpathSync.native(PROJECT)), `the engine resolved ${PROJECT} to ${WORK}`)
    // With no project chosen the app opens the picker itself; a click then would land on its scrim.
    if (!(await evaluate(`!!document.querySelector(".dialog.projects")`))) await click(`document.querySelector(".book .project")`, "the project button")
    await until(`!!document.querySelector(".dialog.projects")`, 5_000, "the project picker")
    const row = `[...document.querySelectorAll(".dialog.projects .project-row")].find((r) => r.querySelector(".row-sub")?.textContent === ${js(WORK)})`
    await until(`!!${row}`, 15_000, "the project in the picker")
    await sleep(SETTLE_MS)
    await click(row, "the project row")
    await until(`!document.querySelector(".dialog.projects")`, 5_000, "the picker to close")
    await until(`(window.__qa.project() ?? "").toLowerCase() === ${js(WORK.toLowerCase())}`, 15_000, "the project in the sessions pane")
    return WORK
  })
  gate()

  await check("plugin: the bundled Weft plugin is loaded into the engine", async () => {
    const ids = (await api.get("/experimental/tool/ids", { directory: WORK })).data
    assert(ids.includes(CANARY), `no ${CANARY} among ${ids.length} tool ids`)
    await sleep(SETTLE_MS)
    const banner = await evaluate(`[...document.querySelectorAll(".liberation-banner")].some((b) => b.textContent.includes("Plugin not loaded"))`)
    assert(!banner, "the 'Plugin not loaded' banner is shown")
  })

  let session
  await check("session: New session opens a fresh session on the loom", async () => {
    await click(`document.querySelector(".new-session")`, "New session")
    session = await waitFor(async () => (await api.get("/session", { directory: WORK })).data[0]?.id, 10_000, "a session in the engine")
    sessions.push(session)
    await until(`!!document.querySelector('article.pick.warp[data-pick="0"]')`, 10_000, "pick 00")
    return session
  })
  gate()

  let turn
  await check("send: the mock model's reply appears in the conversation", async () => {
    await script([{ text: REPLY }])
    turn = await turnAfter(session, await sendFromFell(PROMPT))
    assert(turn.body.model === "mock-model", `the model call went to ${js(turn.body.model)}`)
    assert(convo(turn).some((m) => m.role === "user" && m.text.includes(PROMPT)), "the prompt is not in the model call")
    await until(`!!window.__qa.pick(${js(REPLY)}) && !document.querySelector("article.pick.live")`, 15_000, "the reply on the loom")
    const role = await evaluate(`window.__qa.pick(${js(REPLY)}).dataset.role`)
    assert(role === "assistant", `the reply sits on a ${role} pick`)
  })

  await check("plugin: the observed system prompt is the one the model received", async () => {
    assert(turn, "no model call to compare with")
    const observed = await invoke("observed_system", { sessionId: session })
    assert(typeof observed?.sent === "string", "observed_system has nothing for the session: the plugin or WEFT_OBSERVED_DIR is not wired")
    const system = systemOf(turn)
    assert(system.join("\n") === observed.sent, `observed ${observed.sent.length} chars, sent ${system.map((s) => s.length).join(" + ")} chars`)
    return `${observed.sent.length} chars`
  })

  await check("edit: double-click opens the editor on the user's message", async () => {
    await click(`${pickExpr(PROMPT)}?.querySelector("[data-part] .prose")`, "the user pick", 2)
    const value = await until(`document.querySelector("article.pick.editing textarea.editor-text")?.value`, 5_000, "the editor")
    assert(value === PROMPT, `the editor holds ${js(value)}`)
  })

  await check("edit: Save shows and stores the new text, marked as edited", async () => {
    await retype(`document.querySelector("article.pick.editing textarea.editor-text")`, EDITED)
    await click(`[...document.querySelectorAll("article.pick.editing .editor-actions .btn.primary")].find((b) => b.textContent.startsWith("Save"))`, "Save")
    await until(`!document.querySelector("article.pick.editing") && window.__qa.pick(${js(EDITED)})?.dataset.role === "user"`, 10_000, "the edited pick")
    // The text shows at once; the mark follows when the engine has stored the edit's metadata.
    await until(`!!window.__qa.pick(${js(EDITED)})?.querySelector(".darn")`, 10_000, "the edited mark")
    assert(!(await evaluate(`!!window.__qa.pick(${js(PROMPT)})`)), "the old text is still shown")
    await waitFor(async () => storedWith(await messages(session), EDITED, "user"), 10_000, "the edit in the engine")
  })

  await check("theme: the sessions footer toggle switches day and night and back", async () => {
    const toggle = `[...document.querySelectorAll(".book-foot .foot-gear")].find((b) => /^(Day|Night):/.test(b.title))`
    const first = await evaluate(`document.documentElement.dataset.theme`)
    assert(first === "light" || first === "dark", `data-theme is ${js(first)}`)
    await sleep(SETTLE_MS)
    await shoot(shotOf(first))
    await click(toggle, "the theme toggle")
    const second = await until(`(() => { const t = document.documentElement.dataset.theme; return t !== ${js(first)} && t })()`, 5_000, "the other theme")
    await sleep(SETTLE_MS)
    await shoot(shotOf(second))
    await click(toggle, "the theme toggle")
    await until(`document.documentElement.dataset.theme === ${js(first)}`, 5_000, `${first} again`)
    return `${first} -> ${second} -> ${first}`
  })

  await check("settings: Ctrl+, opens Settings and Esc closes it", async () => {
    await press(",", { ctrl: true })
    await until(`!!document.querySelector(".dialog.settings:not(.leaving)")`, 5_000, "the Settings dialog")
    await sleep(SETTLE_MS)
    await shoot("settings")
    await click(`[...document.querySelectorAll(".settings-nav [role=tab]")].find((t) => t.textContent.trim() === "About")`, "the About tab")
    await until(`[...document.querySelectorAll(".dialog.settings button")].some((b) => b.textContent.includes("Third-party notices"))`, 5_000, "the license buttons")
    await sleep(SETTLE_MS)
    await shoot("about")
    await press("Escape")
    await until(`!document.querySelector(".dialog.settings")`, 5_000, "Settings to close")
  })

  await check("page: no uncaught exceptions or console errors", () => {
    assert(pageErrors.length === 0, `${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")}`)
  })

  await check("shots: main screen by day and by night, Settings and About", () => {
    const missing = ["main-day", "main-night", "settings", "about"].filter((name) => !shots.includes(join(SHOTS, `${name}.png`)))
    assert(missing.length === 0, `missing ${missing.join(", ")}${shotErrors.length ? `: ${shotErrors.join(" | ")}` : ""}`)
    return SHOTS
  })

  // ───── graceful close ─────

  let engineTree = []
  await check("close: the engine runs as a child process of weft.exe", () => {
    tree = descendants(processTable(), weft.pid)
    engineTree = tree.filter((p) => !WEBVIEW.test(p.name))
    assert(engineTree.length, `weft.exe has no engine process (children: ${tree.map((p) => p.name).join(", ") || "none"})`)
    return engineTree.map((p) => `${p.name} ${p.pid}`).join(", ")
  })

  watching = false
  await check("close: the window's Close button quits weft.exe", async () => {
    // The window may close before the release of the click is acknowledged.
    await click(`document.querySelector(".titlebar .win button.close")`, "the window's Close button").catch((error) => {
      if (!error.message.includes("connection closed")) throw error
    })
    const code = await Promise.race([weft.done, sleep(CLOSE_TIMEOUT_MS).then(() => "timeout")])
    assert(code !== "timeout", `weft.exe still runs ${CLOSE_TIMEOUT_MS / 1000} s after Close`)
    return `exit code ${code}`
  })

  await check("close: the engine is gone with the app", async () => {
    await waitFor(
      async () => {
        const left = stillRunning(engineTree)
        if (left.length) throw new Error(`still running: ${left.map((p) => `${p.name} ${p.pid}`).join(", ")}`)
        if (await answers(engine.url)) throw new Error(`${engine.url} still answers`)
        return true
      },
      15_000,
      "the engine to exit",
    )
  })
}

async function diagnostics() {
  if (pageErrors.length) console.error(`page errors:\n  ${pageErrors.join("\n  ")}`)
  if (page && weft && !exited(weft)) {
    const lines = await Promise.race([invoke("engine_logs").catch(() => undefined), sleep(5_000)])
    if (Array.isArray(lines) && lines.length) console.error(`--- engine log (tail)\n${lines.slice(-20).join("\n")}`)
  }
  for (const name of ["weft", "mock"]) {
    const text = existsSync(at(`${name}.log`)) ? readFileSync(at(`${name}.log`), "utf8").trim() : ""
    if (text) console.error(`--- ${name}.log (tail)\n${text.split("\n").slice(-15).join("\n")}`)
  }
}

function report() {
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ""}`)
  for (const shot of shots) console.log(`# shot: ${shot}`)
  for (const line of networkErrors) console.log(`# network: ${line}`)
  return failed
}

let failed = 1
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop().then(() => process.exit(130)))
try {
  await prepare()
  await start()
  await attach()
  await scenario()
  failed = report()
} catch (error) {
  results.push({ name: "aborted", ok: false, detail: error.message })
  console.log(`not ok - aborted: ${error.message}`)
  await diagnostics()
  report()
  console.error(`\nFATAL: ${error.stack ?? error}`)
} finally {
  await stop()
}
process.exit(failed ? 1 : 0)
