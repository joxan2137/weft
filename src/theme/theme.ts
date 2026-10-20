import { createEffect, createRoot, createSignal } from "solid-js"
import { windowBackground } from "../ui/platform"

export type ThemePreference = "system" | "light" | "dark"
export type Theme = "light" | "dark"

const KEY = "weft.theme"
const night = matchMedia("(prefers-color-scheme: dark)")
/** Development screenshots pick a theme with ?theme=light|dark. */
const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get("theme") : null

function stored(): ThemePreference {
  if (forced === "light" || forced === "dark") return forced
  try {
    const value = localStorage.getItem(KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

const [preference, setPreference] = createSignal<ThemePreference>(stored())
const [system, setSystem] = createSignal<Theme>(night.matches ? "dark" : "light")
night.addEventListener("change", (event) => setSystem(event.matches ? "dark" : "light"))

/** Day or night as the user chose it (Settings → Appearance), or as the system says. */
export const themePreference = preference

/** The theme in effect: day is pigment on paper, night is light in dark water (docs/DESIGN.md A.8). */
export function theme(): Theme {
  const chosen = preference()
  return chosen === "system" ? system() : chosen
}

export function setThemePreference(next: ThemePreference) {
  try {
    if (next === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {}
  const swap = () => setPreference(next)
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce"
  if (!reduced && "startViewTransition" in document) document.startViewTransition(swap)
  else swap()
}

createRoot(() =>
  createEffect(() => {
    document.documentElement.dataset.theme = theme()
    document.documentElement.style.colorScheme = theme()
    void windowBackground(getComputedStyle(document.documentElement).getPropertyValue("--paper").trim())
  }),
)
