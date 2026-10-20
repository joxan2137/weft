import type { PermissionRequest } from "@opencode-ai/sdk/v2/types"
import { onCleanup, onMount, Show } from "solid-js"
import { overlayOpen, takeFocus } from "./dialogs"

export type KnotReply = "once" | "always" | "reject"

const VERB: Record<string, string> = {
  bash: "wants to run",
  edit: "wants to edit",
  write: "wants to write",
  patch: "wants to edit",
  read: "wants to read",
  webfetch: "wants to fetch",
  websearch: "wants to search",
  external_directory: "wants to reach",
  todowrite: "wants to update the plan",
  task: "wants to start",
}

function describe(req: PermissionRequest) {
  const meta = req.metadata as Record<string, unknown>
  const command = typeof meta.command === "string" ? meta.command : undefined
  const file = typeof meta.filepath === "string" ? meta.filepath : typeof meta.filePath === "string" ? meta.filePath : undefined
  return {
    what: command ?? file ?? req.patterns.join(", "),
    why: typeof meta.description === "string" ? meta.description : undefined,
  }
}

/** A permission request: the flow is held until it is answered. `from` names the subagent session that asks. */
export function Knot(props: { request: PermissionRequest; from?: string; onReply: (reply: KnotReply) => void }) {
  const d = () => describe(props.request)
  let section!: HTMLElement
  let focus: ReturnType<typeof takeFocus> | undefined

  function onKey(event: KeyboardEvent) {
    // Ctrl+N or Ctrl+A must never answer the prompt, nor a held key or a key meant for an open dialog or menu.
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || overlayOpen()) return
    const target = event.target as HTMLElement
    if (target.closest("textarea, input, [contenteditable]")) return
    const key = event.key.toLowerCase()
    if (key === "y") props.onReply("once")
    else if (key === "a") props.onReply("always")
    else if (key === "n") props.onReply("reject")
    else if (key.length === 1) focus?.returnFocus()
  }
  // The card takes the focus when no field has it, so Y, A and N answer it, and gives it back when answered.
  onMount(() => {
    window.addEventListener("keydown", onKey)
    focus = takeFocus(section)
  })
  onCleanup(() => {
    window.removeEventListener("keydown", onKey)
    focus?.release()
  })

  return (
    <section ref={section} class="knot rise" tabIndex={-1} role="alertdialog" aria-label={`${props.request.permission} needs permission`}>
      <div class="knot-text">
        <div class="knot-label">The flow is held until you answer</div>
        <div class="knot-title">
          <span class="knot-tool">opencode</span>
          <span>{VERB[props.request.permission] ?? "asks for"}</span>
          <code class="knot-what">{d().what}</code>
        </div>
        <Show when={d().why || props.request.always.length || props.from}>
          <div class="knot-sub">
            <Show when={props.from}>
              <span>asked by the subagent in {props.from}</span>
            </Show>
            <Show when={d().why}>
              <span>{d().why}</span>
            </Show>
            <Show when={props.request.always.length}>
              <span>Always would allow {props.request.always.join(", ")}</span>
            </Show>
          </div>
        </Show>
      </div>
      <div class="knot-actions">
        <button class="btn danger" onClick={() => props.onReply("reject")}>
          Reject <kbd>N</kbd>
        </button>
        <button class="btn" onClick={() => props.onReply("always")}>
          Always <kbd>A</kbd>
        </button>
        <button class="btn primary" onClick={() => props.onReply("once")}>
          Allow once <kbd>Y</kbd>
        </button>
      </div>
    </section>
  )
}
