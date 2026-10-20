import { render } from "solid-js/web"
import type { Config } from "@opencode-ai/sdk/v2/types"
import "@fontsource-variable/fraunces/full.css"
import "@fontsource-variable/fraunces/full-italic.css"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import "./theme/tokens.css"
import "./theme/base.css"
import "./theme/theme"
import "./art/art.css"
import "./ui/ui.css"
import { App } from "./App"
import { WeftProvider } from "./engine/context"
import { ask } from "./ui/dialogs"
import { inTauri } from "./ui/platform"

/** PATCH /global/config rewrites the config file OpenCode Desktop reads too: always ask first. */
function confirmGlobalConfig(patch: Partial<Config>) {
  return ask({
    title: "Change the global opencode config?",
    confirm: "Change global config",
    body: [
      "This writes to your global opencode config (opencode.json in the opencode config folder). OpenCode Desktop and the opencode CLI read the same file, so the change applies there too.",
      `Settings to change: ${Object.keys(patch).join(", ") || "none"}. Every open project reloads afterwards.`,
    ],
  })
}

/** WebView2's browser menu (Back, Refresh, Print) stays out of the app; fields, the terminal and selected text keep theirs. */
function keepsBrowserMenu(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest("input, textarea, [contenteditable]:not([contenteditable='false']), .xterm")) return true
  return !(document.getSelection()?.isCollapsed ?? true)
}

if (inTauri) document.addEventListener("contextmenu", (event) => keepsBrowserMenu(event) || event.preventDefault())

// Edge's suggestion list would offer earlier entries, API keys among them, under every text field.
document.addEventListener("focusin", (event) => {
  const field = event.target
  if (field instanceof HTMLInputElement && !field.hasAttribute("autocomplete")) field.autocomplete = "off"
})

const root = document.getElementById("root")!
const params = new URLSearchParams(location.search)
// The DEV checks let a release build drop the demo and mock chunks entirely.
if (import.meta.env.DEV && params.has("dialogs")) import("./ui/dialogs/Demo").then(({ Demo }) => render(() => <Demo />, root))
else if (import.meta.env.DEV && params.has("mock")) import("./MockApp").then(({ MockApp }) => render(() => <MockApp />, root))
else
  render(
    () => (
      <WeftProvider confirmConfig={confirmGlobalConfig}>
        <App />
      </WeftProvider>
    ),
    root,
  )
