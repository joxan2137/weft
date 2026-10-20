import { Show } from "solid-js"
import { Mark } from "../art/Mark"
import { IconClose, IconDiff, IconMax, IconMin, IconPanel, IconSidebar, IconTerminal, IconWaves } from "./icons"
import { toastError } from "./dialogs/Toast"
import { inTauri, windowAction } from "./platform"

/** A path the way people say it: the home folder as `~`. */
export function tildify(path?: string) {
  if (!path) return ""
  return path.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~").replace(/^\/(home|Users)\/[^/]+/, "~").replace(/\\/g, "/")
}

/** Minimize, maximize and close for the frameless window; the boot screen keeps them too. */
export function WindowControls() {
  const act = (action: Parameters<typeof windowAction>[0]) => () => void windowAction(action).catch(toastError)
  return (
    <Show when={inTauri}>
      <div class="win">
        <button onClick={act("minimize")} aria-label="Minimize">
          <IconMin size={12} />
        </button>
        <button onClick={act("toggleMaximize")} aria-label="Maximize">
          <IconMax size={12} />
        </button>
        <button class="close" onClick={act("close")} aria-label="Close">
          <IconClose size={12} />
        </button>
      </div>
    </Show>
  )
}

/** The quiet strip on top of the water: the mark, the session's title, the panel toggles, window controls. */
export function Titlebar(props: {
  title?: string
  directory?: string
  live?: boolean
  bookOpen: boolean
  draftOpen: boolean
  clothOpen: boolean
  reviewOpen?: boolean
  terminalOpen?: boolean
  onBook: () => void
  onDraft: () => void
  onCloth: () => void
  onReview?: () => void
  onTerminal?: () => void
}) {
  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        <button class="tb-btn" classList={{ on: props.bookOpen }} onClick={props.onBook} title="Sessions">
          <IconSidebar size={16} />
        </button>
        <Mark live={props.live} />
      </div>
      <div class="tb-title" data-tauri-drag-region>
        <Show when={props.title}>
          <span class="tb-session" data-tauri-drag-region>
            {props.title}
          </span>
        </Show>
        <Show when={props.live}>
          <span class="tb-live" data-tauri-drag-region>
            answering
          </span>
        </Show>
      </div>
      <nav class="tb-panes" aria-label="panels">
        <button class="tb-btn" classList={{ on: props.clothOpen }} onClick={props.onCloth} title="The whole conversation">
          <IconWaves size={16} />
        </button>
        <Show when={props.onReview}>
          <button class="tb-btn" classList={{ on: props.reviewOpen }} onClick={() => props.onReview?.()} title="Review changes">
            <IconDiff size={16} />
          </button>
        </Show>
        <Show when={props.onTerminal}>
          <button class="tb-btn" classList={{ on: props.terminalOpen }} onClick={() => props.onTerminal?.()} title="Terminal (Ctrl `)">
            <IconTerminal size={16} />
          </button>
        </Show>
        <button class="tb-btn" classList={{ on: props.draftOpen }} onClick={props.onDraft} title="Currents: context, tokens, cost">
          <IconPanel size={16} />
        </button>
      </nav>
      <WindowControls />
    </header>
  )
}
