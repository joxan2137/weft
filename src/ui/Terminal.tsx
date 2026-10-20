import type { Pty, PtyTicketConnectToken } from "@opencode-ai/sdk/v2/types"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm, type ITheme } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { HttpError, type Http } from "../engine/contract"
import { useWeft } from "../engine/context"
import { theme, type Theme } from "../theme/theme"
import { ask, motionReduced } from "./dialogs"
import { IconChevron, IconClose, IconPlus } from "./icons"
import { copyText } from "./platform"
import "./workbench.css"

type Tab = { id: string; title: string; command?: string; directory: string; exited?: boolean; failure?: string }

const [tabs, setTabs] = createStore<Tab[]>([])
const [current, setCurrent] = createSignal<Record<string, string>>({})
const [height, setHeight] = createSignal(300)

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** A token, or two tokens mixed half and half. */
type Paint = string | [string, string]

/** The drawer's paper: the terminal draws straight onto it. By night the drawer is lifted halfway toward --paper-3 (workbench.css). */
const SURFACE: Record<Theme, Paint> = { light: "--paper-2", dark: ["--paper-2", "--paper-3"] }

type Ansi = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
type AnsiPalette = Record<Ansi | `bright${Capitalize<Ansi>}`, Paint>

/** By day the inks are pigment on paper: deep for text, the bright inks a little lighter. */
const DAY: AnsiPalette = {
  black: "--ink",
  red: "--carmine",
  green: "--teal",
  yellow: "--ochre",
  blue: "--indigo",
  magenta: "--syn-function",
  cyan: ["--teal", "--indigo"],
  white: "--ink-2",
  brightBlack: "--ink-3",
  brightRed: "--carmine-bright",
  brightGreen: "--teal-bright",
  brightYellow: ["--ochre", "--ochre-bright"],
  brightBlue: "--indigo-bright",
  brightMagenta: ["--syn-function", "--carmine"],
  brightCyan: ["--teal-bright", "--indigo-bright"],
  brightWhite: "--ink",
}

/** By night the inks are light: luminous for the plain colours, paler (brighter) for the bright ones. */
const NIGHT: AnsiPalette = {
  black: "--ink-4",
  red: "--carmine-bright",
  green: "--teal-bright",
  yellow: "--ochre-bright",
  blue: "--indigo-bright",
  magenta: "--syn-function",
  cyan: ["--teal-bright", "--indigo-bright"],
  white: "--ink-2",
  brightBlack: "--ink-3",
  brightRed: "--carmine",
  brightGreen: "--teal",
  brightYellow: "--ochre",
  brightBlue: "--indigo",
  brightMagenta: ["--syn-function", "--carmine"],
  brightCyan: ["--teal", "--indigo"],
  brightWhite: "--ink",
}

const easel = document.createElement("canvas").getContext("2d", { willReadFrequently: true })

/** A paint laid over `ground` and read back as #rrggbb: xterm wants opaque, plain colours, and washes are translucent. */
function opaque(paint: Paint, ground: string) {
  const [first, second] = typeof paint === "string" ? [paint, undefined] : paint
  if (!easel) return token(first)
  easel.globalAlpha = 1
  easel.fillStyle = ground
  easel.fillRect(0, 0, 1, 1)
  easel.fillStyle = token(first)
  easel.fillRect(0, 0, 1, 1)
  if (second) {
    easel.globalAlpha = 0.5
    easel.fillStyle = token(second)
    easel.fillRect(0, 0, 1, 1)
  }
  const [r, g, b] = easel.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`
}

/** The xterm theme for day or night, read from the Flow tokens now in effect. */
function themeFromTokens(mode: Theme): ITheme {
  const surface = opaque(SURFACE[mode], token("--paper"))
  const on = (paint: Paint) => opaque(paint, surface)
  const palette = mode === "dark" ? NIGHT : DAY
  const ansi = Object.fromEntries(Object.entries(palette).map(([name, paint]) => [name, on(paint)])) as Record<keyof AnsiPalette, string>
  return {
    background: surface,
    foreground: on("--ink"),
    cursor: on("--vermilion-bright"),
    cursorAccent: surface,
    selectionBackground: on("--indigo-wash"),
    selectionInactiveBackground: on("--tint-2"),
    scrollbarSliderBackground: on("--line-2"),
    scrollbarSliderHoverBackground: on("--ink-4"),
    scrollbarSliderActiveBackground: on("--ink-3"),
    ...ansi,
  }
}

/** Light text on dark reads heavier than dark on light: night thins it a little (docs/DESIGN.md A.8). */
const textWeight = (mode: Theme) => (mode === "dark" ? 370 : 400)

const ROW_HEIGHT = 20

/** xterm sizes rows as the font's box times `lineHeight`; this picks the factor that makes every row ROW_HEIGHT pixels tall. */
function rowLineHeight(fontFamily: string, fontSize: number) {
  const context = document.createElement("canvas").getContext("2d")
  if (!context) return 1
  context.font = `${fontSize}px ${fontFamily}`
  const metrics = context.measureText("W")
  const dpr = window.devicePixelRatio || 1
  const box = Math.ceil((metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) * dpr)
  return box > 0 ? Math.max(1, (ROW_HEIGHT * dpr + 0.5) / box) : 1
}

/** Shells by the plain name people know them by, keyed by executable. */
const SHELL_NAMES = new Map([
  ["pwsh", "PowerShell"],
  ["powershell", "Windows PowerShell"],
  ["cmd", "Command Prompt"],
  ["bash", "Bash"],
  ["zsh", "Zsh"],
  ["fish", "Fish"],
  ["nu", "Nushell"],
  ["sh", "Shell"],
  ["wsl", "WSL"],
])

const shellName = (tab: Tab) => SHELL_NAMES.get(tab.command?.split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase() ?? "") ?? tab.title

async function ptyGone(http: Http, tab: Tab) {
  try {
    const { data } = await http.get<Pty>(`/pty/${tab.id}`, { directory: tab.directory })
    return data.status === "exited"
  } catch (error) {
    return error instanceof HttpError && error.status === 404
  }
}

/** One PTY: an xterm bound to the engine's ticketed websocket. */
function PtyView(props: { tab: Tab; active: boolean; onExit: () => void; onFailure: (message: string) => void }) {
  const { http } = useWeft()
  let host!: HTMLDivElement
  let socket: WebSocket | undefined
  let disposed = false
  let cursor = 0
  let tries = 0
  let retryTimer = 0
  let sizeTimer = 0
  const decoder = new TextDecoder()

  const fontFamily = token("--font-code")
  const fontSize = parseFloat(token("--text-code")) || 13
  const term = new XTerm({
    theme: themeFromTokens(theme()),
    fontFamily,
    fontSize,
    fontWeight: textWeight(theme()),
    fontWeightBold: 600,
    lineHeight: rowLineHeight(fontFamily, fontSize),
    cursorBlink: !motionReduced(),
    cursorStyle: "bar",
    cursorWidth: 2,
    cursorInactiveStyle: "bar",
    scrollback: 10_000,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  createEffect(() => (term.options.cursorBlink = !motionReduced()))

  const sendSize = () => {
    window.clearTimeout(sizeTimer)
    sizeTimer = window.setTimeout(() => {
      void http
        .put(`/pty/${props.tab.id}`, { directory: props.tab.directory, body: { size: { rows: term.rows, cols: term.cols } } })
        .catch(() => {})
    }, 80)
  }

  const refit = () => {
    if (!props.active || !host.offsetWidth || !host.offsetHeight) return
    fit.fit()
  }

  async function connect() {
    if (disposed) return
    try {
      const { data } = await http.post<PtyTicketConnectToken>(`/pty/${props.tab.id}/connect-token`, {
        directory: props.tab.directory,
        headers: { "x-opencode-ticket": "1" },
      })
      if (disposed) return
      const url = http.url(`/pty/${props.tab.id}/connect`, { directory: props.tab.directory, cursor, ticket: data.ticket }).replace(/^http/, "ws")
      const ws = new WebSocket(url)
      ws.binaryType = "arraybuffer"
      socket = ws
      ws.onopen = () => {
        tries = 0
        sendSize()
      }
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data)
          if (bytes[0] !== 0) return
          try {
            const meta = JSON.parse(decoder.decode(bytes.subarray(1))) as { cursor?: unknown }
            if (typeof meta.cursor === "number") cursor = meta.cursor
          } catch {}
          return
        }
        if (typeof event.data !== "string" || !event.data) return
        term.write(event.data)
        cursor += event.data.length
      }
      ws.onclose = () => {
        if (socket === ws) socket = undefined
        if (!disposed) void settle()
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return finish()
      if (error instanceof HttpError && error.status === 403) return props.onFailure("The engine refused the terminal connection (403).")
      void settle()
    }
  }

  function finish() {
    term.write("\r\n\x1b[90mProcess exited\x1b[0m\r\n")
    props.onExit()
  }

  async function settle() {
    const gone = await ptyGone(http, props.tab)
    if (disposed) return
    if (gone) return finish()
    if (tries >= 6) return props.onFailure("Lost the terminal connection.")
    retryTimer = window.setTimeout(connect, Math.min(250 * 2 ** tries++, 4000))
  }

  term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(data)
  })

  /** Without bracketed paste the shell runs every pasted line as it arrives, hidden ones included: ask first. */
  function onPaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text/plain") ?? ""
    if (term.modes.bracketedPasteMode || !/[\r\n]/.test(text)) return
    event.preventDefault()
    event.stopPropagation()
    const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim()).length
    void ask({
      title: "Paste into the shell?",
      confirm: "Paste and run",
      danger: true,
      body: [
        `The text holds ${lines === 1 ? "a line break" : `${lines} lines`}. This shell runs each line as soon as it arrives, without waiting for Enter.`,
        text.length > 600 ? `${text.slice(0, 600)}…` : text,
      ],
    }).then((confirmed) => {
      if (confirmed) term.paste(text)
      term.focus()
    })
  }
  term.onResize(sendSize)
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c") {
      if (term.hasSelection()) void copyText(term.getSelection()).catch(() => undefined)
      return false
    }
    // Ctrl+` (close the terminal) and Ctrl+, (settings) mean nothing to a shell: they go on to the app's own listeners.
    if (event.ctrlKey && !event.altKey && (event.key === "`" || event.key === ",")) return false
    return true
  })

  onMount(() => {
    host.addEventListener("paste", onPaste, true)
    onCleanup(() => host.removeEventListener("paste", onPaste, true))
    term.open(host)
    refit()
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    void document.fonts?.ready.then(() => {
      if (disposed) return
      term.options.fontFamily = fontFamily
      term.options.lineHeight = rowLineHeight(fontFamily, fontSize)
      refit()
    })
    void connect()
    onCleanup(() => observer.disconnect())
  })

  createEffect(
    on(
      theme,
      (mode) => {
        term.options.theme = themeFromTokens(mode)
        term.options.fontWeight = textWeight(mode)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.active,
      (active) => {
        if (!active) return
        requestAnimationFrame(() => {
          refit()
          term.focus()
        })
      },
    ),
  )

  onCleanup(() => {
    disposed = true
    window.clearTimeout(retryTimer)
    window.clearTimeout(sizeTimer)
    socket?.close(1000)
    term.dispose()
  })

  return <div class="pty" classList={{ active: props.active }} ref={host} />
}

/** A drawer under the conversation: engine PTYs as tabs. Tabs outlive the drawer. */
export function Terminal(props: { onClose: () => void }) {
  const { state, http } = useWeft()
  const [creating, setCreating] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const directory = () => state.directory ?? ""
  const here = createMemo(() => tabs.filter((t) => t.directory === directory()))
  const active = () => {
    const chosen = current()[directory()]
    return here().some((t) => t.id === chosen) ? chosen : here()[0]?.id
  }

  const select = (id: string, dir = directory()) => setCurrent((c) => ({ ...c, [dir]: id }))

  async function create() {
    const dir = state.directory
    if (creating() || !dir) return
    setCreating(true)
    setFailure(undefined)
    try {
      const numbers = here().map((t) => Number(/(\d+)$/.exec(t.title)?.[1] ?? 0))
      const title = `Terminal ${Math.max(0, ...numbers) + 1}`
      const { data } = await http.post<Pty>("/pty", { directory: dir, body: { title } })
      setTabs(tabs.length, { id: data.id, title: data.title || title, command: data.command, directory: dir })
      select(data.id, dir)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  async function close(tab: Tab) {
    const rest = here().filter((t) => t.id !== tab.id)
    if (active() === tab.id && rest.length) select(rest[Math.max(0, here().findIndex((t) => t.id === tab.id) - 1)].id)
    setTabs((all) => all.filter((t) => t.id !== tab.id))
    if (!tab.exited) await http.del(`/pty/${tab.id}`, { directory: tab.directory }).catch(() => {})
    if (!rest.length) props.onClose()
  }

  function resizeFrom(event: PointerEvent) {
    const handle = event.currentTarget as HTMLElement
    const startY = event.clientY
    const startH = height()
    handle.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => setHeight(Math.round(Math.min(Math.max(140, startH + startY - e.clientY), window.innerHeight * 0.8)))
    const up = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("lostpointercapture", up)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("lostpointercapture", up)
  }

  async function adoptOrCreate() {
    const dir = state.directory
    if (!dir || here().length) return
    const running = await http
      .get<Pty[]>("/pty", { directory: dir })
      .then((r) => r.data.filter((p) => p.status === "running"))
      .catch(() => [])
    const fresh = running.filter((p) => !tabs.some((t) => t.id === p.id))
    if (fresh.length) setTabs((all) => [...all, ...fresh.map((p) => ({ id: p.id, title: p.title, command: p.command, directory: dir }))])
    else if (!here().length) await create()
  }

  createEffect(on(() => state.directory, () => void adoptOrCreate()))

  return (
    <section class="terminal-drawer rise" data-role="tool" style={{ height: `${height()}px` }} aria-label="Terminal">
      <div class="terminal-grip" onPointerDown={resizeFrom} title="Drag to resize" />
      <header class="terminal-head">
        <span class="terminal-title">
          <span class="drop" aria-hidden="true" />
          Terminal
        </span>
        <div class="terminal-tabs" role="tablist">
          <For each={here()}>
            {(tab) => (
              <div
                class="terminal-tab"
                role="tab"
                aria-selected={active() === tab.id}
                classList={{ on: active() === tab.id, exited: !!tab.exited }}
              >
                <button class="terminal-tab-name" onClick={() => select(tab.id)} title={tab.exited ? `${tab.title} (exited)` : tab.title}>
                  <span class="terminal-tab-dot" aria-hidden="true" />
                  {shellName(tab)}
                  <Show when={tab.exited}>
                    <span class="terminal-tab-exited">Exited</span>
                  </Show>
                </button>
                <button
                  class="terminal-tab-close"
                  title={`Close ${tab.title}`}
                  aria-label={`Close ${tab.title}`}
                  onClick={() => void close(tab)}
                >
                  <IconClose size={10} />
                </button>
              </div>
            )}
          </For>
          <button
            class="icon-btn terminal-new"
            title="New terminal"
            aria-label="New terminal"
            onClick={() => void create()}
            disabled={creating() || !state.directory}
          >
            <IconPlus size={14} />
          </button>
        </div>
        <span class="spacer" />
        <Show when={failure()}>
          <span class="terminal-failure" title={failure()}>
            {failure()}
          </span>
        </Show>
        <Show when={state.directory}>
          <span class="terminal-cwd" title={state.directory}>
            {state.directory}
          </span>
        </Show>
        <button class="icon-btn" title="Hide terminal" aria-label="Hide terminal" onClick={props.onClose}>
          <IconChevron dir="down" />
        </button>
      </header>
      <div class="terminal-body">
        <For each={here()}>
          {(tab) => (
            <PtyView
              tab={tab}
              active={active() === tab.id}
              onExit={() => setTabs((t) => t.id === tab.id, "exited", true)}
              onFailure={(message) => setTabs((t) => t.id === tab.id, "failure", message)}
            />
          )}
        </For>
        <Show when={here().find((t) => t.id === active())?.failure}>
          {(message) => <p class="terminal-note">{message()}</p>}
        </Show>
        <Show when={!here().length && !creating()}>
          <div class="terminal-empty">
            <span>{state.directory ? "No terminals are open." : "Open a project to start a terminal."}</span>
            <Show when={state.directory}>
              <button class="btn" onClick={() => void create()}>
                <IconPlus size={14} />
                New terminal
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  )
}
