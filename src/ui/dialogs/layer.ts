import { createSignal } from "solid-js"

type Layer = { id: symbol; modal: boolean; close: () => void }

const layers: Layer[] = []
const [depth, setDepth] = createSignal(0)
let listening = false

function onKey(event: KeyboardEvent) {
  const top = layers[layers.length - 1]
  if (!top) return
  if (event.key === "Escape" && !event.defaultPrevented) {
    event.preventDefault()
    top.close()
  }
  if (top.modal || event.key === "Escape") event.stopPropagation()
}

/** Registers an overlay; the newest one owns Esc, and a modal one keeps keys from the app behind it. */
export function pushLayer(layer: Layer) {
  if (!listening) {
    document.addEventListener("keydown", onKey)
    listening = true
  }
  layers.push(layer)
  setDepth(layers.length)
  return () => {
    const at = layers.indexOf(layer)
    if (at >= 0) layers.splice(at, 1)
    setDepth(layers.length)
  }
}

export const isTopLayer = (id: symbol) => depth() > 0 && layers[layers.length - 1]?.id === id

export const overlayOpen = () => depth() > 0

const writing = (element: Element) => !!element.closest("textarea, input, select, [contenteditable]")

/**
 * A card that answers to single keys (Y, A, N or 1–9) takes the focus when it appears, unless a field has it:
 * the next message's first letter must never answer the card. `release` puts the focus back where it was.
 */
export function takeFocus(card: HTMLElement) {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const held = !overlayOpen() && !(before && writing(before))
  if (held) card.focus({ preventScroll: true })
  const giveBack = () => before?.isConnected && before.focus({ preventScroll: true })
  return {
    /** A key the card does not answer goes back to where the user was, so typing is never lost. */
    returnFocus() {
      if (held && card.contains(document.activeElement)) giveBack()
    },
    release() {
      if (held && (card.contains(document.activeElement) || document.activeElement === document.body)) giveBack()
    },
  }
}
