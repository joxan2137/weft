import frauncesLicense from "@fontsource-variable/fraunces/LICENSE?raw"
import geistLicense from "@fontsource-variable/geist/LICENSE?raw"
import geistMonoLicense from "@fontsource-variable/geist-mono/LICENSE?raw"
import { createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Mark } from "../../art/Mark"
import { version } from "../../../package.json"
import notice from "../../assets/prompts/NOTICE.md?raw"
import { useWeft } from "../../engine/context"
import { setYolo, yoloEnabled } from "../../engine/yolo"
import { setThemePreference, theme, themePreference, type ThemePreference } from "../../theme/theme"
import { IconDrop, IconFile, IconFolder, IconGlobe, IconKey, IconMoon, IconNeedle, IconRefresh, IconSettle, IconSun, IconTool } from "../icons"
import { Prose } from "../parts/Prose"
import { inTauri, openExternal, openLogs } from "../platform"
import { ask, type SettingsTab } from "./controller"
import { Dialog } from "./Dialog"
import { KeyHints } from "./list"
import { reducedMotionPreference, setReducedMotion } from "./motion"
import { toast, toastError } from "./Toast"

const TABS: SettingsTab[] = ["engine", "network", "agent", "liberation", "appearance", "shortcuts", "about"]

const TAB_NAMES: Record<SettingsTab, string> = {
  engine: "Engine",
  network: "Network",
  agent: "Agent",
  liberation: "Liberation",
  appearance: "Appearance",
  shortcuts: "Shortcuts",
  about: "About",
}

const TAB_ICONS: Record<SettingsTab, () => typeof IconTool> = {
  engine: () => IconTool,
  network: () => IconGlobe,
  agent: () => IconSettle,
  liberation: () => IconNeedle,
  appearance: () => (theme() === "dark" ? IconMoon : IconSun),
  shortcuts: () => IconKey,
  about: () => IconDrop,
}

const THEMES: { value: ThemePreference; name: string }[] = [
  { value: "system", name: "System" },
  { value: "light", name: "Day" },
  { value: "dark", name: "Night" },
]

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["Ctrl", "K"], what: "Search actions, sessions, commands, models, projects" },
  { keys: ["Ctrl", "N"], what: "New session" },
  { keys: ["Ctrl", ","], what: "Settings" },
  { keys: ["Ctrl", "`"], what: "Open or close the terminal, also from inside it" },
  { keys: ["Enter"], what: "Send" },
  { keys: ["Shift", "Enter"], what: "New line in the composer" },
  { keys: ["↑"], what: "Bring back an earlier message, in an empty composer" },
  { keys: ["Esc"], what: "Stop the running reply, in the composer" },
  { keys: ["Esc"], what: "Close a dialog or menu" },
  { keys: ["Ctrl", "Shift", "C"], what: "Copy the selection in the terminal" },
  { keys: ["Double-click"], what: "Edit a message" },
  { keys: ["Ctrl", "Enter"], what: "Save an edit" },
  { keys: ["Ctrl", "Shift", "Enter"], what: "Save an edit and resend from it" },
  { keys: ["Y"], what: "Allow a permission once" },
  { keys: ["A"], what: "Always allow" },
  { keys: ["N"], what: "Reject" },
  { keys: ["1", "–", "9"], what: "Pick an answer to a question" },
]

/** Copyright lines as the fonts' own LICENSE files state them; the full texts ship with the app. */
const FONTS: { name: string; face: string; owner: string; license: string }[] = [
  { name: "Fraunces", face: "var(--font-you)", owner: "© 2020 The Fraunces Project Authors", license: frauncesLicense },
  { name: "Geist", face: "var(--font-ui)", owner: "© 2024 The Geist Project Authors", license: geistLicense },
  { name: "Geist Mono", face: "var(--font-code)", owner: "© 2024 The Geist Project Authors", license: geistMonoLicense },
]

/** Engine failures by kind (the Rust `ErrorKind`, plus the app's own health and ipc checks). */
const FAILURES: Record<string, string> = {
  resolve: "Could not find an engine",
  install: "Download failed",
  integrity: "The download did not check out",
  "migration-check": "Could not check the database",
  "engine-newer-than-db": "Engine newer than the database",
  "db-newer-than-engine": "Database newer than the engine",
  config: "Setup problem",
  start: "The engine did not start",
  timeout: "The engine did not answer in time",
  "version-mismatch": "Unexpected engine version",
  exited: "The engine stopped",
  health: "The engine is not answering",
  ipc: "Engine manager unreachable",
}

const failureOf = (kind: string) => FAILURES[kind] ?? "Engine error"

const MIGRATE_WARNING =
  "opencode.db is shared with OpenCode Desktop and the opencode CLI. With this on, an engine newer than the database upgrades it for good: some upgrades delete data, and an older OpenCode Desktop may stop working with it. An engine older than the database runs on a schema it does not know."

/** Opens a file Weft bundles under licenses/ (tauri.conf.json resources), or shows it in its folder. */
async function openBundled(file: string, reveal = false) {
  const [{ resolveResource }, opener] = await Promise.all([import("@tauri-apps/api/path"), import("@tauri-apps/plugin-opener")])
  const path = await resolveResource(`licenses/${file}`)
  await (reveal ? opener.revealItemInDir(path) : opener.openPath(path))
}

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** Engine, liberation status, appearance, shortcuts and the About notices. */
export function Settings(props: { onClose: () => void; tab?: SettingsTab }) {
  const [tab, setTab] = createSignal<SettingsTab>(props.tab ?? "engine")
  let nav!: HTMLElement

  function onNavKey(event: KeyboardEvent) {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab()) + step + TABS.length) % TABS.length]
    setTab(next)
    nav.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
  }

  return (
    <Dialog onClose={props.onClose} title="Settings" tint="ochre" width={860} align="top" class="settings">
      <nav ref={nav} class="settings-nav" role="tablist" aria-orientation="vertical" onKeyDown={onNavKey}>
        <For each={TABS}>
          {(t) => (
            <button
              role="tab"
              data-tab={t}
              aria-selected={tab() === t}
              tabIndex={tab() === t ? 0 : -1}
              classList={{ on: tab() === t }}
              onClick={() => setTab(t)}
            >
              <Dynamic component={TAB_ICONS[t]()} size={16} />
              <span>{TAB_NAMES[t]}</span>
              <Show when={t === "liberation"}>
                <LiberationDot />
              </Show>
            </button>
          )}
        </For>
      </nav>
      <div class="settings-page" role="tabpanel" aria-label={TAB_NAMES[tab()]}>
        <Switch>
          <Match when={tab() === "engine"}>
            <EnginePage />
          </Match>
          <Match when={tab() === "network"}>
            <NetworkPage />
          </Match>
          <Match when={tab() === "agent"}>
            <AgentPage />
          </Match>
          <Match when={tab() === "liberation"}>
            <LiberationPage />
          </Match>
          <Match when={tab() === "appearance"}>
            <AppearancePage />
          </Match>
          <Match when={tab() === "shortcuts"}>
            <ShortcutsPage />
          </Match>
          <Match when={tab() === "about"}>
            <AboutPage />
          </Match>
        </Switch>
      </div>
      <footer class="dialog-foot">
        <KeyHints
          keys={[
            ["↑↓", "Section"],
            ["Tab", "Next field"],
            ["Esc", "Close"],
          ]}
        />
      </footer>
    </Dialog>
  )
}

function LiberationDot() {
  const { state } = useWeft()
  const kind = () => (state.liberated === true ? "ready" : state.liberated === false ? "error" : "starting")
  return <span class={`dot ${kind()}`} />
}

/** An on/off switch: a pill track with a knob that slides across. */
function Toggle(props: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      class="dlg-switch"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    >
      <span class="knob" />
    </button>
  )
}

/** One setting in a card: what it is and a line about it on the left, its control on the right. */
function Setting(props: { name: JSX.Element; hint?: JSX.Element; children?: JSX.Element }) {
  return (
    <div class="setting">
      <span class="setting-text">
        <span class="setting-name">{props.name}</span>
        <Show when={props.hint}>
          <span class="setting-hint">{props.hint}</span>
        </Show>
      </span>
      <Show when={props.children}>
        <span class="setting-control">{props.children}</span>
      </Show>
    </div>
  )
}

type EngineSettings = { path: string | null; allowMigrate: boolean }

/** The ready engine's notice: a pending restart for an updated OpenCode Desktop, or a skipped upgrade. */
function engineNotice() {
  const [notice, setNotice] = createSignal<string>()
  if (!inTauri) return notice
  let stop: (() => void) | undefined
  let closed = false
  let heard = false
  onCleanup(() => {
    closed = true
    stop?.()
  })
  void (async () => {
    const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")])
    const unlisten = await listen<{ notice?: string }>("engine://state", (event) => {
      heard = true
      setNotice(event.payload.notice)
    })
    if (closed) return unlisten()
    stop = unlisten
    const status = await invoke<{ notice?: string }>("engine_status")
    if (!heard) setNotice(status.notice)
  })().catch(() => undefined)
  return notice
}

type ProxyScan = {
  tested: number
  working: number
  failed: number
  transport: number
  status: number
  quota: number
  slow: number
}

type ProxyStatus = {
  enabled: boolean
  source: "none" | "custom" | "pool"
  count: number
  hasCustom: boolean
  custom?: string
  current?: string
  currentLatencyMs?: number
  currentCountry?: string
  currentCountryCode?: string
  fastestMs?: number
  slowestMs?: number
  refreshing: boolean
  rescanCooldownMs?: number
  maxLatencyMs: number
  scanTotal: number
  scanTested: number
  scanWorking: number
  lastScan?: ProxyScan
  lastScanAt?: number
  lastError?: string
}

function NetworkPage() {
  const { actions } = useWeft()
  const [busy, setBusy] = createSignal(false)
  const [custom, setCustom] = createSignal("")
  const [latency, setLatency] = createSignal("")
  const [status, { mutate: setStatus, refetch }] = createResource(async () => {
    if (!inTauri) return undefined
    const { invoke } = await import("@tauri-apps/api/core")
    const next = await invoke<ProxyStatus>("proxy_status")
    if (!latency()) setLatency(String(next.maxLatencyMs))
    return next
  })

  onMount(() => {
    if (!inTauri) return
    const timer = window.setInterval(() => {
      const current = status()
      if (busy()) return
      if (current?.enabled || current?.refreshing) refetch()
    }, 2000)
    onCleanup(() => window.clearInterval(timer))
  })

  const state = () => {
    const current = status()
    if (!current?.enabled) return { label: "Off", dot: "" }
    if (current.source === "custom") return { label: "Ready", dot: "ready" }
    if (current.refreshing && current.count === 0) return { label: "Scanning", dot: "starting" }
    if (current.count > 0) return { label: "Ready", dot: "ready" }
    if (current.lastError) return { label: "No proxies", dot: "error" }
    if (current.refreshing) return { label: "Scanning", dot: "starting" }
    return { label: "Idle", dot: "" }
  }

  const scanLine = () => {
    const current = status()
    if (!current) return "-"
    if (current.source === "custom") return "Not used with a custom proxy"
    if (current.refreshing) return `${current.scanWorking} working of ${current.scanTested} tested, ${current.scanTotal} found`
    const last = current.lastScan
    if (!last) return "Not scanned yet"
    return `${last.working} working of ${last.tested} tested, ${last.failed} failed`
  }

  async function call(command: string, args?: Record<string, unknown>) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<ProxyStatus>(command, args)
  }

  async function saveEnabled(on: boolean) {
    setBusy(true)
    try {
      setStatus(await call("proxy_set_enabled", { enabled: on }))
      await actions.restartEngine()
      refetch()
      toast(on ? "Zen proxy on. The engine restarted." : "Zen proxy off. The engine restarted.")
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  async function applyCustom(address = custom().trim()) {
    setBusy(true)
    try {
      const wasEnabled = status()?.enabled ?? false
      const wasCustom = status()?.hasCustom ?? false
      const next = await call("proxy_set_custom", { custom: address || null })
      setStatus(next)
      if (next.enabled && (wasEnabled !== next.enabled || wasCustom !== next.hasCustom)) {
        await actions.restartEngine()
      }
      setCustom("")
      refetch()
      toast(next.hasCustom ? "Custom proxy set." : next.enabled ? "Custom proxy cleared. Using the pool." : "Custom proxy cleared.", "success")
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  async function applyLatency() {
    const ms = Number(latency())
    if (!Number.isFinite(ms) || ms <= 0 || ms > 600_000) return toast("Enter 1 to 600000 milliseconds.", "warn")
    setBusy(true)
    try {
      const next = await call("proxy_set_max_latency", { maxLatencyMs: Math.floor(ms) })
      setStatus(next)
      setLatency(String(next.maxLatencyMs))
      toast("Latency cap updated.", "success")
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  async function refreshPool() {
    setBusy(true)
    try {
      setStatus(await call("proxy_refresh"))
      refetch()
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="settings-sec">
      <header class="settings-head">
        <h3 class="settings-title">Network</h3>
        <span class={`state ${state().dot}`}>
          <span class={`dot ${state().dot}`} /> {state().label}
        </span>
      </header>
      <p class="settings-text">
        Routes opencode zen requests through a rotating pool of public SOCKS proxies. Other providers and all other
        traffic keep their normal connection.
      </p>
      <Show
        when={inTauri}
        fallback={<p class="settings-text dim">Proxy settings are managed in the desktop app.</p>}
      >
        <Show when={status()}>
          {(current) => (
            <>
              <ul class="ledger settings-ledger">
                <li>
                  <span>Source</span>
                  <span class="num">
                    {current().source === "custom" ? "Custom proxy" : current().source === "pool" ? "Rotating pool" : "None"}
                  </span>
                </li>
                <li>
                  <span>Current</span>
                  <span class="num mono selectable">{current().current ?? "-"}</span>
                </li>
                <li>
                  <span>Latency</span>
                  <span class="num">
                    {current().currentLatencyMs ? `${current().currentLatencyMs} ms` : "-"}
                    <Show when={current().fastestMs}>
                      {current().count > 1 ? ` (${current().fastestMs}-${current().slowestMs} ms pool)` : ""}
                    </Show>
                  </span>
                </li>
                <li>
                  <span>Exit</span>
                  <span class="num">
                    {current().currentCountry
                      ? `${current().currentCountry} ${current().currentCountryCode ?? ""}`.trim()
                      : "-"}
                  </span>
                </li>
                <li>
                  <span>Pool</span>
                  <span class="num">
                    {current().source === "custom" ? "1 custom" : `${current().count} proxies`}
                  </span>
                </li>
                <li>
                  <span>Scan</span>
                  <span class="num">{scanLine()}</span>
                </li>
              </ul>
              <Show when={current().lastError}>
                <p class="dlg-error">{current().lastError}</p>
              </Show>
              <Show when={current().enabled}>
                <p class="dlg-note warn">
                  Free proxies are untrusted exit nodes. They can see which host a request goes to, never its TLS
                  contents. Weft sends only opencode zen traffic through them.
                </p>
              </Show>
            </>
          )}
        </Show>
        <div class="settings-card">
          <Setting
            name="Use rotating proxies for opencode zen"
            hint="Fetches public SOCKS lists, keeps the fastest working proxies, and rotates when one fails. Changing this restarts the engine."
          >
            <Toggle
              on={status()?.enabled ?? false}
              label="Use rotating proxies for opencode zen"
              disabled={busy()}
              onChange={(on) => void saveEnabled(on)}
            />
          </Setting>
          <Setting
            name="Custom proxy"
            hint={
              <>
                Overrides the pool. Supports <span class="mono">socks5://</span>, <span class="mono">socks4://</span> and{" "}
                <span class="mono">http://</span>, with optional <span class="mono">user:pass@</span>.
                <Show when={status()?.custom}>
                  {(value) => (
                    <>
                      <br />
                      Current: <span class="mono selectable">{value()}</span>
                    </>
                  )}
                </Show>
              </>
            }
          >
            <input
              class="settings-input"
              value={custom()}
              placeholder={status()?.custom ?? "socks5://host:port"}
              spellcheck={false}
              autocomplete="off"
              aria-label="Custom proxy address"
              disabled={busy()}
              onInput={(event) => setCustom(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void applyCustom()
                }
              }}
            />
            <Show when={status()?.hasCustom}>
              <button
                class="btn ghost"
                disabled={busy()}
                onClick={() => {
                  setCustom("")
                  void applyCustom("")
                }}
              >
                Clear
              </button>
            </Show>
            <button class="btn" disabled={busy()} onClick={() => void applyCustom()}>
              Apply
            </button>
          </Setting>
          <Setting name="Maximum latency" hint="Drops proxies slower than this during a scan. The pool keeps only the fastest 25.">
            <input
              class="settings-input narrow"
              type="number"
              min="1"
              max="600000"
              step="100"
              value={latency()}
              aria-label="Maximum proxy latency in milliseconds"
              disabled={busy()}
              onInput={(event) => setLatency(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void applyLatency()
                }
              }}
            />
            <span class="setting-hint">ms</span>
            <button class="btn" disabled={busy()} onClick={() => void applyLatency()}>
              Apply
            </button>
          </Setting>
          <Setting
            name="Refresh pool"
            hint={`Scans the public lists again. ${status()?.refreshing ? "A scan is running now." : "A manual scan ignores the usual cooldown."}`}
          >
            <button
              class="btn"
              disabled={busy() || !status()?.enabled || status()?.hasCustom || status()?.refreshing}
              onClick={() => void refreshPool()}
            >
              <IconRefresh size={14} /> {status()?.refreshing ? "Scanning" : "Refresh"}
            </button>
          </Setting>
        </div>
      </Show>
    </section>
  )
}

function EnginePage() {
  const { state, actions } = useWeft()
  const [restarting, setRestarting] = createSignal(false)
  const [logs, { refetch }] = createResource(async () => {
    if (!inTauri) return undefined
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<string[]>("engine_logs")
  })
  const [settings, { mutate: setSettings }] = createResource(async () => {
    if (!inTauri) return undefined
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<EngineSettings>("engine_settings")
  })
  const notice = engineNotice()
  const engine = () => state.engine
  const dot = () => {
    const s = engine().state
    return s === "ready" ? "ready" : s === "error" ? "error" : s === "idle" ? "" : "starting"
  }

  async function restart() {
    setRestarting(true)
    try {
      await actions.restartEngine()
      refetch()
    } catch (error) {
      toastError(error)
    } finally {
      setRestarting(false)
    }
  }

  async function saveSettings(patch: Partial<EngineSettings>) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      setSettings(await invoke<EngineSettings>("engine_set_settings", patch))
    } catch (error) {
      return toastError(error)
    }
    await restart()
  }

  async function chooseEngine() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({
        multiple: false,
        directory: false,
        title: "Choose opencode.exe",
        filters: [{ name: "opencode", extensions: ["exe"] }],
      })
      if (typeof picked === "string") await saveSettings({ path: picked })
    } catch (error) {
      toastError(error)
    }
  }

  async function allowMigrate(allow: boolean) {
    if (
      allow &&
      !(await ask({
        title: "Let this engine migrate opencode.db?",
        confirm: "Allow and restart",
        danger: true,
        body: [
          MIGRATE_WARNING,
          "The engine restarts now and may upgrade the database at once. Go ahead only with a backup of ~/.local/share/opencode.",
        ],
      }))
    )
      return
    await saveSettings({ allowMigrate: allow })
  }

  return (
    <section class="settings-sec">
      <header class="settings-head">
        <h3 class="settings-title">Engine</h3>
        <span class={`state ${dot()}`}>
          <span class={`dot ${dot()}`} /> {capitalized(engine().state)}
        </span>
      </header>
      <p class="settings-text">
        Weft runs the official opencode server in the background and talks to it over HTTP. Its version matches the installed
        OpenCode Desktop, so both can share one database.
      </p>
      <ul class="ledger settings-ledger">
        <li>
          <span>opencode</span>
          <span class="num">{"version" in engine() ? (engine() as { version: string }).version : "—"}</span>
        </li>
        <li>
          <span>Server</span>
          <span class="num mono selectable">{engine().state === "ready" ? (engine() as { url: string }).url : "—"}</span>
        </li>
        <Show when={engine().state === "installing" && (engine() as { progress: number; received?: number; total?: number })}>
          {(e) => (
            <li>
              <span>Download</span>
              <span class="num">{e().total ? `${Math.round(e().progress * 100)}%` : `${((e().received ?? 0) / 1_048_576).toFixed(1)} MB`}</span>
            </li>
          )}
        </Show>
      </ul>
      <Show when={engine().state === "ready" && notice()}>{(text) => <p class="dlg-note">{text()}</p>}</Show>
      <Show when={engine().state === "error" && (engine() as { kind: string; message: string })}>
        {(e) => (
          <p class="dlg-error">
            <strong>{failureOf(e().kind)}</strong> · {e().message}
          </p>
        )}
      </Show>
      <div class="settings-card">
        <Setting name="Restart engine" hint="Stops the server and starts it again. Running replies are interrupted.">
          <button class="btn" onClick={restart} disabled={restarting()}>
            <IconRefresh size={14} /> {restarting() ? "Restarting…" : "Restart"}
          </button>
        </Setting>
        <Show when={settings()}>
          {(current) => (
            <>
              <Setting
                name="Custom engine"
                hint={
                  <>
                    <span class="selectable" classList={{ mono: !!current().path }}>
                      {current().path ?? "None. Without OpenCode Desktop, Weft runs the latest opencode release."}
                    </span>
                    <br />
                    Used only when OpenCode Desktop is not installed; otherwise the engine matches its version.
                  </>
                }
              >
                <Show when={current().path}>
                  <button class="btn ghost" onClick={() => saveSettings({ path: null })} disabled={restarting()}>
                    Clear
                  </button>
                </Show>
                <button class="btn" onClick={chooseEngine} disabled={restarting()}>
                  Choose…
                </button>
              </Setting>
              <Setting
                name="Allow this engine to migrate the database"
                hint="Starts the engine even when its database schema differs from the shared opencode.db."
              >
                <Toggle
                  on={current().allowMigrate}
                  label="Allow this engine to migrate the database"
                  disabled={restarting()}
                  onChange={(allow) => void allowMigrate(allow)}
                />
              </Setting>
            </>
          )}
        </Show>
      </div>
      <Show when={settings()}>
        {(current) => (
          <p class={`dlg-note ${current().allowMigrate ? "bad" : "warn"}`}>
            {MIGRATE_WARNING} Leave it off unless you have a backup of <span class="mono">~/.local/share/opencode</span>.
          </p>
        )}
      </Show>
      <header class="settings-head logs-head">
        <h4 class="settings-sub">Logs</h4>
        <Show when={inTauri}>
          <button class="btn ghost" onClick={() => openLogs().catch(toastError)} title="Weft's own log and the engine's output, in Explorer">
            <IconFolder size={14} /> Open logs
          </button>
          <button class="btn ghost" onClick={() => refetch()}>
            <IconRefresh size={14} /> Refresh
          </button>
        </Show>
      </header>
      <Show
        when={inTauri}
        fallback={<p class="settings-text dim">Engine logs are shown in the desktop app. In the browser the engine runs on its own.</p>}
      >
        <pre class="logs selectable">
          <Show when={!logs.error} fallback={<span class="bad">{String(logs.error)}</span>}>
            {(logs() ?? []).slice(-400).join("\n") || "No output yet."}
          </Show>
        </pre>
      </Show>
    </section>
  )
}

function AgentPage() {
  const { state, actions } = useWeft()

  function setMode(on: boolean) {
    setYolo(on)
    if (!on) return
    for (const requests of Object.values(state.permissions))
      for (const request of requests) void actions.replyPermission(request.sessionID, request.id, "once").catch(toastError)
  }

  return (
    <section class="settings-sec">
      <header class="settings-head">
        <h3 class="settings-title">Agent</h3>
        <Show when={yoloEnabled()}>
          <span class="state error">
            <span class="dot error" /> YOLO
          </span>
        </Show>
      </header>
      <p class="settings-text">
        How much the agent may do on its own. Permission requests still come back to Weft; YOLO mode answers them as they arrive.
      </p>
      <div class="settings-card">
        <Setting
          name="YOLO mode"
          hint="Approves every tool permission automatically, including file edits, commands and reads outside the project. Questions still stop for you."
        >
          <Toggle on={yoloEnabled()} label="YOLO mode" onChange={setMode} />
        </Setting>
      </div>
      <Show when={yoloEnabled()}>
        <p class="dlg-note bad">
          YOLO mode is on. The agent can run any command and change any file the engine can reach without asking first. Turn it off before
          handing the machine to a session you do not trust.
        </p>
      </Show>
    </section>
  )
}

function LiberationPage() {
  const { state } = useWeft()
  return (
    <section class="settings-sec">
      <header class="settings-head">
        <h3 class="settings-title">Liberation</h3>
        <Switch>
          <Match when={state.liberated === true}>
            <span class="state ready">
              <span class="dot ready" /> Active
            </span>
          </Match>
          <Match when={state.liberated === false}>
            <span class="state error">
              <span class="dot error" /> Not loaded
            </span>
          </Match>
          <Match when={state.liberated === undefined}>
            <span class="state starting">
              <span class="dot starting" /> Checking
            </span>
          </Match>
        </Switch>
      </header>
      <Switch>
        <Match when={state.liberated === true}>
          <p class="dlg-note ok">
            The weft plugin is loaded in the engine. Every edit, re-voiced message, muted message and the rewritten system prompt is
            applied to each model call.
          </p>
        </Match>
        <Match when={state.liberated === false}>
          <p class="dlg-note bad">
            The weft plugin did not load: its canary tool is missing. Edits are stored with the session but the model still sees the
            original conversation. Restart the engine; if this stays, check the engine logs.
          </p>
        </Match>
        <Match when={state.liberated === undefined}>
          <p class="dlg-note warn">Looking for the plugin's canary tool in the engine…</p>
        </Match>
      </Switch>
      <p class="settings-text">In most clients, what has been said is fixed. In Weft the whole conversation is yours to change:</p>
      <ul class="settings-list">
        <li data-role="user">Rewrite any message, yours or the model's. The old text is kept in its edit history.</li>
        <li data-role="assistant">Change who said a message: the source, you or the model.</li>
        <li data-role="system">Edit the system prompt. It is the source, the first message, read before anything else.</li>
        <li data-role="tool">Mute a message (it settles: kept, never sent), delete, insert or reorder messages without losing the session.</li>
      </ul>
      <p class="settings-text dim">
        Changes live in the session's metadata. A small plugin inside the engine applies them on every model call; opencode's own
        storage is never rewritten.
      </p>
    </section>
  )
}

function AppearancePage() {
  const systemReduced = matchMedia("(prefers-reduced-motion: reduce)").matches
  return (
    <section class="settings-sec">
      <header class="settings-head">
        <h3 class="settings-title">Appearance</h3>
      </header>
      <div class="settings-card">
        <Setting
          name="Theme"
          hint={
            <>
              Day is ink on paper; night is light in dark water.
              <Show when={themePreference() === "system"}> Following your system: {theme() === "dark" ? "night" : "day"} now.</Show>
            </>
          }
        >
          <span class="seg theme-seg" role="radiogroup" aria-label="Theme">
            <For each={THEMES}>
              {(t) => (
                <button
                  role="radio"
                  aria-checked={themePreference() === t.value}
                  classList={{ on: themePreference() === t.value }}
                  onClick={() => setThemePreference(t.value)}
                >
                  <Show when={t.value !== "system"}>
                    <Dynamic component={t.value === "dark" ? IconMoon : IconSun} size={14} />
                  </Show>
                  {t.name}
                </button>
              )}
            </For>
          </span>
        </Setting>
        <Setting
          name="Reduce motion"
          hint={
            <>
              Stills the water, the settling ink and the movement of panels and dialogs.
              <Show when={systemReduced}> Your system already asks for reduced motion.</Show>
            </>
          }
        >
          <Toggle on={reducedMotionPreference()} label="Reduce motion" onChange={setReducedMotion} />
        </Setting>
      </div>
    </section>
  )
}

function ShortcutsPage() {
  return (
    <section class="settings-sec">
      <header class="settings-head">
        <h3 class="settings-title">Shortcuts</h3>
      </header>
      <ul class="ledger settings-ledger shortcut-list">
        <For each={SHORTCUTS}>
          {(s) => (
            <li>
              <span>{s.what}</span>
              <span class="keys">
                <For each={s.keys}>{(k) => (k === "–" ? <span class="dim">–</span> : <kbd>{k}</kbd>)}</For>
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

function AboutPage() {
  return (
    <section class="settings-sec about">
      <header class="settings-head">
        <h3 class="settings-title">About</h3>
      </header>
      <div class="about-mark">
        <Mark />
        <span class="tag num">{version}</span>
      </div>
      <p class="settings-text">
        Weft is a desktop client for <strong>opencode</strong>, the open-source coding agent. It runs the official opencode engine and
        lets you rewrite, re-voice or remove any message, including the system prompt.
      </p>
      <p class="dlg-note">
        Weft is not built by, endorsed by, or affiliated with the OpenCode team. “OpenCode” is their name; Weft uses it only to say
        what it works with.
      </p>
      <header class="settings-head">
        <h4 class="settings-sub">opencode</h4>
        <span class="tag">MIT License</span>
      </header>
      <div class="notice">
        <Prose text={notice} />
      </div>
      <header class="settings-head">
        <h4 class="settings-sub">Fonts</h4>
        <span class="tag">SIL Open Font License 1.1</span>
      </header>
      <ul class="ledger settings-ledger font-list">
        <For each={FONTS}>
          {(f) => (
            <li>
              <span class="font-name" style={{ "font-family": f.face }}>
                {f.name}
              </span>
              <span class="dim">{f.owner}</span>
            </li>
          )}
        </For>
      </ul>
      <p class="settings-text dim">
        All three are used under the{" "}
        <button class="link" onClick={() => openExternal("https://openfontlicense.org").catch(toastError)}>
          SIL Open Font License 1.1
        </button>{" "}
        and bundled from the @fontsource-variable packages. Their license texts:
      </p>
      <For each={FONTS}>
        {(f) => (
          <details class="license-text">
            <summary>{f.name}</summary>
            <pre class="logs selectable">{f.license}</pre>
          </details>
        )}
      </For>
      <header class="settings-head">
        <h4 class="settings-sub">Licenses</h4>
        <span class="tag">MIT License</span>
      </header>
      <p class="settings-text">
        Weft is free software under the MIT License. The app carries the licenses and notices of the libraries, fonts and crates
        it is built from.
      </p>
      <p class="settings-text dim">Copyright (c) 2026 The Weft authors</p>
      <p class="settings-text">
        The water is adapted from{" "}
        <button class="link" onClick={() => openExternal("https://github.com/PavelDoGreat/WebGL-Fluid-Simulation").catch(toastError)}>
          WebGL-Fluid-Simulation
        </button>{" "}
        by Pavel Dobryakov, MIT License.
      </p>
      <Show when={inTauri} fallback={<p class="settings-text dim">The license files open from the desktop app.</p>}>
        <div class="about-actions">
          <button class="btn" onClick={() => openBundled("LICENSE-weft.txt").catch(toastError)}>
            <IconFile size={14} /> Weft's license
          </button>
          <button class="btn" onClick={() => openBundled("LICENSE-opencode.txt").catch(toastError)}>
            <IconFile size={14} /> opencode's license
          </button>
          <button class="btn" onClick={() => openBundled("LICENSE-webgl-fluid-simulation.txt").catch(toastError)}>
            <IconFile size={14} /> The water's license
          </button>
          <button class="btn" onClick={() => openBundled("THIRD_PARTY_NOTICES.txt").catch(toastError)}>
            <IconFile size={14} /> Third-party notices
          </button>
          <button class="btn ghost" onClick={() => openBundled("THIRD_PARTY_NOTICES.txt", true).catch(toastError)}>
            <IconFolder size={14} /> Show all licenses
          </button>
        </div>
      </Show>
    </section>
  )
}
