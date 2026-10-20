import type { PermissionRequest } from "@opencode-ai/sdk/v2/types"
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { ink, type InkName } from "../art/ink"
import type { PickView } from "../engine/view"
import { theme } from "../theme/theme"
import { IconArrow } from "./icons"
import { Knot, type KnotReply } from "./Knot"
import { Pick, type PickActions } from "./Pick"

const STICK_PX = 80
const OLDER_PX = 240
const DROP: Record<InkName, number> = { user: 1, assistant: 0.55, tool: 0.35, system: 0.7, cut: 0 }
const POUR = 12
/** Only the last few messages are new arrivals; anything earlier came in with an older page. */
const ARRIVALS = 3

function inkOf(pick: PickView): InkName {
  return pick.parts.length > 0 && pick.parts.every((p) => p.type === "tool") ? "tool" : pick.role
}

/**
 * Opening a session pours its own inks into the water, down both sides of the column: the source
 * at the top, then the latest messages in order. The same session always pours the same way.
 */
function pour(picks: PickView[], column: DOMRect) {
  const height = window.innerHeight
  if (picks[0]?.warp) ink.drop(column.left - 96, height * 0.1, "system", 0.7, 1.7)
  const recent = picks.filter((p) => !p.warp).slice(-POUR)
  recent.forEach((pick, i) => {
    const name = inkOf(pick)
    const reach = 64 + ((i * 37) % 70)
    const x = i % 2 === 0 ? column.left - reach : column.right + reach
    const y = height * (0.16 + (0.72 * (i + 0.5)) / recent.length)
    ink.drop(x, y, name, 0.35 + DROP[name] * 0.45, 1.25 + ((i * 13) % 5) / 10)
  })
}

/** The conversation: one readable column over the water, the inkwell below it. */
export function Cloth(props: {
  picks: PickView[]
  permission?: PermissionRequest
  /** title of the subagent session the permission request comes from */
  permissionFrom?: string
  root?: string
  actions: PickActions
  onPermission: (reply: KnotReply) => void
  /** the session is running a turn */
  busy?: boolean
  /** shown when the conversation holds nothing but the system prompt */
  empty?: JSX.Element
  /** a band under the last message (session errors) */
  notice?: JSX.Element
  /** a strip above the conversation (liberation warning) */
  banner?: JSX.Element
  /** the session's head above the first message */
  head?: JSX.Element
  /** the column the water keeps clear for reading */
  onColumn?: (el: HTMLElement) => void
  hasOlder?: boolean
  loadingOlder?: boolean
  onOlder?: () => Promise<void> | void
  children?: JSX.Element
}) {
  let wrap!: HTMLDivElement
  let scroller!: HTMLDivElement
  let weave!: HTMLDivElement
  const [pinned, setPinned] = createSignal(!(import.meta.env.DEV && new URLSearchParams(location.search).has("top")))
  let frame = 0
  let programmatic = false
  let fetchingOlder = false
  let seen: Set<string> | undefined
  let session: string | undefined

  // Already at the bottom no scroll event fires: a flag left set would swallow the reader's next scroll and keep the view pinned.
  const toBottom = () => {
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 1) return
    programmatic = true
    scroller.scrollTop = scroller.scrollHeight
  }

  /** A message that was not there before drops into the water beside it; a session's first paint pours instead. */
  const dropNew = () => {
    if (!props.picks.length) return
    const id = props.picks[0].info.sessionID
    if (id !== session) {
      session = id
      seen = undefined
    }
    const first = !seen
    const known = (seen ??= new Set())
    weave.querySelectorAll<HTMLElement>("article.pick").forEach((el) => {
      const index = Number(el.dataset.pick)
      const pick = props.picks[index]
      if (!pick || known.has(pick.id)) return
      known.add(pick.id)
      if (first || pick.warp || index < props.picks.length - ARRIVALS) return
      const rect = el.getBoundingClientRect()
      const name = inkOf(pick)
      ink.drop(rect.left - 30, rect.top + 22, name, DROP[name], name === "user" ? 1 : 0.7)
    })
    if (first) pour(props.picks, weave.getBoundingClientRect())
  }

  const measure = () => {
    frame = 0
    // An open editor grows under the reader's eyes: keep it where it is instead of chasing the bottom.
    if (weave.querySelector("article.pick.editing")) setPinned(false)
    else if (pinned()) toBottom()
    dropNew()
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure)
  }

  /**
   * The inkwell floats over the bottom of the scroller: the words fade out above it (--fell-h, how
   * much of the scroller it covers) and the jump to new words sits on it (--fell-reach, from the bottom).
   */
  const measureInkwell = (inkwell: Element) => {
    const top = inkwell.getBoundingClientRect().top
    const floor = scroller.getBoundingClientRect().bottom
    wrap.style.setProperty("--fell-h", `${Math.max(0, Math.round(floor - top))}px`)
    wrap.style.setProperty("--fell-reach", `${Math.round(wrap.getBoundingClientRect().bottom - Math.min(floor, top))}px`)
  }

  onMount(() => {
    props.onColumn?.(weave)
    const inkwell = wrap.querySelector(".fell-box")
    if (inkwell) {
      const reach = new ResizeObserver(() => measureInkwell(inkwell))
      reach.observe(scroller)
      reach.observe(inkwell)
      onCleanup(() => reach.disconnect())
    }
    const resize = new ResizeObserver(schedule)
    const mutate = new MutationObserver(() => {
      weave.querySelectorAll("article.pick").forEach((el) => resize.observe(el))
      schedule()
    })
    resize.observe(weave)
    mutate.observe(weave, { childList: true, subtree: false })
    weave.querySelectorAll("article.pick").forEach((el) => resize.observe(el))
    schedule()
    onCleanup(() => {
      resize.disconnect()
      mutate.disconnect()
      cancelAnimationFrame(frame)
    })
  })

  // Day and night inks are different colours: the water empties on a change, and the session pours again.
  createEffect(
    on(
      theme,
      () => {
        seen = undefined
        schedule()
      },
      { defer: true },
    ),
  )

  /** Older pages arrive above the reader: keep the distance from the bottom so the view does not jump. */
  async function older() {
    if (fetchingOlder || !props.hasOlder || props.loadingOlder || !props.onOlder) return
    fetchingOlder = true
    const fromBottom = scroller.scrollHeight - scroller.scrollTop
    try {
      await props.onOlder()
    } finally {
      fetchingOlder = false
    }
    requestAnimationFrame(() => {
      programmatic = true
      scroller.scrollTop = scroller.scrollHeight - fromBottom
    })
  }

  const onScroll = () => {
    if (scroller.scrollTop < OLDER_PX) void older()
    if (programmatic) {
      programmatic = false
      return
    }
    setPinned(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX)
  }
  const live = () => props.picks.some((p) => p.live)
  const bare = () => props.picks.every((p) => p.warp)
  const movable = (pick: PickView) => !pick.warp

  return (
    <div class="cloth-wrap" ref={wrap}>
      {props.banner}
      <div class="cloth" ref={scroller} onScroll={onScroll}>
        <div class="cloth-weave" ref={weave}>
          {props.head}
          <Show when={props.hasOlder}>
            <button class="older" onClick={() => void older()} disabled={props.loadingOlder}>
              {props.loadingOlder ? "Reading earlier messages…" : "Load earlier messages"}
            </button>
          </Show>
          <For each={props.picks}>
            {(pick, i) => (
              <Pick
                pick={pick}
                index={i()}
                actions={props.actions}
                root={props.root}
                busy={props.busy}
                canMoveUp={movable(pick) && i() > 1 && movable(props.picks[i() - 1])}
                canMoveDown={movable(pick) && i() < props.picks.length - 1}
                later={props.picks.length - 1 - i()}
              />
            )}
          </For>
          <Show when={bare() && !props.permission}>{props.empty}</Show>
          {props.notice}
          <Show when={props.permission}>
            {(req) => <Knot request={req()} from={props.permissionFrom} onReply={props.onPermission} />}
          </Show>
        </div>
      </div>
      <Show when={!pinned() && live()}>
        <button
          class="jump"
          onClick={() => {
            setPinned(true)
            toBottom()
          }}
        >
          <IconArrow dir="down" size={14} /> New words below
        </button>
      </Show>
      {props.children}
    </div>
  )
}
