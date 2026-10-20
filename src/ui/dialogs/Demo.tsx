import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Mark } from "../../art/Mark"
import { WeftProvider } from "../../engine/context"
import { createMockWeft, MOCK_SESSION, MockWeftProvider, type MockWeft } from "../../mock/weft"
import { IconCopy, IconCross, IconFork, IconMore, IconNeedle, IconOpen } from "../icons"
import {
  DialogHost,
  MenuItem,
  openDialog,
  Popover,
  QuestionDock,
  Toaster,
  toast,
  type DialogRequest,
  type SettingsTab,
} from "./index"

type Launcher = { title: string; hint?: string; request: DialogRequest }

function launchers(sessionID: string | undefined): Launcher[] {
  const always: Launcher[] = [
    { title: "Commands", hint: "Ctrl K", request: { kind: "palette" } },
    { title: "Model", request: { kind: "model", sessionID } },
    { title: "Providers", request: { kind: "connect" } },
    { title: "Projects", request: { kind: "projects" } },
    { title: "Settings", hint: "Ctrl ,", request: { kind: "settings" } },
  ]
  if (!sessionID) return always
  return [
    ...always,
    { title: "Rename session", request: { kind: "rename", sessionID } },
    { title: "Delete session", request: { kind: "delete", sessionID } },
  ]
}

function requestFrom(params: URLSearchParams, sessionID: string | undefined): DialogRequest | undefined {
  const kind = params.get("dialogs")
  if (kind === "palette" || kind === "projects") return { kind }
  if (kind === "model") return { kind, sessionID }
  if (kind === "connect") return { kind, providerID: params.get("provider") ?? undefined }
  if (kind === "settings") return { kind, tab: (params.get("tab") as SettingsTab | null) ?? undefined }
  if ((kind === "rename" || kind === "delete") && sessionID) return { kind, sessionID }
  return undefined
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Scripted steps for screenshots: `do=focus:.key-input|type:secret-key|click:Connect|key:ArrowDown`. */
async function play(script: string) {
  for (const step of script.split("|").filter(Boolean)) {
    await wait(350)
    const [verb, ...rest] = step.split(":")
    const arg = rest.join(":")
    const active = document.activeElement as HTMLElement | null
    if (verb === "click") {
      const target = [...document.querySelectorAll<HTMLElement>(".dialog button, .question-dock button, .popover button, .demo-launch button")].find((b) =>
        b.textContent?.trim().startsWith(arg),
      )
      target?.click()
    } else if (verb === "type" && active instanceof HTMLInputElement) {
      active.value = arg
      active.dispatchEvent(new InputEvent("input", { bubbles: true }))
    } else if (verb === "focus") document.querySelector<HTMLElement>(arg)?.focus()
    else if (verb === "key") active?.dispatchEvent(new KeyboardEvent("keydown", { key: arg, bubbles: true }))
  }
}

function Engine(props: { weft?: MockWeft; children: JSX.Element }) {
  return (
    <Show when={props.weft} fallback={<WeftProvider>{props.children}</WeftProvider>}>
      {(weft) => <MockWeftProvider weft={weft()}>{props.children}</MockWeftProvider>}
    </Show>
  )
}

/**
 * http://localhost:1420/?dialogs[=palette|model|connect|projects|settings|rename|delete|popover|toasts]
 * Add `&live` to drive the dialogs against the engine from VITE_ENGINE_URL instead of the mock.
 */
export function Demo() {
  const params = new URLSearchParams(location.search)
  const weft = params.has("live") ? undefined : createMockWeft()
  const sessionID = params.get("session") ?? (weft ? MOCK_SESSION : undefined)
  const [menuAnchor, setMenuAnchor] = createSignal<HTMLElement>()
  let menuButton!: HTMLButtonElement

  if (params.get("liberated") === "false") weft?.setState("liberated", false)
  if (params.get("liberated") === "unknown") weft?.setState("liberated", undefined)
  if (params.get("engine") === "error")
    weft?.setState("engine", { state: "error", kind: "spawn", message: "opencode.exe exited with code 1 before it was ready" })

  function burst() {
    toast("Anthropic connected", "success")
    toast("Share link copied")
    toast("The weft plugin did not load; edits are stored but not applied", "warn", { label: "Details", run: () => undefined })
    toast("409 Conflict: the session is busy. Stop it first, then delete the message.", "error")
  }

  onMount(async () => {
    const request = requestFrom(params, sessionID)
    if (request) openDialog(request)
    if (params.get("dialogs") === "popover") setMenuAnchor(menuButton)
    if (params.get("dialogs") === "toasts") burst()
    const script = params.get("do")
    if (script) await play(script)
  })

  return (
    <Engine weft={weft}>
      <div class="demo">
        <header class="demo-head">
          <Mark />
          <span class="demo-what">Dialogs</span>
          <span class="tag">{weft ? "Mock engine" : "Live engine"}</span>
        </header>
        <div class="demo-body">
          <nav class="demo-launch">
            <h2 class="demo-label">Open</h2>
            <For each={launchers(sessionID)}>
              {(l) => (
                <button class="btn" onClick={() => openDialog(l.request)}>
                  {l.title}
                  <Show when={l.hint}>
                    <kbd>{l.hint}</kbd>
                  </Show>
                </button>
              )}
            </For>
            <button ref={menuButton} class="btn" onClick={() => setMenuAnchor(menuAnchor() ? undefined : menuButton)}>
              Session menu <IconMore size={14} class="dim" />
            </button>
            <button class="btn" onClick={burst}>
              Toasts
            </button>
            <Show when={weft}>
              {(mock) => (
                <>
                  <h2 class="demo-label">State</h2>
                  <button class="btn ghost" onClick={() => mock().setState("liberated", (v) => (v === true ? false : v === false ? undefined : true))}>
                    Cycle liberation
                  </button>
                  <button
                    class="btn ghost"
                    onClick={() => mock().setState("questions", MOCK_SESSION, (q) => (q?.length ? [] : createMockWeft().state.questions[MOCK_SESSION]))}
                  >
                    Toggle question
                  </button>
                </>
              )}
            </Show>
          </nav>
          <main class="demo-scrollback">
            <p class="demo-caption">The question dock sits on its own card above the composer.</p>
            <Show when={sessionID}>{(id) => <QuestionDock sessionID={id()} />}</Show>
            <div class="demo-prompt">Write to opencode. /commands @files !shell</div>
          </main>
        </div>
        <Show when={menuAnchor()}>
          {(anchor) => (
            <Popover anchor={anchor()} onClose={() => setMenuAnchor(undefined)} label="Session" placement="bottom-start">
              <span class="menu-label">Session</span>
              <MenuItem onSelect={() => (setMenuAnchor(undefined), sessionID && openDialog({ kind: "rename", sessionID }))}>
                <IconNeedle size={15} />
                Rename…
              </MenuItem>
              <MenuItem onSelect={() => setMenuAnchor(undefined)}>
                <IconFork size={15} />
                Fork
              </MenuItem>
              <MenuItem onSelect={() => setMenuAnchor(undefined)}>
                <IconOpen size={15} />
                Share
              </MenuItem>
              <MenuItem onSelect={() => setMenuAnchor(undefined)}>
                <IconCopy size={15} />
                Export as JSON
              </MenuItem>
              <div class="menu-sep" />
              <MenuItem danger onSelect={() => (setMenuAnchor(undefined), sessionID && openDialog({ kind: "delete", sessionID }))}>
                <IconCross size={15} />
                Delete…
              </MenuItem>
            </Popover>
          )}
        </Show>
        <DialogHost sessionID={sessionID} />
        <Toaster />
      </div>
    </Engine>
  )
}
