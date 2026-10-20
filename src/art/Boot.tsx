import { createEffect, createSignal, Show } from "solid-js"
import { motionReduced } from "../ui/dialogs/motion"
import { WindowControls } from "../ui/Titlebar"
import { ink } from "./ink"

export type BootPhase = "resolving" | "installing" | "starting" | "ready" | "error"

/** The engine download: bytes so far and, when the server says, the whole size. */
export type BootDownload = { version: string; received?: number; total?: number }

/** Why the engine is not running, by the Rust `ErrorKind` (src-tauri/src/engine/state.rs). */
export type BootFailure = { kind: string; message: string }

const STATUS: Record<BootPhase, string> = {
  resolving: "Finding the opencode engine",
  installing: "Fetching the engine",
  starting: "Starting the engine",
  ready: "Ready",
  error: "The engine did not start",
}

const ONLINE_ONCE = "Weft downloads the opencode engine the first time it starts, so it needs an internet connection once."

const FAILURES: Record<string, { title: string; guide: string }> = {
  resolve: {
    title: "Weft could not find the opencode engine",
    guide: `${ONLINE_ONCE} Check the connection and try again, or choose an opencode.exe in Engine settings.`,
  },
  install: {
    title: "The engine download did not finish",
    guide: `${ONLINE_ONCE} Check the connection and try again. A proxy or firewall can also stop the download.`,
  },
  integrity: {
    title: "The downloaded engine did not check out",
    guide: "The download did not match its published checksum, so Weft set it aside. Try again; if it keeps happening, something on the network is changing the download.",
  },
  "migration-check": {
    title: "Weft could not read the opencode database",
    guide: "Weft checks the opencode database before it starts the engine. The logs say what went wrong.",
  },
  "engine-newer-than-db": {
    title: "This engine would upgrade your opencode data",
    guide: "Open OpenCode Desktop once so it upgrades the database, or allow this engine to migrate the database in Engine settings.",
  },
  "db-newer-than-engine": {
    title: "Your opencode data is newer than this engine",
    guide: "A newer opencode wrote this data. Update OpenCode Desktop, choose a newer engine in Engine settings, or allow this engine to migrate the database there.",
  },
  config: {
    title: "Weft could not prepare the engine",
    guide: "Weft could not set up its folders or its plugin. The details and the logs say which.",
  },
  start: {
    title: "The engine did not start",
    guide: "opencode stopped while it was starting. The logs show what it printed.",
  },
  timeout: {
    title: "The engine did not answer",
    guide: "opencode started but did not answer in time. Try again; the logs show what it printed.",
  },
  "version-mismatch": {
    title: "The engine is not the version Weft expected",
    guide: "Choose another engine in Engine settings, or try again.",
  },
  exited: {
    title: "The engine stopped",
    guide: "opencode stopped after it had been running. Try again to start it; the logs show what it printed last.",
  },
}

function megabytes(bytes: number) {
  return (bytes / 1_000_000).toFixed(1)
}

/**
 * The boot screen: still paper and one drop falling toward it, once per real engine step. When the
 * engine is ready the paper lifts and the first drop lands in the water behind it.
 */
export function Boot(props: {
  phase: BootPhase
  /** 0 to 1; left out while the size of the download is unknown */
  progress?: number
  download?: BootDownload
  detail?: string
  failure?: BootFailure
  onDone: () => void
  onRetry?: () => void
  onSettings?: () => void
  onLogs?: () => void
  onCopy?: () => void
}) {
  const [leaving, setLeaving] = createSignal(false)
  let drop!: SVGSVGElement

  createEffect(() => {
    if (props.phase !== "ready" || leaving()) return
    setLeaving(true)
    const rect = drop.getBoundingClientRect()
    ink.drop(rect.left + rect.width / 2, rect.bottom + 10, "assistant", 1.4, 1.6)
    window.setTimeout(props.onDone, motionReduced() ? 0 : 700)
  })

  const failure = () => (props.phase === "error" ? props.failure && FAILURES[props.failure.kind] : undefined)
  const status = () => failure()?.title ?? STATUS[props.phase]
  const sized = () => props.phase === "installing" && props.progress !== undefined
  const fetched = () => {
    const download = props.download
    if (download?.received === undefined) return props.detail
    const amount = download.total ? `${megabytes(download.received)} of ${megabytes(download.total)} MB` : `${megabytes(download.received)} MB`
    return `opencode ${download.version} · ${amount}`
  }

  return (
    <div class="boot" classList={{ leaving: leaving(), failed: props.phase === "error" }} data-tauri-drag-region>
      <WindowControls />
      <div class="boot-center" data-tauri-drag-region>
        <svg ref={drop} class="boot-drop" width="18" height="24" viewBox="0 0 12 15" aria-hidden="true">
          <path d="M6 .8C6 .8 1 6.6 1 9.6a5 5 0 0 0 10 0C11 6.6 6 .8 6 .8Z" />
        </svg>
        <div class="boot-ripples" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1 class="boot-name">weft</h1>
        <p class="boot-status" role="status">
          {status()}
          <Show when={sized()}>
            <span class="num"> · {Math.round((props.progress ?? 0) * 100)}%</span>
          </Show>
        </p>
        <Show when={props.phase === "installing"}>
          <div class="boot-progress" classList={{ unsized: !sized() }} aria-hidden="true">
            <span style={{ width: sized() ? `${Math.round((props.progress ?? 0) * 100)}%` : undefined }} />
          </div>
          <p class="boot-detail num">{fetched()}</p>
          <p class="boot-guide">{ONLINE_ONCE} Later starts use the copy it keeps.</p>
        </Show>
        <Show when={props.phase !== "installing" && props.phase !== "error" && props.detail}>
          <p class="boot-detail">{props.detail}</p>
        </Show>
        <Show when={props.phase === "error"}>
          <p class="boot-guide">{failure()?.guide ?? "The logs say what went wrong."}</p>
          <Show when={props.failure?.message}>
            {(message) => (
              <details class="boot-details">
                <summary>Details</summary>
                <p class="boot-detail selectable">{message()}</p>
              </details>
            )}
          </Show>
          <div class="boot-actions">
            <Show when={props.onRetry}>
              <button class="btn primary" onClick={() => props.onRetry?.()}>
                Try again
              </button>
            </Show>
            <Show when={props.onSettings}>
              <button class="btn" onClick={() => props.onSettings?.()}>
                Engine settings
              </button>
            </Show>
            <Show when={props.onLogs}>
              <button class="btn ghost" onClick={() => props.onLogs?.()}>
                Open logs
              </button>
            </Show>
            <Show when={props.onCopy}>
              <button class="btn ghost" onClick={() => props.onCopy?.()}>
                Copy details
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
