import { createSignal } from "solid-js"
import type { ModelRef } from "./catalog"

export type SettingsTab = "engine" | "liberation" | "appearance" | "shortcuts" | "about"

export type DialogRequest =
  | { kind: "palette" }
  | { kind: "model"; sessionID?: string; onPick?: (ref: ModelRef) => void }
  | { kind: "connect"; providerID?: string }
  | { kind: "projects" }
  | { kind: "settings"; tab?: SettingsTab }
  | { kind: "rename"; sessionID: string }
  | { kind: "delete"; sessionID: string }
  | ConfirmRequest

export type ConfirmRequest = {
  kind: "confirm"
  title: string
  confirm: string
  danger?: boolean
  /** paragraphs of plain text */
  body: string[]
  /** runs on confirm; an error keeps the dialog open and shows its message */
  run?: () => Promise<unknown> | unknown
  settle?: (confirmed: boolean) => void
}

const [current, setCurrent] = createSignal<DialogRequest>()

/** The dialog <DialogHost /> shows now, if any. */
export const activeDialog = current

/** Opens a dialog in the host, replacing any open one. */
export function openDialog(request: DialogRequest) {
  settleReplaced()
  setCurrent(request)
}

export function closeDialog() {
  settleReplaced()
  setCurrent(undefined)
}

function settleReplaced() {
  const open = current()
  if (open?.kind === "confirm") open.settle?.(false)
}

/** Asks in a confirm dialog; true once `run` (if any) has succeeded, false when dismissed. */
export function ask(request: Omit<ConfirmRequest, "kind" | "settle">): Promise<boolean> {
  return new Promise((resolve) => openDialog({ kind: "confirm", ...request, settle: resolve }))
}
