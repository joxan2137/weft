import { createSignal } from "solid-js"

const KEY = "weft.motion"

function stored() {
  try {
    return localStorage.getItem(KEY) === "reduce"
  } catch {
    return false
  }
}

function apply(reduce: boolean) {
  if (reduce) document.documentElement.dataset.motion = "reduce"
  else delete document.documentElement.dataset.motion
}

const [preference, setPreference] = createSignal(stored())
apply(preference())

/** The user's own reduced-motion switch (Settings → Appearance); sets `data-motion="reduce"` on <html>. */
export const reducedMotionPreference = preference

export function setReducedMotion(reduce: boolean) {
  setPreference(reduce)
  apply(reduce)
  try {
    if (reduce) localStorage.setItem(KEY, "reduce")
    else localStorage.removeItem(KEY)
  } catch {}
}

/** True when either the system or the user's switch asks for reduced motion. */
export function motionReduced() {
  return preference() || matchMedia("(prefers-reduced-motion: reduce)").matches
}
