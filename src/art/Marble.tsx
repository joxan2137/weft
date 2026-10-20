import { createEffect, createSignal, onCleanup } from "solid-js"
import { marbleCached, marbleURL } from "./marbling"
import { theme } from "../theme/theme"
import type { Draft } from "./weave"

const SLICE_MS = 6

const idle: (run: () => void) => void =
  typeof requestIdleCallback === "function" ? (run) => requestIdleCallback(run, { timeout: 400 }) : (run) => setTimeout(run, 16)

const queue = new Set<() => void>()
let draining = false

/** Prints uncached marbles a few at a time between frames, so a long session list never blocks a frame. */
function drain() {
  const start = performance.now()
  for (const paint of queue) {
    queue.delete(paint)
    paint()
    if (performance.now() - start > SLICE_MS) break
  }
  if (queue.size) idle(drain)
  else draining = false
}

function later(paint: () => void) {
  queue.add(paint)
  if (!draining) {
    draining = true
    idle(drain)
  }
  return () => queue.delete(paint)
}

/** A session's marbled print: its own messages floated as inks and combed (docs/DESIGN.md A.5.3). */
export function Marble(props: { draft: Draft; seed: string; size?: number; class?: string }) {
  const size = () => props.size ?? 34
  const [url, setUrl] = createSignal<string>()
  createEffect(() => {
    const [draft, seed, s] = [props.draft, props.seed, size()]
    theme()
    const hit = marbleCached(draft, seed, s)
    if (hit) setUrl(hit)
    else onCleanup(later(() => setUrl(marbleURL(draft, seed, s))))
  })
  return (
    <span class={`marble ${props.class ?? ""}`} style={{ width: `${size()}px`, height: `${size()}px` }} aria-hidden="true">
      <img src={url()} width={size()} height={size()} alt="" draggable={false} />
    </span>
  )
}
