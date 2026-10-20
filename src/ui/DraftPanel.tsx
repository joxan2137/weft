import type { Todo } from "@opencode-ai/sdk/v2/types"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Vessel } from "../art/Vessel"
import type { ContextView, LoomView } from "../engine/view"
import { SPEAKER } from "./Pick"

const LAYERS = [
  { dye: "system", name: SPEAKER.system },
  { dye: "user", name: SPEAKER.user },
  { dye: "assistant", name: SPEAKER.assistant },
  { dye: "tool", name: "Tools" },
] as const

function compact(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function byLayer(ctx: ContextView) {
  const totals = new Map<string, number>()
  for (const s of ctx.spent) totals.set(s.dye, (totals.get(s.dye) ?? 0) + s.tokens)
  return LAYERS.map((s) => ({ ...s, tokens: totals.get(s.dye) ?? 0 }))
}

const CHANGE: Record<string, string> = { added: "new", deleted: "deleted", modified: "edited" }

/**
 * The currents drawer: what the conversation holds and costs. The context as a glass filled by
 * who used it, the spend, the plan, the changed files, the engine. Below 1180 px it folds to a rail.
 */
export function DraftPanel(props: { loom: Pick<LoomView, "context" | "changed" | "engine">; todos: Todo[] }) {
  const ctx = () => props.loom.context
  const used = () => ctx().spent.reduce((a, s) => a + s.tokens, 0)
  const known = () => ctx().limit > 0
  const pct = () => (known() ? `${Math.round((used() / ctx().limit) * 100)}%` : "unknown")
  const cost = () => `$${ctx().cost.toFixed(2)}`
  const [peek, setPeek] = createSignal(import.meta.env.DEV && new URLSearchParams(location.search).has("peek"))
  let panel!: HTMLElement

  const closeOutside = (event: PointerEvent) => peek() && !panel.contains(event.target as Node) && setPeek(false)
  const closeOnEscape = (event: KeyboardEvent) => peek() && event.key === "Escape" && setPeek(false)
  onMount(() => {
    window.addEventListener("pointerdown", closeOutside)
    window.addEventListener("keydown", closeOnEscape)
  })
  onCleanup(() => {
    window.removeEventListener("pointerdown", closeOutside)
    window.removeEventListener("keydown", closeOnEscape)
  })

  const plan = () => props.todos.filter((t) => t.status !== "cancelled")
  const finished = () => props.todos.filter((t) => t.status === "completed").length

  return (
    <aside ref={panel} class="draft currents" classList={{ peek: peek() }}>
      <button class="draft-rail" onClick={() => setPeek(true)} title={`Context ${pct()} · ${compact(used())} of ${known() ? compact(ctx().limit) : "an unknown window"} · ${cost()}`}>
        <Vessel limit={known() ? ctx().limit : 0} spent={ctx().spent} size={20} />
        <span class="num rail-cost">{cost()}</span>
      </button>

      <section class="draft-sec context">
        <h3 class="label">Context</h3>
        <div class="glass">
          <Vessel limit={known() ? ctx().limit : 0} spent={ctx().spent} size={46} title={`Context ${pct()} full`} />
          <div class="glass-text">
            <span class="glass-pct num">{pct()}</span>
            <span class="glass-of num">
              {compact(used())} of {known() ? compact(ctx().limit) : "?"} tokens
            </span>
          </div>
        </div>
        <ul class="ledger">
          <For each={byLayer(ctx())}>
            {(s) => (
              <li data-role={s.dye}>
                <span class="drop" />
                <span>{s.name}</span>
                <span class="num">{compact(s.tokens)}</span>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="draft-sec">
        <h3 class="label">
          Spent <span class="num sec-value">{cost()}</span>
        </h3>
        <ul class="ledger">
          <li>
            <span>Read</span>
            <span class="num">{compact(ctx().input)}</span>
          </li>
          <li>
            <span>From cache</span>
            <span class="num">{compact(ctx().cacheRead)}</span>
          </li>
          <li>
            <span>Written</span>
            <span class="num">{compact(ctx().output)}</span>
          </li>
          <li>
            <span>Thinking</span>
            <span class="num">{compact(ctx().reasoning)}</span>
          </li>
        </ul>
      </section>

      <Show when={plan().length}>
        <section class="draft-sec">
          <h3 class="label">
            Plan{" "}
            <span class="num sec-value">
              {finished()} of {props.todos.length}
            </span>
          </h3>
          <ul class="plan">
            <For each={plan()}>
              {(t) => (
                <li class={`todo ${t.status}`}>
                  <span class="todo-mark" />
                  <span class="todo-text">{t.content}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={props.loom.changed.length}>
        <section class="draft-sec">
          <h3 class="label">Changed files</h3>
          <ul class="changed">
            <For each={props.loom.changed}>
              {(f) => (
                <li title={`${f.path}: ${CHANGE[f.status ?? "modified"] ?? "edited"}`} data-status={f.status}>
                  <span class="file">{f.path.split(/[\\/]/).pop()}</span>
                  <span class="num add">+{f.additions}</span>
                  <span class="num del">−{f.deletions}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <section class="draft-sec engine">
        <h3 class="label">Engine</h3>
        <p class="engine-line">
          <span class={`dot ${props.loom.engine.state}`} />
          opencode {props.loom.engine.version}
          <span class="dim num"> · {props.loom.engine.url.replace(/^https?:\/\//, "")}</span>
        </p>
      </section>
    </aside>
  )
}
