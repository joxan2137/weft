import { createSignal, type Accessor } from "solid-js"
import { inTauri } from "../ui/platform"
import { basicAuth, type Credentials, type Health } from "./api"
import type { EngineState } from "./contract"

const STATE_EVENT = "engine://state"

export type Connection = {
  state: Accessor<EngineState>
  restart(): Promise<void>
  dispose(): void
}

export function credentialsOf(engine: EngineState): Credentials | undefined {
  if (engine.state !== "ready") return undefined
  return {
    url: engine.url,
    username: engine.username,
    password: engine.password,
  }
}

/** Maps the Rust `EngineState` (serde tag "state", camelCase fields) onto the contract. */
export function toEngineState(raw: unknown): EngineState {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "")
  const number = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : undefined)
  switch (value.state) {
    case "resolving":
      return { state: "resolving" }
    case "installing": {
      const total = number("total")
      const received = number("received")
      const progress = number("progress") ?? (total ? (received ?? 0) / total : 0)
      return {
        state: "installing",
        version: text("version"),
        progress: Math.min(1, Math.max(0, progress)),
        received,
        total,
      }
    }
    case "starting":
      return { state: "starting", version: text("version") }
    case "ready":
      return {
        state: "ready",
        version: text("version"),
        url: text("url"),
        username: text("username"),
        password: text("password"),
        notice: text("notice") || undefined,
      }
    case "error":
      return {
        state: "error",
        kind: text("kind") || "unknown",
        message: text("message"),
      }
    default:
      return { state: "idle" }
  }
}

export function createConnection(): Connection {
  return inTauri ? tauriConnection() : envConnection()
}

const HEALTH_TIMEOUT_MS = 2_000
const HEALTH_RETRY_MS = 250
const HEALTH_GIVE_UP_MS = 30_000

async function probeHealth(credentials: Credentials): Promise<Health | undefined> {
  try {
    const response = await fetch(new URL("/global/health", credentials.url), {
      headers: {
        authorization: basicAuth(credentials.username, credentials.password),
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const health = (await response.json()) as Health
    return health.healthy ? health : undefined
  } catch {
    return undefined
  }
}

/**
 * A request that reaches opencode 1.19.1 right as it starts listening can hang forever, so a
 * reported "ready" only counts once /global/health answers within 2 s. Until then: "starting".
 */
function healthGate(state: Accessor<EngineState>, setState: (state: EngineState) => void) {
  let run = 0
  const same = (a: EngineState, b: EngineState) =>
    a.state === "ready" && b.state === "ready" && a.url === b.url && a.username === b.username && a.password === b.password
  return (next: EngineState) => {
    const current = ++run
    if (next.state !== "ready") return setState(next)
    const shown = state()
    // Same engine with a new notice (a pending restart for a Desktop update): no health gate needed.
    if (same(shown, next)) {
      if (shown.state === "ready" && shown.notice !== next.notice) setState({ ...shown, notice: next.notice })
      return
    }
    setState({ state: "starting", version: next.version })
    void (async () => {
      const deadline = Date.now() + HEALTH_GIVE_UP_MS
      while (current === run) {
        const health = await probeHealth(next)
        if (current !== run) return
        if (health) return setState({ ...next, version: health.version || next.version })
        if (Date.now() > deadline)
          return setState({
            state: "error",
            kind: "health",
            message: "The engine is not answering",
          })
        await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS))
      }
    })()
  }
}

function tauriConnection(): Connection {
  const [state, setState] = createSignal<EngineState>({ state: "idle" })
  const gate = healthGate(state, setState)
  let unlisten: (() => void) | undefined
  let disposed = false
  let heard = false

  void (async () => {
    const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")])
    const stop = await listen<unknown>(STATE_EVENT, (event) => {
      heard = true
      gate(toEngineState(event.payload))
    })
    if (disposed) return stop()
    unlisten = stop
    const status = await invoke<unknown>("engine_status")
    if (!heard) gate(toEngineState(status))
  })().catch((error) => {
    console.warn("[weft] engine status unavailable:", error)
    setState({ state: "error", kind: "ipc", message: "Weft could not reach its engine manager. Restart Weft; if it happens again, open the logs." })
  })

  return {
    state,
    async restart() {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("engine_restart")
    },
    dispose() {
      disposed = true
      unlisten?.()
    },
  }
}

/** The browser-only dev engine (tools/dev-engine.mjs); production builds never carry its credentials. */
const devEngine = import.meta.env.DEV
  ? {
      url: import.meta.env.VITE_ENGINE_URL,
      username: import.meta.env.VITE_ENGINE_USER || "opencode",
      password: import.meta.env.VITE_ENGINE_PASSWORD ?? "",
    }
  : undefined

function envConnection(): Connection {
  const [state, setState] = createSignal<EngineState>({ state: "resolving" })
  const gate = healthGate(state, setState)
  const connect = () =>
    devEngine?.url
      ? gate({
          state: "ready",
          version: "",
          url: devEngine.url,
          username: devEngine.username,
          password: devEngine.password,
        })
      : setState({
          state: "error",
          kind: "config",
          message: "VITE_ENGINE_URL is not set",
        })
  connect()

  return {
    state,
    async restart() {
      setState({ state: "starting", version: "" })
      connect()
    },
    dispose() {},
  }
}
