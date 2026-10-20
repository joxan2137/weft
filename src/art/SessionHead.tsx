import { Show } from "solid-js"
import { Marble } from "./Marble"
import type { Draft } from "./weave"

function stamp(ms: number) {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

/** The head of an open session: its marbled print, its title, and when it began. */
export function SessionHead(props: { id: string; title: string; draft: Draft; created: number; updated: number; model?: string }) {
  return (
    <header class="session-head">
      <Marble draft={props.draft} seed={props.id} size={52} class="head-marble" />
      <div class="head-text">
        <h1 class="head-title">{props.title}</h1>
        <p class="head-meta">
          Started {stamp(props.created)}
          <Show when={props.updated - props.created > 60_000}> · last changed {stamp(props.updated)}</Show>
          <Show when={props.model}> · {props.model}</Show>
        </p>
      </div>
    </header>
  )
}
