import { createEffect, createSignal, For, on, Show, type Accessor, type JSX } from "solid-js"
import { IconSearch } from "../icons"

/** Keyboard cursor over a flat list of rows; rows carry `data-index` for scrolling into view. */
export function createCursor(count: Accessor<number>, reset?: Accessor<unknown>) {
  const [cursor, setCursor] = createSignal(0)
  let list: HTMLElement | undefined

  if (reset) createEffect(on(reset, () => setCursor(0), { defer: true }))
  createEffect(() => {
    const n = count()
    if (cursor() >= n) setCursor(Math.max(0, n - 1))
  })
  createEffect(() => {
    const i = cursor()
    list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" })
  })

  function move(step: number) {
    const n = count()
    if (n) setCursor((c) => (step === Infinity ? n - 1 : step === -Infinity ? 0 : Math.max(0, Math.min(n - 1, c + step))))
  }

  /** Arrow/Page/Home/End move, Enter chooses. Returns true when the key was used. */
  function onKey(event: KeyboardEvent, choose: (index: number) => void) {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }
    if (event.key in steps) move(steps[event.key])
    else if (event.key === "Home" && event.ctrlKey) move(-Infinity)
    else if (event.key === "End" && event.ctrlKey) move(Infinity)
    else if (event.key === "Enter" && !event.isComposing) choose(cursor())
    else return false
    event.preventDefault()
    return true
  }

  return { cursor, setCursor, onKey, bind: (el: HTMLElement) => (list = el) }
}

/** Text with fuzzy-match hits marked. */
export function Marked(props: { text: string; hits?: number[] }) {
  const pieces = () => {
    const hits = new Set(props.hits ?? [])
    if (!hits.size) return [{ text: props.text, hit: false }]
    const out: { text: string; hit: boolean }[] = []
    for (let i = 0; i < props.text.length; i++) {
      const hit = hits.has(i)
      const last = out[out.length - 1]
      if (last && last.hit === hit) last.text += props.text[i]
      else out.push({ text: props.text[i], hit })
    }
    return out
  }
  return <For each={pieces()}>{(p) => (p.hit ? <mark>{p.text}</mark> : p.text)}</For>
}

/** The search field on top of a list: what you type filters the rows below, and the count says how many match. */
export function Query(props: {
  value: string
  onInput: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  placeholder?: string
  label: string
  count?: JSX.Element
}) {
  return (
    <label class="query">
      <IconSearch size={16} />
      <input
        class="query-input"
        data-autofocus
        placeholder={props.placeholder}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => props.onKeyDown(e)}
        spellcheck={false}
        autocomplete="off"
        aria-label={props.label}
      />
      <Show when={props.count !== undefined}>
        <span class="query-count num">{props.count}</span>
      </Show>
    </label>
  )
}

/** Key hints for a dialog's footer: each key beside the plain word for what it does. */
export function KeyHints(props: { keys: [key: string, what: string][] }) {
  return (
    <span class="dlg-keys">
      <For each={props.keys}>
        {([key, what]) => (
          <span class="dlg-key">
            <kbd>{key}</kbd>
            {what}
          </span>
        )}
      </For>
    </span>
  )
}
