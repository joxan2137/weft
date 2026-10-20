#!/usr/bin/env node
// End-to-end check of the workflow tool (plugin/weft-workflow.ts). Starts tools/mock-provider.mjs and an
// isolated opencode 1.19.1 engine that loads both Weft plugins, has the mock model call the tool and
// asserts on the child sessions, the tool part and the requests the model received.
//
//   node tools/e2e-workflow.mjs [--keep]     (--keep leaves %TEMP%\weft-workflow for inspection)
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const EXE = join(ROOT, ".ref", "bin", "package", "bin", "opencode.exe")
const TEMP = join(tmpdir(), "weft-workflow")
const ENGINE_PORT = 48630
const MOCK_PORT = 48631
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const USER = "weft"
const PASSWORD = randomUUID()
const MODEL = { providerID: "mock", modelID: "mock-model" }
const KEEP = process.argv.includes("--keep")

const at = (...names) => join(TEMP, ...names)
const WORK = at("w")
const RUNS = at("runs")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ───────── transport ─────────

const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`

async function call(method, path, body, signal) {
  const res = await fetch(new URL(path, ENGINE), {
    method,
    headers: { authorization: AUTH, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

const get = (path) => call("GET", path)
const post = (path, body) => call("POST", path, body ?? {})

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
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ""}`)
}

/** Every config dir opencode scans gets an npm install unless node_modules exists and the lock names its deps. */
const CONFIG_DIRS = [at("cfg"), at("c", "opencode")]

const HELLO = `export const meta = {
  name: 'hello',
  description: 'Greets through one agent',
  phases: [{ title: 'Greet', detail: 'one agent' }],
}
phase('Greet')
log('greeting ' + args)
const said = await agent('greet ' + args, { label: 'greeter' })
return { said }
`

function prepare() {
  rmSync(TEMP, { recursive: true, force: true })
  for (const name of ["d", "c", "k", "s", "t", "home", "obs", "runs", "w/.opencode/workflows", "cfg/plugins"]) mkdirSync(at(...name.split("/")), { recursive: true })
  for (const file of ["weft-liberated.ts", "weft-workflow.ts"]) copyFileSync(join(ROOT, "plugin", file), at("cfg", "plugins", file))
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
    enabled_providers: ["mock"],
    model: "mock/mock-model",
    small_model: "mock/mock-model",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `${MOCK}/v1`, apiKey: "mock-key" },
        models: { "mock-model": { name: "Mock model", tool_call: true, limit } },
      },
    },
  }
  writeFileSync(at("cfg", "opencode.json"), JSON.stringify(config, null, 2))
  writeFileSync(join(WORK, ".opencode", "workflows", "hello.js"), HELLO)
  writeFileSync(join(WORK, "README.md"), "# e2e workspace\n")
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
    WEFT_OBSERVED_DIR: at("obs"),
    WEFT_WORKFLOWS_DIR: RUNS,
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
  const mock = spawn(process.execPath, [join(ROOT, "tools", "mock-provider.mjs"), "--port", String(MOCK_PORT), "--log", at("mock.jsonl")], {
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
  await waitFor(async () => (await call("GET", "/global/health", undefined, AbortSignal.timeout(2_000)))?.healthy, 60_000, "engine health")
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

// ───────── driving ─────────

const mock = (method, body) => fetch(`${MOCK}/mock/script`, { method, body: body && JSON.stringify(body) })
const requests = async () => (await fetch(`${MOCK}/mock/requests`)).json()

/** Replaces the mock's reply queue: the parent's tool call first, then whatever its agents and its last turn get. */
async function script(replies) {
  await mock("DELETE")
  await mock("POST", replies)
}

const workflowCall = (args) => ({ tool: { name: "workflow", arguments: args } })
const newSession = async () => (await post("/session", {})).id
const send = (sessionID, text) => post(`/session/${sessionID}/message`, { agent: "build", model: MODEL, parts: [{ type: "text", text }] })
const sendAsync = (sessionID, text) => post(`/session/${sessionID}/prompt_async`, { agent: "build", model: MODEL, parts: [{ type: "text", text }] })
const messages = (sessionID) => get(`/session/${sessionID}/message`)
const kids = (sessionID) => get(`/session/${sessionID}/children`)

async function workflowPart(sessionID) {
  for (const message of (await messages(sessionID)).reverse()) {
    const part = message.parts.find((p) => p.type === "tool" && p.tool === "workflow")
    if (part) return part
  }
}

async function idle(sessionID, ms = 60_000) {
  await waitFor(async () => ((await get("/session/status"))[sessionID]?.type ?? "idle") === "idle", ms, `${sessionID} idle`)
}

const contentText = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("") : ""
const lastUser = (record) => contentText(record.body.messages.findLast((m) => m.role === "user")?.content)
const toolNames = (record) => (record.body.tools ?? []).map((t) => t.function?.name)
function resultOf(part) {
  const raw = /<result>\n([\s\S]*)\n<\/result>/.exec(part.state.output)?.[1]
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ───────── checks ─────────

const results = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function check(name, run) {
  try {
    await run()
    results.push({ name, ok: true })
    console.log(`ok      ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`not ok  ${name}\n        ${error.message}`)
  }
}

const FAN_OUT = `export const meta = {
  name: 'fan-out',
  description: 'Three echoes, then a judge',
  phases: [{ title: 'Echo' }, { title: 'Judge' }],
}
phase('Echo')
log('topic ' + args.topic)
const echoes = await parallel(['alpha', 'beta', 'gamma'].map((word) => () => agent('say ' + word, { label: word })))
const verdict = await agent('judge the echoes', {
  label: 'judge',
  phase: 'Judge',
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'number' } }, required: ['ok', 'count'] },
})
return { echoes, verdict }
`

async function scenario() {
  let fanOut
  let firstRun

  await check("the workflow tool is listed and hello is a command", async () => {
    const ids = await get("/experimental/tool/ids")
    assert(ids.includes("workflow"), `tool ids: ${ids.join(", ")}`)
    const commands = await get("/command")
    const hello = commands.find((c) => c.name === "hello")
    assert(hello, `commands: ${commands.map((c) => c.name).join(", ")}`)
    assert(/Greets through one agent/.test(hello.description ?? ""), `hello description: ${hello.description}`)
  })

  await check("fan-out: three parallel agents and a structured judge return to the parent", async () => {
    fanOut = await newSession()
    await script([
      workflowCall({ script: FAN_OUT, args: JSON.stringify({ topic: "greek" }) }),
      { echo: true },
      { echo: true },
      { echo: true },
      { tool: { name: "StructuredOutput", arguments: { ok: true, count: 3 } } },
      { text: "all done" },
    ])
    await send(fanOut, "run the fan-out")
    const part = await workflowPart(fanOut)
    assert(part?.state.status === "completed", `part: ${part?.state.status} ${part?.state.error ?? ""}`)
    const result = resultOf(part)
    assert(JSON.stringify(result.echoes) === JSON.stringify(["echo: say alpha", "echo: say beta", "echo: say gamma"]), `echoes: ${JSON.stringify(result.echoes)}`)
    assert(result.verdict?.ok === true && result.verdict.count === 3, `verdict: ${JSON.stringify(result.verdict)}`)
    const run = part.state.metadata.workflow
    firstRun = run.id
    assert(/^wf_[a-z0-9-]{6,}$/.test(run.id), `run id ${run.id}`)
    assert(run.status === "completed" && run.agents.length === 4, `run: ${run.status}, ${run.agents.length} agents`)
    assert(run.agents.every((a) => a.status === "done" && a.session), `agents: ${JSON.stringify(run.agents.map((a) => [a.label, a.status]))}`)
    assert(run.phases.map((p) => p.title).join() === "Echo,Judge", `phases: ${JSON.stringify(run.phases)}`)
    assert(run.agents.find((a) => a.label === "judge").phase === "Judge" && run.agents.find((a) => a.label === "alpha").phase === "Echo", "agent phases")
    assert(run.logs.some((l) => l.text === "topic greek"), `logs: ${JSON.stringify(run.logs)}`)
    assert(part.state.title === "fan-out", `title: ${part.state.title}`)
  })

  await check("agents are child sessions that cannot start workflows, subagents or todos", async () => {
    const list = await kids(fanOut)
    assert(list.length === 4, `${list.length} children`)
    assert(list.every((s) => s.parentID === fanOut && / \(fan-out workflow\)$/.test(s.title)), `titles: ${list.map((s) => s.title).join(" | ")}`)
    for (const child of list) {
      const denied = (child.permission ?? []).filter((r) => r.action === "deny").map((r) => r.permission)
      assert(["workflow", "task", "todowrite"].every((p) => denied.includes(p)), `${child.title} denies ${denied.join(", ")}`)
    }
    const childCalls = (await requests()).filter((r) => r.kind === "main" && /^say (alpha|beta|gamma)$|^judge the echoes$/.test(lastUser(r)))
    assert(childCalls.length === 4, `${childCalls.length} child calls`)
    for (const record of childCalls) {
      const offered = toolNames(record)
      assert(!offered.includes("workflow") && !offered.includes("task") && !offered.includes("todowrite"), `child offered ${offered.join(", ")}`)
    }
  })

  await check("the parent is offered the tool with no required parameter and the saved workflows listed", async () => {
    const parentCall = (await requests()).find((r) => r.kind === "main" && lastUser(r) === "run the fan-out")
    const tool = parentCall?.body.tools?.find((t) => t.function?.name === "workflow")
    assert(tool, "no workflow tool in the parent's request")
    const params = tool.function.parameters
    assert(Array.isArray(params.required) && params.required.length === 0, `required: ${JSON.stringify(params.required)}`)
    assert(["script", "name", "args", "resumeFromRunId"].every((key) => params.properties?.[key]), `properties: ${Object.keys(params.properties ?? {})}`)
    assert(/Saved workflows:\n- hello: Greets through one agent/.test(tool.function.description), "saved workflows are not listed")
  })

  await check("the run is journaled under WEFT_WORKFLOWS_DIR", () => {
    const dir = join(RUNS, firstRun)
    assert(readFileSync(join(dir, "script.js"), "utf8") === FAN_OUT, "script.js differs")
    const journal = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert(journal.filter((r) => r.type === "result").length === 4, `${journal.length} journal lines`)
    assert(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).status === "completed", "run.json status")
  })

  await check("resume: an unchanged script replays every agent without a model call", async () => {
    const before = (await requests()).length
    const session = await newSession()
    await script([workflowCall({ resumeFromRunId: firstRun }), { text: "resumed" }])
    await send(session, "resume it")
    const part = await workflowPart(session)
    assert(part?.state.status === "completed", `part: ${part?.state.status} ${part?.state.error ?? ""}`)
    const run = part.state.metadata.workflow
    assert(run.resumedFrom === firstRun && run.id !== firstRun, `resumedFrom ${run.resumedFrom}`)
    assert(run.agents.length === 4 && run.agents.every((a) => a.status === "cached"), `agents: ${run.agents.map((a) => a.status).join()}`)
    assert(resultOf(part).verdict?.count === 3, "the replayed result differs")
    const calls = (await requests()).slice(before).filter((r) => r.kind === "main")
    assert(calls.length === 2, `${calls.length} model calls (the tool call and the last reply expected)`)
    assert((await kids(session)).length === 0, "a resumed run started child sessions")
  })

  await check("a saved workflow runs by name with its args, phases and log", async () => {
    const session = await newSession()
    await script([workflowCall({ name: "hello", args: "world" }), { echo: true }, { text: "greeted" }])
    await send(session, "say hello")
    const part = await workflowPart(session)
    assert(part?.state.status === "completed", `part: ${part?.state.status} ${part?.state.error ?? ""}`)
    assert(resultOf(part).said === "echo: greet world", `result: ${part.state.output}`)
    const run = part.state.metadata.workflow
    assert(run.name === "hello" && run.description === "Greets through one agent", `name ${run.name}`)
    assert(run.phases[0]?.title === "Greet" && run.phases[0].detail === "one agent", `phases ${JSON.stringify(run.phases)}`)
    assert(run.logs.some((l) => l.text === "greeting world"), `logs ${JSON.stringify(run.logs)}`)
  })

  await check("the hello command asks the model to run the saved workflow", async () => {
    const session = await newSession()
    const before = (await requests()).length
    await script([{ text: "on it" }])
    await post(`/session/${session}/command`, { command: "hello", arguments: "there", model: "mock/mock-model" })
    await idle(session)
    const record = (await requests()).slice(before).find((r) => r.kind === "main")
    assert(/Run the saved workflow "hello" with the workflow tool[\s\S]*\nthere$/.test(lastUser(record ?? { body: { messages: [] } })), `prompt: ${record && lastUser(record)}`)
  })

  await check("progress is live: the running part shows the agent at work", async () => {
    const session = await newSession()
    await script([workflowCall({ script: "return await agent('take your time', { label: 'slow' })" }), { text: "slow answer", delayMs: 4000 }, { text: "fin" }])
    await sendAsync(session, "go slow")
    const live = await waitFor(
      async () => {
        const part = await workflowPart(session)
        const agent = part?.state.status === "running" && part.state.metadata?.workflow?.agents[0]
        return agent?.status === "running" && agent.session ? part : undefined
      },
      20_000,
      "a running part with a running agent",
    )
    assert(live.state.metadata.workflow.status === "running", "run status")
    await idle(session)
    const done = await workflowPart(session)
    assert(done.state.status === "completed" && done.state.metadata.workflow.agents[0].status === "done", `after: ${done.state.status}`)
    assert(resultOf(done) === "slow answer", `result: ${done.state.output}`)
  })

  await check("stopping the parent stops every running agent", async () => {
    const session = await newSession()
    await script([
      workflowCall({ script: "return await parallel([() => agent('wait one', { label: 'one' }), () => agent('wait two', { label: 'two' })])" }),
      { text: "late", delayMs: 15_000 },
      { text: "late", delayMs: 15_000 },
    ])
    await sendAsync(session, "start and stop")
    const running = await waitFor(
      async () => {
        const list = await kids(session)
        const status = await get("/session/status")
        return list.length === 2 && list.every((s) => status[s.id]?.type === "busy") ? list : undefined
      },
      20_000,
      "two busy agents",
    )
    await post(`/session/${session}/abort`)
    for (const child of running) await idle(child.id, 8_000)
    for (const child of running) {
      const last = (await messages(child.id)).findLast((m) => m.info.role === "assistant")
      assert(last?.info.error?.name === "MessageAbortedError", `${child.title}: ${JSON.stringify(last?.info.error)}`)
    }
    await idle(session)
    const part = await workflowPart(session)
    assert(part.state.status === "error", `part: ${part.state.status}`)
    await mock("DELETE")
  })

  await check("a script that throws fails the call with a resume hint", async () => {
    const session = await newSession()
    await script([workflowCall({ script: "await agent('first', { label: 'first' })\nthrow new Error('boom')" }), { echo: true }, { text: "noted" }])
    await send(session, "fail please")
    const part = await workflowPart(session)
    assert(part?.state.status === "error", `part: ${part?.state.status}`)
    assert(/failed \(run wf_[a-z0-9-]+\): boom/.test(part.state.error) && /resumeFromRunId "wf_/.test(part.state.error), `error: ${part.state.error}`)
    const run = part.state.metadata?.workflow
    assert(run?.status === "failed" && run.error === "boom" && run.agents[0]?.status === "done", `metadata: ${JSON.stringify(run)}`)
  })

  await check("a bad script, an unknown name and a missing input are refused", async () => {
    const session = await newSession()
    await script([workflowCall({ script: "return (" }), workflowCall({ name: "nope" }), workflowCall({}), { text: "ok" }])
    await send(session, "three mistakes")
    const parts = (await messages(session)).flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "workflow")
    assert(parts.length === 3 && parts.every((p) => p.state.status === "error"), `parts: ${parts.map((p) => p.state.status).join()}`)
    assert(/no saved workflow named "nope"[\s\S]*hello/.test(parts[1].state.error), `name error: ${parts[1].state.error}`)
    assert(/Pass a script/.test(parts[2].state.error), `empty error: ${parts[2].state.error}`)
  })
}

function report() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${KEEP ? `; files kept in ${TEMP}` : ""}`)
  if (failed.length) process.exitCode = 1
}

try {
  if (!existsSync(EXE)) throw new Error(`no engine at ${EXE}: unpack opencode-windows-x64@1.19.1 there (README, Checks)`)
  prepare()
  await start()
  await scenario()
} catch (error) {
  console.log(`not ok  setup\n        ${error.stack ?? error.message}`)
  process.exitCode = 1
} finally {
  await stop()
  report()
}
