import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { demoSnapshot, isDemoName } from "./demo"
import {
  DoneMark,
  IconArrowUpRight,
  IconCheck,
  IconCross,
  IconPause,
  IconPlay,
  IconStop,
  Needle,
  RowIcon,
  Spinner,
  Starburst,
} from "./icons"
import type { TopbarAction, TopbarActionKind, TopbarSnapshot } from "./types"

const CARD_WIDTH = 560
const COMPACT_WIDTH = 320
const COMPACT_HEIGHT = 60
const ROW_HEIGHT = 41.4
const CARD_REST = 212
const COMPACT_MS = 250
const EXPAND_MS = 420
const FADE_MS = 160
const BOUNDS_INSET = 14
const FRESH_MS = 4_000

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<T>(command, args)
  } catch {
    return null
  }
}

function isFresh(snapshot: TopbarSnapshot) {
  return snapshot.status === "running" && snapshot.rows.length === 0 && Date.now() - snapshot.startedAt < FRESH_MS
}

function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function secondsText(value?: number) {
  return value === undefined ? "" : `${value}s`
}

function stepText(snapshot: TopbarSnapshot) {
  if (snapshot.status === "done") {
    return snapshot.stepsTotal > 0 ? `${snapshot.stepsTotal} of ${snapshot.stepsTotal} steps` : "Done"
  }
  if (snapshot.status === "error") return "Stopped"
  if (snapshot.stepsTotal <= 0) return "Working"
  const step =
    snapshot.status === "approval"
      ? Math.min(snapshot.stepsDone + 1, snapshot.stepsTotal)
      : Math.max(1, snapshot.stepsDone)
  return `Step ${step} of ${snapshot.stepsTotal}`
}

type CardProps = {
  snapshot: TopbarSnapshot
  compact: boolean
  expanding: boolean
  leaving: boolean
  paused: boolean
  width: number
  height: number
  timer: string
  onNode: (element: HTMLDivElement) => void
  onPause: () => void
  onAction: (kind: TopbarActionKind) => void
}

function Card(props: CardProps) {
  const rows = createMemo(() => props.snapshot.rows.slice(-5))
  const segments = createMemo(() => Math.max(0, Math.min(12, props.snapshot.stepsTotal)))
  const completed = createMemo(() => {
    if (props.snapshot.status === "done") return segments()
    return Math.min(segments(), Math.max(0, props.snapshot.stepsDone))
  })
  const titleMeta = createMemo(() => {
    if (props.snapshot.titleMeta) return props.snapshot.titleMeta
    if (props.snapshot.status === "done" && props.snapshot.filesChanged) {
      return `· ${props.snapshot.filesChanged} files changed`
    }
    return undefined
  })
  const release = (event: PointerEvent) => event.preventDefault()

  return (
    <div
      ref={(element) => props.onNode(element)}
      class="card"
      classList={{
        compact: props.compact,
        expanding: props.expanding,
        leaving: props.leaving,
        approval: props.snapshot.status === "approval",
        done: props.snapshot.status === "done",
      }}
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
    >
      <header class="head">
        <Show
          when={props.snapshot.status === "done"}
          fallback={
            <div class="avatar">
              <Show when={props.snapshot.source === "claude"} fallback={<Needle />}>
                <Starburst />
              </Show>
              <Show when={props.snapshot.status === "running" || props.snapshot.status === "approval"}>
                <Spinner />
              </Show>
              <Show when={props.snapshot.status === "approval"}>
                <span class="approval-dot" />
              </Show>
            </div>
          }
        >
          <DoneMark />
        </Show>

        <Show when={props.snapshot.status !== "done"}>
          <span class="action">
            <RowIcon kind={props.snapshot.action} size={19} />
          </span>
        </Show>

        <h1 class="title">
          <span class="title-lead">{props.snapshot.title}</span>
          <Show when={titleMeta()}>
            <span class="title-meta">{titleMeta()}</span>
          </Show>
        </h1>

        <Show when={props.snapshot.status !== "done"}>
          <span class="timer">{props.timer}</span>
        </Show>
      </header>

      <Show when={!props.compact}>
        <div class="body">
          <div class="meta">
            <span class="model">{props.snapshot.model ?? "Weft"}</span>
            <span class="step">{stepText(props.snapshot)}</span>
          </div>

          <Show
            when={segments() > 0}
            fallback={
              <div class="progress indeterminate">
                <span />
              </div>
            }
          >
            <div class="progress">
              <For each={Array.from({ length: segments() })}>
                {(_, index) => <span class="seg" classList={{ on: index() < completed() }} />}
              </For>
            </div>
          </Show>

          <div class="rows">
            <For each={rows()}>
              {(row) => (
                <div class="row" classList={{ active: row.active }}>
                  <span class="row-icon">
                    <RowIcon kind={row.kind} />
                  </span>
                  <span class="row-label">{row.label}</span>
                  <span class="row-time">{secondsText(row.seconds)}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        <footer class="foot">
          <Show when={props.snapshot.status === "approval"}>
            <button
              type="button"
              tabIndex={-1}
              class="pill approve"
              onPointerDown={release}
              onClick={() => props.onAction("approve")}
            >
              <IconCheck size={16} />
              <span>Approve</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              class="pill"
              onPointerDown={release}
              onClick={() => props.onAction("deny")}
            >
              <IconCross size={15} />
              <span>Deny</span>
            </button>
          </Show>

          <Show when={props.snapshot.status === "running"}>
            <button
              type="button"
              tabIndex={-1}
              class="pill"
              onPointerDown={release}
              onClick={props.onPause}
            >
              <Show when={props.paused} fallback={<IconPause size={15} />}>
                <IconPlay size={15} />
              </Show>
              <span>{props.paused ? "Resume" : "Pause"}</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              class="pill"
              onPointerDown={release}
              onClick={() => props.onAction("stop")}
            >
              <IconStop size={15} />
              <span>Stop</span>
            </button>
          </Show>

          <button
            type="button"
            tabIndex={-1}
            class="open"
            onPointerDown={release}
            onClick={() => props.onAction("open")}
          >
            <span>Open run</span>
            <IconArrowUpRight size={16} />
          </button>
        </footer>
      </Show>
    </div>
  )
}

export function App(props: { demo?: string | null }) {
  const demo = isDemoName(props.demo) ? demoSnapshot(props.demo) : null
  const [snapshot, setSnapshot] = createSignal<TopbarSnapshot | null>(demo?.snapshot ?? null)
  const [pinned, setPinned] = createSignal<{ snapshot: TopbarSnapshot; elapsed: number } | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [compact, setCompact] = createSignal(demo?.compact ?? false)
  const [expanding, setExpanding] = createSignal(false)
  const [leaving, setLeaving] = createSignal(false)
  const [node, setNode] = createSignal<HTMLDivElement>()

  let settle: number | undefined
  let expandReset: number | undefined
  let fade: number | undefined
  let visible = false

  const shown = createMemo(() => pinned()?.snapshot ?? snapshot())
  const rows = createMemo(() => (shown()?.rows ?? []).slice(-5))
  const elapsed = createMemo(() => {
    const current = shown()
    if (!current) return 0
    const frozen = pinned()
    if (frozen) return frozen.elapsed
    if (current.status === "done") return current.elapsedMs ?? 0
    if (demo) return demo.seconds * 1000
    return Math.max(0, now() - current.startedAt)
  })
  const height = () => (compact() ? COMPACT_HEIGHT : CARD_REST + rows().length * ROW_HEIGHT)
  const width = () => (compact() ? COMPACT_WIDTH : CARD_WIDTH)

  const sendBounds = () => {
    const element = node()
    if (!element || !isTauri()) return
    const rect = element.getBoundingClientRect()
    void call("topbar_bounds", {
      x: Math.round(rect.left - BOUNDS_INSET),
      y: Math.round(rect.top - BOUNDS_INSET),
      width: Math.round(rect.width + BOUNDS_INSET * 2),
      height: Math.round(rect.height + BOUNDS_INSET * 2),
    })
  }

  const showWindow = () => {
    if (visible) return
    visible = true
    void call("topbar_set_visible", { visible: true })
  }

  const hide = () => {
    if (!snapshot()) return
    setPinned(null)
    setLeaving(true)
    if (fade !== undefined) window.clearTimeout(fade)
    fade = window.setTimeout(() => {
      fade = undefined
      visible = false
      setLeaving(false)
      setSnapshot(null)
      void call("topbar_set_visible", { visible: false })
    }, FADE_MS)
  }

  const expand = () => {
    setCompact(false)
    setExpanding(true)
    if (expandReset !== undefined) window.clearTimeout(expandReset)
    expandReset = window.setTimeout(() => {
      expandReset = undefined
      setExpanding(false)
    }, EXPAND_MS + 40)
  }

  const enterCompact = () => {
    setCompact(true)
    setExpanding(true)
    if (settle !== undefined) window.clearTimeout(settle)
    settle = window.setTimeout(() => {
      settle = undefined
      expand()
    }, COMPACT_MS)
  }

  const apply = (next: TopbarSnapshot | null) => {
    if (next === null) {
      hide()
      return
    }
    if (fade !== undefined) {
      window.clearTimeout(fade)
      fade = undefined
    }
    setLeaving(false)
    const first = snapshot() === null
    setSnapshot(next)
    showWindow()
    if (first && isFresh(next)) {
      enterCompact()
    } else if (next.rows.length > 0 && compact()) {
      if (settle !== undefined) {
        window.clearTimeout(settle)
        settle = undefined
      }
      expand()
    }
  }

  const act = (kind: TopbarActionKind) => {
    const current = snapshot()
    if (!current) return
    const action: TopbarAction = {
      kind,
      source: current.source,
      sessionId: current.sessionId,
    }
    if (kind === "approve" || kind === "deny") action.requestId = current.approval?.requestId
    void call("topbar_action", { action })
  }

  const togglePause = () => {
    if (pinned()) {
      setPinned(null)
      setNow(Date.now())
      return
    }
    const current = snapshot()
    if (current) setPinned({ snapshot: current, elapsed: Math.max(0, Date.now() - current.startedAt) })
  }

  createEffect(() => {
    const element = node()
    if (!element) return
    const observer = new ResizeObserver(() => sendBounds())
    observer.observe(element)
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === element) sendBounds()
    }
    element.addEventListener("transitionend", onTransitionEnd)
    sendBounds()
    onCleanup(() => {
      observer.disconnect()
      element.removeEventListener("transitionend", onTransitionEnd)
    })
  })

  createEffect(() => {
    shown()
    compact()
    rows().length
    if (!isTauri() || !node()) return
    const frame = requestAnimationFrame(() => sendBounds())
    onCleanup(() => cancelAnimationFrame(frame))
  })

  onMount(() => {
    if (demo) return
    const tick = window.setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => window.clearInterval(tick))
  })

  onMount(() => {
    if (demo || !isTauri()) return
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        unlisten = await listen<TopbarSnapshot | null>("topbar:state", (event) => apply(event.payload))
      } catch {
        unlisten = undefined
      }
      const initial = await call<TopbarSnapshot | null>("topbar_ready")
      if (initial) apply(initial)
    })()
    onCleanup(() => unlisten?.())
  })

  onCleanup(() => {
    if (settle !== undefined) window.clearTimeout(settle)
    if (expandReset !== undefined) window.clearTimeout(expandReset)
    if (fade !== undefined) window.clearTimeout(fade)
  })

  return (
    <div class="stage">
      <Show when={shown()}>
        {(current) => (
          <Card
            snapshot={current()}
            compact={compact()}
            expanding={expanding()}
            leaving={leaving()}
            paused={pinned() !== null}
            width={width()}
            height={height()}
            timer={clock(elapsed())}
            onNode={setNode}
            onPause={togglePause}
            onAction={act}
          />
        )}
      </Show>
    </div>
  )
}
