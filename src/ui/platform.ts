export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export async function openExternal(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) return
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    await openUrl(url)
  } else window.open(url, "_blank", "noopener")
}

export async function copyText(text: string) {
  if (inTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager")
    await writeText(text)
  } else await navigator.clipboard.writeText(text)
}

/** Reveals Weft's log folder (weft.log and the engine's output) in Explorer. */
export async function openLogs() {
  if (!inTauri) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("open_logs")
}

/** Asks where to save, then writes the text there. False when the user cancels. */
export async function saveTextFile(defaultName: string, contents: string): Promise<boolean> {
  const json = defaultName.toLowerCase().endsWith(".json")
  if (!inTauri) {
    const url = URL.createObjectURL(new Blob([contents], { type: json ? "application/json" : "text/plain" }))
    const link = document.createElement("a")
    link.href = url
    link.download = defaultName
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  }
  const { save } = await import("@tauri-apps/plugin-dialog")
  const path = await save({ defaultPath: defaultName, filters: json ? [{ name: "JSON", extensions: ["json"] }] : undefined })
  if (!path) return false
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("save_text_file", { path, contents })
  return true
}

export async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  if (!inTauri) return
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const win = getCurrentWindow()
  if (action === "minimize") await win.minimize()
  else if (action === "toggleMaximize") await win.toggleMaximize()
  else await win.close()
}

/** The native window behind the page, so a resize never shows the other theme's colour at the edges. */
export async function windowBackground(hex: string) {
  if (!inTauri) return
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const n = parseInt(hex.replace("#", ""), 16)
  await getCurrentWindow()
    .setBackgroundColor([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255])
    .catch(() => undefined)
}
