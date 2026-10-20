import { createSignal, Show } from "solid-js"
import { IconChevron } from "../icons"

/** Reasoning as the undercurrent: one quiet line until opened, then the model's thinking in full. */
export function Reverse(props: { text: string; seconds?: number; live?: boolean }) {
  const [open, setOpen] = createSignal(false)
  const first = () => props.text.replace(/\s+/g, " ").trim()
  return (
    <section class="reverse" classList={{ open: open(), live: props.live }}>
      <button class="reverse-tab" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <span class="reverse-label">{props.live ? "Thinking" : `Thought for ${(props.seconds ?? 0).toFixed(1)}s`}</span>
        <Show when={!open()}>
          <span class="reverse-peek">{first()}</span>
        </Show>
        <IconChevron dir={open() ? "up" : "down"} size={14} />
      </button>
      <div class="reverse-face">
        <div class="reverse-body selectable">{props.text}</div>
      </div>
    </section>
  )
}
