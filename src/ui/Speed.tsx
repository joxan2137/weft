import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { CHARS_PER_TOKEN, measuredRate, rateLabel, streamedChars } from "../engine/speed"
import type { PickView } from "../engine/view"

/** Until then the first chunks outweigh the rest and the estimate jumps around. */
const SETTLE_MS = 400
const TICK_MS = 300

/** Timed from the first chunk seen arriving: the wait for the first token, and text that was there before the reply was opened, stay out. */
type Watch = { id: string; at?: number; chars: number; lastAt: number; lastChars: number }

/**
 * Output tokens a second of a reply: estimated from the streamed text while it is live, then the
 * engine's own count over the time the model spent writing.
 */
export function Speed(props: { reply?: PickView }) {
  const [estimate, setEstimate] = createSignal<{ id: string; rate: number }>()
  let watch: Watch | undefined
  const liveID = createMemo(() => (props.reply?.live ? props.reply.id : undefined))

  // Runs on every store flush of the reply; a stall keeps the last rate instead of decaying it,
  // so a tool call in the middle of a reply does not read as a slow model.
  createEffect(() => {
    const reply = props.reply
    if (!reply?.live) return
    const chars = streamedChars(reply.parts)
    const now = performance.now()
    if (watch?.id !== reply.id) watch = { id: reply.id, chars, lastAt: now, lastChars: chars }
    else if (chars > watch.lastChars) {
      if (watch.at === undefined) {
        watch.at = now
        watch.chars = chars
      }
      watch.lastAt = now
      watch.lastChars = chars
    }
  })

  createEffect(
    on(liveID, (id) => {
      if (!id) return
      const timer = window.setInterval(() => {
        if (watch?.id !== id || watch.at === undefined) return
        const elapsed = watch.lastAt - watch.at
        if (elapsed >= SETTLE_MS) setEstimate({ id, rate: (watch.lastChars - watch.chars) / CHARS_PER_TOKEN / (elapsed / 1000) })
      }, TICK_MS)
      onCleanup(() => window.clearInterval(timer))
    }),
  )

  const shown = createMemo(() => {
    const reply = props.reply
    if (!reply) return undefined
    const guess = estimate()?.id === reply.id ? estimate()!.rate : undefined
    const rate = reply.live ? guess : (measuredRate(reply.info, reply.parts) ?? guess)
    return rate === undefined ? undefined : { rate, live: !!reply.live }
  })

  return (
    <Show when={shown()}>
      {(s) => (
        <span
          class="num speed"
          classList={{ live: s().live }}
          title={s().live ? "Output tokens a second, estimated from the text streamed so far" : "Output tokens a second of the last reply, while the model was writing"}
        >
          {rateLabel(s().rate)} tok/s
        </span>
      )}
    </Show>
  )
}
