import { createContext, createSignal, onCleanup, onMount, Show, useContext, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { IconClose } from "../icons"
import { isTopLayer, pushLayer } from "./layer"
import { motionReduced } from "./motion"

/** The ink a dialog is drawn in: its title drop, the bar on the active row, the focus washes. */
export type DialogTint = "indigo" | "vermilion" | "ochre" | "teal" | "carmine"

const LEAVE_MS = 160

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const DialogContext = createContext<{ close: () => void; panel: () => HTMLDivElement }>()

/** Inside a Dialog: `close()` lets the sheet sink away, then calls the dialog's onClose; `panel()` is the sheet. */
export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error("useDialog() outside a <Dialog>")
  return ctx
}

export function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

/**
 * A modal sheet of raised paper over the softened water, with its title and a close button on top. Without a title the
 * sheet starts straight with its content, as the search pickers do. The last child is usually a `.dialog-foot` with key
 * hints and buttons. Focus is trapped; Esc and a click outside close it.
 */
export function Dialog(props: {
  onClose: () => void
  title?: JSX.Element
  /** Accessible name, when the title alone does not say what the dialog is for. */
  name?: string
  tint?: DialogTint
  /** Width in pixels. */
  width?: number
  align?: "center" | "top"
  class?: string
  children: JSX.Element
}) {
  const id = Symbol("dialog")
  const [leaving, setLeaving] = createSignal(false)
  let panel!: HTMLDivElement
  let restore: HTMLElement | null = null
  let timer = 0
  let pressedOutside = false

  const close = () => {
    if (leaving()) return
    setLeaving(true)
    timer = window.setTimeout(props.onClose, motionReduced() ? 0 : LEAVE_MS)
  }

  function trap(event: KeyboardEvent) {
    if (event.key !== "Tab" || !isTopLayer(id)) return
    const items = focusables(panel)
    if (!items.length) {
      event.preventDefault()
      panel.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  onMount(() => {
    restore = document.activeElement as HTMLElement | null
    onCleanup(pushLayer({ id, modal: true, close }))
    const target = panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel
    target.focus({ preventScroll: true })
  })
  onCleanup(() => {
    window.clearTimeout(timer)
    if (restore?.isConnected) restore.focus({ preventScroll: true })
  })

  return (
    <Portal>
      <div
        class="dialog-scrim"
        classList={{ leaving: leaving(), top: props.align === "top" }}
        onMouseDown={(e) => (pressedOutside = e.target === e.currentTarget)}
        onClick={(e) => {
          if (pressedOutside && e.target === e.currentTarget) close()
          pressedOutside = false
        }}
      >
        <div
          ref={panel}
          class={`dialog ${props.class ?? ""}`}
          classList={{ leaving: leaving() }}
          data-tint={props.tint ?? "indigo"}
          role="dialog"
          aria-modal="true"
          aria-label={props.name ?? (typeof props.title === "string" ? props.title : undefined)}
          tabIndex={-1}
          style={props.width ? { width: `${props.width}px` } : undefined}
          onKeyDown={trap}
        >
          <DialogContext.Provider value={{ close, panel: () => panel }}>
            <Show when={props.title !== undefined}>
              <header class="dialog-head">
                <h2 class="dialog-title">{props.title}</h2>
                <span class="spacer" />
                <button class="icon-btn dialog-x" onClick={close} aria-label="Close" title="Close (Esc)">
                  <IconClose size={13} />
                </button>
              </header>
            </Show>
            {props.children}
          </DialogContext.Provider>
        </div>
      </div>
    </Portal>
  )
}
