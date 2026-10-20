import { Show } from "solid-js"
import { useWeft } from "../engine/context"
import { currentModel, openDialog } from "./dialogs"
import { IconPlug } from "./icons"

/** The empty loom still renders from props alone (the mock harness) when no engine is provided. */
function useWeftIfProvided() {
  try {
    return useWeft()
  } catch {
    return undefined
  }
}

/** A fresh session: still water. Only the source is in it; the first message is the first drop. */
export function EmptyLoom(props: { hint?: string }) {
  const weft = useWeftIfProvided()
  /** Providers are listed but none gives a model to send to. */
  const modelless = () => {
    const state = weft?.state
    return !!state && state.engine.state === "ready" && state.providers.all.length > 0 && !currentModel(state)
  }
  const connectedNone = () => weft?.state.providers.connected.length === 0
  return (
    <div class="empty-loom rise">
      <h2 class="empty-title">Still water.</h2>
      <p class="empty-sub">{props.hint ?? "Write something to begin."}</p>
      <Show when={modelless()}>
        <div class="empty-connect">
          <p class="empty-connect-text">
            {connectedNone()
              ? "No model provider is connected yet. Add an API key or sign in to one, then choose its model below."
              : "No model is chosen yet. Choose one below, or connect another provider."}
          </p>
          <button class="btn primary" onClick={() => openDialog({ kind: "connect" })}>
            <IconPlug size={14} /> Connect a provider
          </button>
        </div>
      </Show>
      <ul class="empty-notes">
        <li>Double-click any message, the source included, to rewrite it.</li>
        <li>Change who said it: you, opencode, or the source.</li>
        <li>Let a message settle to keep it without sending it.</li>
      </ul>
    </div>
  )
}
