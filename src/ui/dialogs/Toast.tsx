import { createSignal, For } from "solid-js"
import { Portal } from "solid-js/web"
import { IconClose } from "../icons"
import { motionReduced } from "./motion"

export type ToastKind = "info" | "success" | "warn" | "error"

export type ToastAction = { label: string; run: () => unknown }

type Entry = { id: number; message: string; kind: ToastKind; leaving: boolean; action?: ToastAction }

const LINGER: Record<ToastKind, number> = { info: 4500, success: 3500, warn: 7000, error: 9000 }
const LIMIT = 4
const LEAVE_MS = 200

const [entries, setEntries] = createSignal<Entry[]>([])
let seq = 0

function dismiss(id: number) {
  setEntries((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
  window.setTimeout(() => setEntries((all) => all.filter((t) => t.id !== id)), motionReduced() ? 0 : LEAVE_MS)
}

/** Shows a short message on a small paper card at the top right, with a drop in the colour of its kind. Mount <Toaster /> once. */
export function toast(message: string, kind: ToastKind = "info", action?: ToastAction) {
  const id = ++seq
  setEntries((all) => [...all.slice(-(LIMIT - 1)), { id, message, kind, leaving: false, action }])
  window.setTimeout(() => dismiss(id), LINGER[kind])
  return id
}

/** Toasts the message of a failed action. */
export function toastError(error: unknown) {
  toast(error instanceof Error ? error.message : String(error), "error")
}

export function Toaster() {
  return (
    <Portal>
      <div class="toasts" role="status" aria-live="polite">
        <For each={entries()}>
          {(t) => (
            <div class="toast" classList={{ leaving: t.leaving }} data-kind={t.kind} role={t.kind === "error" ? "alert" : undefined}>
              <span class="toast-drop" aria-hidden="true" />
              <span class="toast-text selectable">{t.message}</span>
              {t.action ? (
                <button
                  class="btn toast-action"
                  onClick={() => {
                    dismiss(t.id)
                    t.action!.run()
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
              <button class="icon-btn toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss" title="Dismiss">
                <IconClose size={12} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  )
}
