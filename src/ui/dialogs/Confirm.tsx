import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useWeft } from "../../engine/context"
import { Dialog, useDialog, type DialogTint } from "./Dialog"
import { toast } from "./Toast"

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type ConfirmProps = {
  onClose: () => void
  title: string
  confirm: string
  danger?: boolean
  tint?: DialogTint
  onConfirm: () => Promise<unknown> | unknown
  children?: JSX.Element
}

/** Asks once before an action: Y or the button confirms, N or Esc cancels; errors stay in the dialog. */
export function ConfirmDialog(props: ConfirmProps) {
  return (
    <Dialog onClose={props.onClose} title={props.title} tint={props.tint ?? (props.danger ? "carmine" : "ochre")} width={480} class="confirm">
      <ConfirmBody {...props} />
    </Dialog>
  )
}

function ConfirmBody(props: ConfirmProps) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  async function confirm() {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onConfirm()
      dialog.close()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  function onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return
    const key = event.key.toLowerCase()
    if (key !== "y" && key !== "n") return
    event.preventDefault()
    if (key === "y") void confirm()
    else if (!busy()) dialog.close()
  }
  onMount(() => {
    const panel = dialog.panel()
    panel.addEventListener("keydown", onKey)
    onCleanup(() => panel.removeEventListener("keydown", onKey))
  })

  return (
    <>
      <div class="dialog-body confirm-body">
        {props.children}
        <Show when={error()}>
          <p class="dlg-error">{error()}</p>
        </Show>
      </div>
      <footer class="dialog-foot">
        <span class="spacer" />
        <button class="btn ghost" onClick={dialog.close} disabled={busy()}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button data-autofocus={props.danger ? undefined : true} class="btn" classList={{ danger: props.danger, primary: !props.danger }} onClick={confirm} disabled={busy()}>
          {props.confirm} <kbd>Y</kbd>
        </button>
      </footer>
    </>
  )
}

type SessionDialogProps = { sessionID: string; onClose: () => void; onDone?: () => void }

/** Asks before deleting a session. */
export function DeleteSessionDialog(props: SessionDialogProps) {
  const { state, actions } = useWeft()
  const session = () => state.info[props.sessionID]
  const messages = () => state.content[props.sessionID]?.messages.length
  const moreUnloaded = () => state.content[props.sessionID]?.hasOlder === true
  const children = () => Object.values(state.info).filter((s) => s.parentID === props.sessionID).length
  return (
    <ConfirmDialog
      onClose={props.onClose}
      title="Delete this session?"
      confirm="Delete session"
      danger
      onConfirm={async () => {
        await actions.removeSession(props.sessionID)
        toast("Session deleted")
        props.onDone?.()
      }}
    >
      <p class="confirm-title">{session()?.title ?? props.sessionID}</p>
      <p class="confirm-text">
        <Show when={messages()}>
          {messages()}
          {moreUnloaded() ? "+" : ""} {messages() === 1 && !moreUnloaded() ? "message" : "messages"}{" "}
        </Show>
        <Show when={children()}>
          and {children()} {children() === 1 ? "subagent session" : "subagent sessions"}{" "}
        </Show>
        will be removed from the engine's database. OpenCode Desktop shares that database, so the session disappears there too. This
        cannot be undone.
      </p>
    </ConfirmDialog>
  )
}

/** Renames a session (Enter saves). */
export function RenameDialog(props: SessionDialogProps) {
  return (
    <Dialog onClose={props.onClose} title="Rename session" tint="vermilion" width={480} class="rename">
      <RenameBody {...props} />
    </Dialog>
  )
}

function RenameBody(props: SessionDialogProps) {
  const { state, actions } = useWeft()
  const dialog = useDialog()
  const original = state.info[props.sessionID]?.title ?? ""
  const [title, setTitle] = createSignal(original)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const changed = () => title().trim().length > 0 && title().trim() !== original

  async function save(event: Event) {
    event.preventDefault()
    if (!changed() || busy()) return
    setBusy(true)
    try {
      await actions.renameSession(props.sessionID, title().trim())
      props.onDone?.()
      dialog.close()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  return (
    <form class="dialog-form" onSubmit={save}>
      <div class="dialog-body">
        <label class="dlg-field">
          <span class="field-label">Title</span>
          <input
            data-autofocus
            class="dlg-input"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onFocus={(e) => e.currentTarget.select()}
            maxLength={200}
            spellcheck={false}
            aria-label="Session title"
          />
        </label>
        <Show when={error()}>
          <p class="dlg-error">{error()}</p>
        </Show>
      </div>
      <footer class="dialog-foot">
        <span class="spacer" />
        <button type="button" class="btn ghost" onClick={dialog.close}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button class="btn primary" disabled={!changed() || busy()}>
          Save <kbd>↵</kbd>
        </button>
      </footer>
    </form>
  )
}
