// Runs the opencode engine for browser-based frontend development.
// usage: node tools/dev-engine.mjs [--real] [--port 4517]
//   default  isolated data under %TEMP%\weft-dev (XDG_* overridden)
//   --real   the user's real opencode data (no XDG overrides)
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEV = join(tmpdir(), "weft-dev")
const OBSERVED_DIR = join(DEV, "observed")
const WORKFLOWS_DIR = join(DEV, "workflows")
const XDG = { XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "xdg-config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" }
const LOCAL_DATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
const IDENTIFIER = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).identifier
/** Shared with the app: app_local_data_dir()/engines. */
const ENGINES = join(LOCAL_DATA, IDENTIFIER, "engines")
/** Where earlier builds kept engines, inside the per-user install folder. */
const LEGACY_ENGINES = join(LOCAL_DATA, "Weft", "engines")
const REF_ENGINE = join(ROOT, ".ref", "bin", "package", "bin", "opencode.exe")
const PLUGINS = ["weft-liberated.ts", "weft-workflow.ts"].map((file) => join(ROOT, "plugin", file))
const REGISTRY = "https://registry.npmjs.org"
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
const USERNAME = "weft"
const READY_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 150

const args = process.argv.slice(2)
const real = args.includes("--real")
const port = Number(option("--port") ?? 4517)
const password = process.env.WEFT_DEV_PASSWORD || randomUUID()
const url = `http://127.0.0.1:${port}`
const auth = `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`

function option(name) {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

function isValidVersion(version) {
  return /^[0-9A-Za-z.+-]+$/.test(version) && !version.includes("..")
}

function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s)
    return [core.split(".").map((n) => Number(n) || 0), pre]
  }
  const [aCore, aPre] = split(a)
  const [bCore, bPre] = split(b)
  for (let i = 0; i < Math.max(aCore.length, bCore.length); i++) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0)
    if (diff) return Math.sign(diff)
  }
  if (!aPre !== !bPre) return aPre ? -1 : 1
  return (aPre ?? "").localeCompare(bPre ?? "")
}

function desktopVersion() {
  let listing
  try {
    listing = execFileSync("reg", ["query", UNINSTALL_KEY, "/s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
  const versions = listing.split(/\r?\n(?=HKEY_)/).flatMap((block) => {
    const value = (name) => block.match(new RegExp(`^\\s+${name}\\s+REG_SZ\\s+(.*)$`, "m"))?.[1].trim()
    const version = value("DisplayVersion")
    return value("DisplayName")?.includes("OpenCode") && version && isValidVersion(version) ? [version] : []
  })
  return versions.sort(compareVersions).at(-1)
}

/** Same move as the app's install::adopt_legacy: complete engines already in ENGINES win. */
function adoptLegacyEngines() {
  if (!existsSync(LEGACY_ENGINES)) return
  mkdirSync(ENGINES, { recursive: true })
  for (const version of readdirSync(LEGACY_ENGINES)) {
    const target = join(ENGINES, version)
    if (!existsSync(join(LEGACY_ENGINES, version, "opencode.exe")) || existsSync(join(target, "opencode.exe"))) continue
    rmSync(target, { recursive: true, force: true })
    renameSync(join(LEGACY_ENGINES, version), target)
  }
  rmSync(LEGACY_ENGINES, { recursive: true, force: true })
  try {
    rmdirSync(dirname(LEGACY_ENGINES))
  } catch {}
}

function newestInstalled() {
  if (!existsSync(ENGINES)) return undefined
  return readdirSync(ENGINES)
    .filter((name) => isValidVersion(name) && existsSync(join(ENGINES, name, "opencode.exe")))
    .sort(compareVersions)
    .at(-1)
}

let cachedPackage
function packageName() {
  if (cachedPackage) return cachedPackage
  if (process.arch === "arm64") return (cachedPackage = "opencode-windows-arm64")
  const avx2 = execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `(Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);' -Name Cpu -Namespace Weft -PassThru)::IsProcessorFeaturePresent(40)`,
  ], { encoding: "utf8" }).trim() === "True"
  return (cachedPackage = avx2 ? "opencode-windows-x64" : "opencode-windows-x64-baseline")
}

async function getJson(target) {
  const response = await fetch(target, { headers: { "user-agent": "weft-dev-engine" } })
  if (!response.ok) throw new Error(`GET ${target}: ${response.status}`)
  return response.json()
}

async function resolveVersion() {
  const desktop = desktopVersion()
  if (desktop) return { version: desktop, desktop }
  try {
    const tags = await getJson(`${REGISTRY}/-/package/${packageName()}/dist-tags`)
    return { version: tags.latest }
  } catch (error) {
    const installed = newestInstalled()
    if (!installed) throw error
    return { version: installed }
  }
}

/** Throwaway XDG/DB dirs so engine probes never write into real opencode data. */
function withSandbox(run) {
  const root = join(DEV, `probe-${randomUUID().slice(0, 8)}`)
  mkdirSync(root, { recursive: true })
  const env = { ...process.env, OPENCODE_DB: join(root, "probe.db"), OPENCODE_DISABLE_AUTOUPDATE: "1" }
  for (const [key, dir] of Object.entries(XDG)) env[key] = join(root, dir)
  delete env.OPENCODE_CONFIG_DIR
  try {
    return run({ cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function engineVersion(exe) {
  return withSandbox((options) => execFileSync(exe, ["--version"], options).trim())
}

async function locateEngine(version) {
  const installed = join(ENGINES, version, "opencode.exe")
  if (existsSync(installed)) return installed
  if (existsSync(REF_ENGINE) && engineVersion(REF_ENGINE) === version) return REF_ENGINE
  await install(version, installed)
  return installed
}

async function install(version, exe) {
  const doc = await getJson(`${REGISTRY}/${packageName()}/${version}`)
  const response = await fetch(doc.dist.tarball)
  if (!response.ok) throw new Error(`GET ${doc.dist.tarball}: ${response.status}`)
  const total = Number(response.headers.get("content-length")) || 0
  const hash = createHash("sha512")
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    chunks.push(chunk)
    received += chunk.length
    if (total) process.stdout.write(`\rdownloading opencode ${version}: ${Math.floor((received / total) * 100)}%`)
  }
  process.stdout.write("\n")
  const expected = doc.dist.integrity.split(/\s+/).find((entry) => entry.startsWith("sha512-"))?.slice(7)
  if (hash.digest("base64") !== expected) throw new Error("the downloaded engine does not match its npm sha512 integrity")

  const binary = tarEntry(gunzipSync(Buffer.concat(chunks)), "package/bin/opencode.exe")
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(`${exe}.partial`, binary)
  renameSync(`${exe}.partial`, exe)
}

function tarEntry(tar, wanted) {
  const text = (start, length) => tar.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "")
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = text(offset, 100)
    if (!name) break
    const prefix = text(offset + 345, 155)
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8)
    const path = prefix ? `${prefix}/${name}` : name
    if (path === wanted) return tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`${wanted} is missing from the tarball`)
}

function sharedDb() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "opencode.db")
}

/** Refuses an engine that would migrate the real DB underneath an older OpenCode Desktop. */
async function guardMigrations(exe, version) {
  const db = sharedDb()
  if (!existsSync(db)) return
  const { DatabaseSync } = await import("node:sqlite")
  const conn = new DatabaseSync(db, { readOnly: true })
  let applied
  try {
    const table = conn.prepare("select 1 from sqlite_master where type = 'table' and name = 'migration'").get()
    if (!table) return
    applied = new Set(conn.prepare("select id from migration").all().map((row) => row.id))
  } finally {
    conn.close()
  }
  const missing = knownMigrations(exe, version).filter((id) => !applied.has(id))
  if (missing.length) {
    throw new Error(`opencode ${version} would apply ${missing.length} migration(s) that ${db} does not have yet (newest: ${missing.at(-1)})`)
  }
}

function knownMigrations(exe, version) {
  const cache = join(ENGINES, version, "migrations.json")
  try {
    return JSON.parse(readFileSync(cache, "utf8"))
  } catch {}
  const output = withSandbox((options) =>
    execFileSync(exe, ["db", "select id from migration order by id", "--format", "json"], options),
  )
  const ids = JSON.parse(output.slice(output.indexOf("["))).map((row) => row.id)
  mkdirSync(dirname(cache), { recursive: true })
  writeFileSync(cache, JSON.stringify(ids))
  return ids
}

function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(path) && readFileSync(path, "utf8") === text) return
  writeFileSync(path, text)
}

/**
 * Stands in for the user's existing ~/.config/opencode in isolated mode: its lockfile names
 * @opencode-ai/plugin, so the engine skips npm there.
 */
function seedGlobalConfig(dir, version) {
  const name = "@opencode-ai/plugin"
  mkdirSync(join(dir, "node_modules", "@opencode-ai", "plugin"), { recursive: true })
  writeJson(join(dir, "package.json"), { dependencies: { [name]: version } })
  writeJson(join(dir, "package-lock.json"), {
    lockfileVersion: 3,
    requires: true,
    packages: { "": { dependencies: { [name]: version } }, [`node_modules/${name}`]: { version } },
  })
  writeJson(join(dir, "node_modules", "@opencode-ai", "plugin", "package.json"), { name, version })
}

/**
 * Merged after every config dir, so the plugin loads last and the user's global config and AGENTS.md
 * stay in effect. The canary deny keeps it out of model requests; it still shows in tool ids.
 */
function configContent() {
  return JSON.stringify({ plugin: PLUGINS.map((file) => pathToFileURL(file).href), permission: { weft_canary: "deny" } })
}

function engineEnv() {
  const env = { ...process.env }
  for (const key of ["OPENCODE_DB", "OPENCODE_AUTH_CONTENT", "OPENCODE_PURE", "DEBUG"]) delete env[key]
  Object.assign(env, {
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: configContent(),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CLIENT: "weft",
    OPENCODE_ENABLE_QUESTION_TOOL: "1",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    WEFT_OBSERVED_DIR: OBSERVED_DIR,
    WEFT_WORKFLOWS_DIR: WORKFLOWS_DIR,
  })
  if (!real) for (const [key, dir] of Object.entries(XDG)) env[key] = join(DEV, dir)
  return env
}

async function health() {
  try {
    const response = await fetch(`${url}/global/health`, { headers: { authorization: auth } })
    if (!response.ok) return undefined
    const body = await response.json()
    return body.healthy && body.version ? body : undefined
  } catch {
    return undefined
  }
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } catch {}
}

async function main() {
  try {
    adoptLegacyEngines()
  } catch (error) {
    console.log(`# could not move ${LEGACY_ENGINES}: ${error.message}`)
  }
  const { version, desktop } = await resolveVersion()
  if (!isValidVersion(version)) throw new Error(`invalid engine version ${JSON.stringify(version)}`)
  const exe = await locateEngine(version)
  if (real) await guardMigrations(exe, version)

  if (!real) seedGlobalConfig(join(DEV, XDG.XDG_CONFIG_HOME, "opencode"), version)
  mkdirSync(OBSERVED_DIR, { recursive: true })
  const env = engineEnv()
  const cwd = real ? homedir() : DEV

  console.log(`opencode ${version}${desktop ? " (pinned to OpenCode Desktop)" : ""}: ${exe}`)
  console.log(`data: ${real ? "REAL user data" : DEV}`)
  const child = spawn(exe, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const stop = (code) => {
    killTree(child)
    process.exit(code)
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(signal, () => stop(0))
  process.on("exit", () => killTree(child))

  let listening
  const listened = new Promise((resolve) => (listening = resolve))
  createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(line)
    if (line.includes("server listening")) listening()
  })
  createInterface({ input: child.stderr }).on("line", (line) => console.error(line))
  const exited = new Promise((resolve) => child.once("exit", resolve))

  const ready = (async () => {
    await listened
    for (;;) {
      const body = await health()
      if (body) return body
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS))
    }
  })()
  const timeout = new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT_MS, "timeout"))
  const outcome = await Promise.race([ready, exited.then((code) => ({ exited: code })), timeout])
  if (outcome === "timeout") {
    console.error(`opencode did not report healthy within ${READY_TIMEOUT_MS / 1000} s`)
    stop(1)
  }
  if ("exited" in outcome) {
    console.error(`opencode exited before it was ready (code ${outcome.exited})`)
    process.exit(1)
  }

  writeFileSync(
    join(ROOT, ".env.local"),
    [
      `VITE_ENGINE_URL=${url}`,
      `VITE_ENGINE_USER=${USERNAME}`,
      `VITE_ENGINE_PASSWORD=${password}`,
      `VITE_OBSERVED_DIR=${OBSERVED_DIR}`,
      "",
    ].join("\n"),
  )
  console.log(`health: ${JSON.stringify(outcome)}`)
  console.log(`engine ready at ${url} (user ${USERNAME}); wrote .env.local. Ctrl+C to stop.`)

  const code = await exited
  console.error(`opencode exited (code ${code})`)
  process.exit(code ?? 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
