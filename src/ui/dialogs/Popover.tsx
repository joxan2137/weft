import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { focusables } from "./Dialog"
import { pushLayer } from "./layer"

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end"

const GAP = 6
const MARGIN = 8

/** A non-modal paper sheet anchored to an element, such as a menu. Esc, a click outside, or the anchor closes it. */
export function Popover(props: {
  anchor: HTMLElement
  onClose: () => void
  placement?: Placement
  label?: string
  class?: string
  children: JSX.Element
}) {
  const id = Symbol("popover")
  const [pos, setPos] = createSignal({ left: -9999, top: -9999 })
  let panel!: HTMLDivElement

  const place = () => {
    const a = props.anchor.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    const [side, align] = (props.placement ?? "bottom-start").split("-") as ["top" | "bottom", "start" | "end"]
    const below = a.bottom + GAP
    const above = a.top - GAP - p.height
    const fitsBelow = below + p.height <= innerHeight - MARGIN
    const fitsAbove = above >= MARGIN
    const top = side === "bottom" ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove || !fitsBelow ? above : below
    const left = align === "start" ? a.left : a.right - p.width
    setPos({
      left: Math.max(MARGIN, Math.min(left, innerWidth - p.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(top, innerHeight - p.height - MARGIN)),
    })
  }

  const outside = (event: PointerEvent) => {
    const target = event.target as Node
    if (!panel.contains(target) && !props.anchor.contains(target)) props.onClose()
  }

  onMount(() => {
    const anchor = props.anchor
    place()
    onCleanup(pushLayer({ id, modal: false, close: props.onClose }))
    document.addEventListener("pointerdown", outside, true)
    window.addEventListener("resize", place)
    focusables(panel)[0]?.focus({ preventScroll: true })
    onCleanup(() => {
      const active = document.activeElement
      const focusLost = !active || active === document.body || panel.contains(active)
      if (focusLost && anchor.isConnected) anchor.focus({ preventScroll: true })
    })
  })
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside, true)
    window.removeEventListener("resize", place)
  })

  function onKey(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const items = focusables(panel)
    if (!items.length) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === "ArrowDown" ? 1 : -1
    items[(at + step + items.length) % items.length].focus()
  }

  return (
    <Portal>
      <div
        ref={panel}
        class={`popover rise ${props.class ?? ""}`}
        role="dialog"
        aria-label={props.label}
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
        onKeyDown={onKey}
      >
        {props.children}
      </div>
    </Portal>
  )
}

/** A row in a popover menu: an optional icon, the label, an optional note or key on the right. */
export function MenuItem(props: { onSelect: () => void; danger?: boolean; hint?: string; children: JSX.Element }) {
  return (
    <button class="menu-item" classList={{ danger: props.danger }} role="menuitem" onClick={props.onSelect}>
      {props.children}
      {props.hint ? <kbd>{props.hint}</kbd> : null}
    </button>
  )
}
