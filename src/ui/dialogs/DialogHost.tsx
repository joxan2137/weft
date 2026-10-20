import { For, Match, onCleanup, onMount, Switch } from "solid-js"
import { activeDialog, closeDialog, openDialog, type DialogRequest } from "./controller"
import { Connect } from "./Connect"
import { ConfirmDialog, DeleteSessionDialog, RenameDialog } from "./Confirm"
import { ModelPicker } from "./ModelPicker"
import { Palette } from "./Palette"
import { ProjectPicker } from "./ProjectPicker"
import { Settings } from "./Settings"

function as<K extends DialogRequest["kind"]>(kind: K) {
  const d = activeDialog()
  return d?.kind === kind ? (d as Extract<DialogRequest, { kind: K }>) : undefined
}

/**
 * Renders whichever dialog `openDialog()` asked for. Mount once inside the Weft provider.
 * Ctrl+K opens the palette and Ctrl+, the settings, unless `shortcuts` is false.
 */
export function DialogHost(props: {
  sessionID?: string
  onSession?: (id: string) => void
  onCommand?: (name: string) => void
  onNewSession?: () => void
  shortcuts?: boolean
}) {
  function onKey(event: KeyboardEvent) {
    if (props.shortcuts === false || !(event.ctrlKey || event.metaKey) || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === "k") {
      event.preventDefault()
      openDialog({ kind: "palette" })
    } else if (key === ",") {
      event.preventDefault()
      openDialog({ kind: "settings" })
    }
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => window.removeEventListener("keydown", onKey))

  return (
    <Switch>
      <Match when={as("palette")}>
        <Palette
          sessionID={props.sessionID}
          onSession={props.onSession}
          onCommand={props.onCommand}
          onNewSession={props.onNewSession}
          onClose={closeDialog}
        />
      </Match>
      <Match when={as("model")} keyed>
        {(d) => <ModelPicker sessionID={d.sessionID ?? props.sessionID} onPick={d.onPick} onClose={closeDialog} />}
      </Match>
      <Match when={as("connect")} keyed>
        {(d) => <Connect providerID={d.providerID} onClose={closeDialog} />}
      </Match>
      <Match when={as("projects")}>
        <ProjectPicker onClose={closeDialog} />
      </Match>
      <Match when={as("settings")} keyed>
        {(d) => <Settings tab={d.tab} onClose={closeDialog} />}
      </Match>
      <Match when={as("rename")} keyed>
        {(d) => <RenameDialog sessionID={d.sessionID} onClose={closeDialog} />}
      </Match>
      <Match when={as("delete")} keyed>
        {(d) => <DeleteSessionDialog sessionID={d.sessionID} onClose={closeDialog} />}
      </Match>
      <Match when={as("confirm")} keyed>
        {(d) => (
          <ConfirmDialog
            onClose={closeDialog}
            title={d.title}
            confirm={d.confirm}
            danger={d.danger}
            onConfirm={async () => {
              await d.run?.()
              d.settle?.(true)
            }}
          >
            <For each={d.body}>{(paragraph) => <p class="confirm-text">{paragraph}</p>}</For>
          </ConfirmDialog>
        )}
      </Match>
    </Switch>
  )
}
