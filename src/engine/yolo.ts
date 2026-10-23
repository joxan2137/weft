import { createSignal } from "solid-js"

const KEY = "weft.yolo"

function stored() {
  try {
    return localStorage.getItem(KEY) === "on"
  } catch {
    return false
  }
}

const [enabled, setEnabled] = createSignal(stored())

export const yoloEnabled = enabled

export function setYolo(on: boolean) {
  setEnabled(on)
  try {
    if (on) localStorage.setItem(KEY, "on")
    else localStorage.removeItem(KEY)
  } catch {}
}
