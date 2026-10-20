import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { ink } from "../art/ink"
import { Vessel } from "../art/Vessel"
import type { Attachment, Mention } from "../engine/contract"
import { useWeft } from "../engine/context"
import { partText, type ContextView, type PickView } from "../engine/view"
import { commandSuggestions, fileSuggestions, locateMentions, MentionMirror, optionID, Suggest, SUGGEST_ID, triggerAt } from "./Mentions"
import { IconArrow, IconClose, IconFile, IconStop, IconTerminal } from "./icons"
import { inTauri } from "./platform"
import { Speed } from "./Speed"
import "./workbench.css"

/** An attachment chip owned by the caller rather than the prompt. */
export type AttachmentChip = { id: string; name: string; detail?: string }

type Pinned = Attachment & { size?: number }

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
}

/** Sent as text/plain, which the engine reads with its Read tool; anything else unknown goes as a binary file. */
const TEXT_EXTENSIONS = new Set(
  `txt text md markdown mdx rst adoc org log csv tsv json jsonc json5 ndjson yaml yml toml ini cfg conf env properties xml xsd xsl
  html htm css scss sass less styl js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi pyw ipynb rb erb php java kt kts scala sc
  groovy gradle go mod sum rs c h cc cpp cxx hpp hh hxx inl cs csx fs fsi fsx vb swift m mm dart lua luau r jl ex exs erl hrl clj
  cljs cljc edn hs lhs elm ml mli nim zig v sv vhd sol sh bash zsh fish ps1 psm1 psd1 bat cmd sql graphql gql proto prisma tf
  tfvars hcl nix dockerfile containerfile makefile mk cmake just lock gitignore gitattributes gitmodules editorconfig npmrc
  prettierrc eslintrc babelrc diff patch tex bib srt vtt asm s`.split(/\s+/),
)
const BINARY = "application/octet-stream"
/** What the engine turns into text (its Read tool) or hands models as images and PDFs. */
const readable = (mime: string) => mime === "text/plain" || mime.startsWith("image/") || mime === "application/pdf"

function compact(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)
}

function sizeLabel(bytes?: number) {
  if (bytes === undefined) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function mimeOf(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf(".")
  if (dot < 0) return "text/plain"
  const extension = base.slice(dot + 1).toLowerCase()
  return MIME[extension] ?? (TEXT_EXTENSIONS.has(extension) ? "text/plain" : BINARY)
}

/** The name decides when it is known: the browser types a .ts file as video. */
function fileMime(file: File) {
  const named = file.name ? mimeOf(file.name) : BINARY
  return named !== BINARY ? named : file.type || BINARY
}

function binaryNote(names: string[]) {
  if (!names.length) return undefined
  const which = names.length === 1 ? `${names[0]} is` : `${names.length} files are`
  return `${which} attached as binary data. Most models read only text, code, images and PDFs.`
}

function fileURL(path: string) {
  const slashed = path.replace(/\\/g, "/")
  return `file://${slashed.startsWith("/") ? "" : "/"}${encodeURI(slashed).replace(/#/g, "%23").replace(/\?/g, "%3F")}`
}

/** The prompt still renders from props alone (the mock harness) when no engine is provided. */
function useWeftIfProvided() {
  try {
    return useWeft()
  } catch {
    return undefined
  }
}

function readDataURL(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** The inkwell: what you write drops into the conversation when sent; `!` runs a shell command instead. */
export function Fell(props: {
  context: ContextView
  agent: string
  agents: string[]
  model: { providerID: string; modelID: string; variant?: string; name?: string }
  /** the open session; without one the first send creates it through `onSession` or `createSession` */
  sessionID?: string
  /** defaults to the session's status */
  busy?: boolean
  /** the reply whose output speed is shown: the one streaming, else the last one */
  reply?: PickView
  /** chips owned by the caller, shown before the prompt's own attachments */
  attachments?: AttachmentChip[]
  onAgent: (agent: string) => void
  onModel: () => void
  /** replaces `actions.send` for plain prompts */
  onSend?: (text: string, attachments: Attachment[], mentions: Mention[]) => void
  /** replaces `actions.abort` */
  onStop?: () => void
  /** replaces the built-in file picker */
  onAttach?: () => void
  onDetach?: (id: string) => void
  onSession?: () => Promise<string>
}) {
  const weft = useWeftIfProvided()
  const state = weft?.state
  const commands = () => state?.commands ?? []
  const [text, setText] = createSignal("")
  const [shell, setShell] = createSignal(false)
  const [files, setFiles] = createSignal<Pinned[]>([])
  const [mentionPaths, setMentionPaths] = createSignal<string[]>([])
  const [caret, setCaret] = createSignal(0)
  const [closedAt, setClosedAt] = createSignal<number>()
  const [active, setActive] = createSignal(0)
  const [found, setFound] = createSignal<string[]>([])
  const [searching, setSearching] = createSignal(false)
  const [recall, setRecall] = createSignal<number>()
  const [dropping, setDropping] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const sentHere: string[] = []
  let box!: HTMLDivElement
  let area!: HTMLTextAreaElement
  let mirror: HTMLDivElement | undefined
  let picker!: HTMLInputElement
  let searchTimer = 0
  let searchSeq = 0

  const used = () => props.context.spent.reduce((a, s) => a + s.tokens, 0)
  const busy = () => props.busy ?? (props.sessionID ? (state?.status[props.sessionID]?.type ?? "idle") !== "idle" : false)
  const located = createMemo(() => (shell() ? [] : locateMentions(text(), mentionPaths())))
  const trigger = createMemo(() => (shell() ? undefined : triggerAt(text(), caret())))
  const open = createMemo(() => {
    const t = trigger()
    return t && t.start !== closedAt() ? t : undefined
  })
  const items = createMemo(() => {
    const t = open()
    if (!t) return []
    return t.kind === "file" ? fileSuggestions(found()) : commandSuggestions(commands(), t.query)
  })
  const ready = () => (shell() ? !!text().trim() : !!text().trim() || files().length > 0)

  createEffect(() => {
    if (!trigger()) setClosedAt(undefined)
  })
  createEffect(on(() => open()?.query, () => setActive(0)))
  createEffect(
    on(
      () => {
        const t = open()
        return t?.kind === "file" ? t.query : undefined
      },
      (query) => {
        window.clearTimeout(searchTimer)
        const seq = ++searchSeq
        if (query === undefined) return setSearching(false)
        setSearching(true)
        const search = async (q: string) => (weft ? weft.actions.findFiles(q) : [])
        searchTimer = window.setTimeout(() => {
          search(query)
            .then((paths) => seq === searchSeq && setFound(paths.slice(0, 12)))
            .catch(() => seq === searchSeq && setFound([]))
            .finally(() => seq === searchSeq && setSearching(false))
        }, 90)
      },
    ),
  )
  onCleanup(() => window.clearTimeout(searchTimer))

  const fit = () => {
    area.style.height = "auto"
    area.style.height = `${Math.min(area.scrollHeight, 280)}px`
    if (mirror) {
      mirror.style.paddingRight = `${area.offsetWidth - area.clientWidth}px`
      mirror.scrollTop = area.scrollTop
    }
  }

  function write(value: string, at = value.length) {
    setText(value)
    area.value = value
    area.setSelectionRange(at, at)
    setCaret(at)
    fit()
  }

  function history() {
    const content = props.sessionID ? state?.content[props.sessionID] : undefined
    const spoken = content
      ? content.messages.filter((m) => m.role === "user").map((m) => partText(content.parts[m.id] ?? []))
      : []
    const texts = spoken.filter((t) => t.trim())
    return texts.length ? texts : sentHere
  }

  function recallStep(step: 1 | -1) {
    const past = history()
    const next = (recall() ?? -1) + step
    if (next >= past.length) return
    if (next < 0) {
      setRecall(undefined)
      write("")
      return
    }
    setRecall(next)
    write(past[past.length - 1 - next], step === 1 ? 0 : undefined)
  }

  function pick(index: number) {
    const t = open()
    const item = items()[index]
    if (!t || !item) return
    const insert = t.kind === "file" ? `@${item.key} ` : `/${item.key} `
    const before = text().slice(0, t.start)
    const after = text().slice(t.end).replace(/^ /, "")
    if (t.kind === "file") setMentionPaths((paths) => (paths.includes(item.key) ? paths : [...paths, item.key]))
    write(before + insert + after, before.length + insert.length)
  }

  function invocation(value: string) {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value)
    if (!match || !commands().some((c) => c.name === match[1])) return
    return { name: match[1], args: (match[2] ?? "").trim() }
  }

  function engine() {
    if (!weft) throw new Error("No engine is connected")
    return weft.actions
  }

  async function sessionFor() {
    if (props.sessionID) return props.sessionID
    if (props.onSession) return props.onSession()
    return (await engine().createSession(state?.directory)).id
  }

  /** Sending throws the words up out of the inkwell into the water. */
  function pour(name: "user" | "tool") {
    const rect = box.getBoundingClientRect()
    ink.throw(rect.left + rect.width * 0.18, rect.top - 4, 40, -820, name, 1.1)
    ink.throw(rect.left + rect.width * 0.18, rect.top - 4, -60, -520, name, 0.5)
  }

  async function send() {
    if (busy() || !ready()) return
    const value = text().trim()
    const asShell = shell()
    const invoked = asShell ? undefined : invocation(value)
    const consumes = !asShell && !invoked
    const pinned = files()
    const attachments = consumes ? pinned.map(({ name, mime, url }) => ({ name, mime, url })) : []
    const mentions = consumes ? locateMentions(value, mentionPaths()) : []
    const draft = { text: text(), shell: asShell, paths: mentionPaths() }
    batch(() => {
      setText("")
      setShell(false)
      setMentionPaths([])
      setRecall(undefined)
      setFailure(undefined)
      if (consumes) setFiles([])
    })
    area.value = ""
    fit()
    pour(asShell ? "tool" : "user")
    if (consumes) sentHere.push(value)
    if (consumes && props.onSend) return props.onSend(value, attachments, mentions)
    try {
      const sessionID = await sessionFor()
      if (asShell) await engine().shell(sessionID, value)
      else if (invoked) await engine().command(sessionID, invoked.name, invoked.args)
      else await engine().send(sessionID, value, attachments, mentions)
    } catch (error) {
      if (!text() && !shell()) {
        batch(() => {
          setShell(draft.shell)
          setMentionPaths(draft.paths)
          if (consumes) setFiles(pinned)
        })
        write(draft.text)
      }
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const givenBack = new Set<number>()
  createEffect(
    on(
      () => (props.sessionID ? state?.errors?.[props.sessionID] : undefined),
      (refused) => {
        if (!refused?.unsent || givenBack.has(refused.at)) return
        givenBack.add(refused.at)
        if (!text() && !shell()) write(refused.unsent)
      },
    ),
  )

  function stop() {
    if (props.onStop) props.onStop()
    else if (props.sessionID)
      weft?.actions.abort(props.sessionID).catch((error) => setFailure(`The reply did not stop: ${error instanceof Error ? error.message : error}`))
  }

  function pin(next: Pinned[]) {
    setFiles((held) => [...held, ...next.filter((n) => !held.some((h) => h.name === n.name && h.url === n.url))])
    const note = binaryNote(next.filter((n) => !readable(n.mime)).map((n) => n.name))
    if (note) setFailure(note)
  }

  async function attachFiles(list: FileList | File[] | null | undefined) {
    const chosen = Array.from(list ?? [])
    if (!chosen.length) return
    try {
      pin(
        await Promise.all(
          chosen.map(async (file) => ({
            name: file.name || "pasted image",
            mime: fileMime(file),
            url: await readDataURL(file),
            size: file.size,
          })),
        ),
      )
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  function attachPaths(paths: string[]) {
    pin(paths.map((path) => ({ name: path.split(/[\\/]/).pop() ?? path, mime: mimeOf(path), url: fileURL(path) })))
  }

  async function chooseFiles() {
    if (props.onAttach) return props.onAttach()
    if (!inTauri) return picker.click()
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
      const chosen = await openDialog({ multiple: true, directory: false, title: "Attach files" })
      if (chosen) attachPaths(Array.isArray(chosen) ? chosen : [chosen])
    } catch (error) {
      setFailure(`The file picker did not open: ${error instanceof Error ? error.message : error}`)
    }
  }

  let unlistenDrop: (() => void) | undefined
  let unmounted = false
  onMount(async () => {
    if (!inTauri) return
    const { getCurrentWebview } = await import("@tauri-apps/api/webview")
    const unlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") setDropping(true)
      else if (payload.type === "leave") setDropping(false)
      else {
        setDropping(false)
        attachPaths(payload.paths)
      }
    })
    if (unmounted) unlisten()
    else unlistenDrop = unlisten
  })
  onCleanup(() => {
    unmounted = true
    unlistenDrop?.()
  })

  function onInput(event: InputEvent & { currentTarget: HTMLTextAreaElement }) {
    let value = event.currentTarget.value
    let at = event.currentTarget.selectionStart
    if (!shell() && value.startsWith("!")) {
      setShell(true)
      value = value.slice(1)
      at = Math.max(0, at - 1)
      event.currentTarget.value = value
      event.currentTarget.setSelectionRange(at, at)
    }
    batch(() => {
      setText(value)
      setRecall(undefined)
      setFailure(undefined)
      setCaret(at)
    })
    fit()
  }

  function onKey(event: KeyboardEvent) {
    if (event.isComposing) return
    const popover = open()
    if (popover && !event.ctrlKey) {
      const count = items().length
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        event.preventDefault()
        setActive((i) => (i + (event.key === "ArrowDown" ? 1 : count - 1)) % count)
        return
      }
      if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && count) {
        event.preventDefault()
        pick(active())
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setClosedAt(popover.start)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void send()
    } else if (event.key === "Escape") {
      if (busy()) stop()
      else if (shell()) setShell(false)
    } else if (event.key === "Backspace" && shell() && area.selectionStart === 0 && area.selectionEnd === 0) {
      event.preventDefault()
      setShell(false)
    } else if (event.key === "ArrowUp" && area.selectionStart === 0 && area.selectionEnd === 0 && (!text() || recall() !== undefined)) {
      event.preventDefault()
      recallStep(1)
    } else if (event.key === "ArrowDown" && recall() !== undefined && area.selectionStart === text().length) {
      event.preventDefault()
      recallStep(-1)
    }
  }

  const syncCaret = () => setCaret(area.selectionStart)

  return (
    <footer class="fell" classList={{ shell: shell() }}>
      <Show when={open()}>
        {(t) => (
          <Suggest
            kind={t().kind}
            query={t().query}
            items={items()}
            active={active()}
            loading={t().kind === "file" && searching()}
            onPick={pick}
            onHover={setActive}
          />
        )}
      </Show>
      <div
        ref={box}
        class="fell-box"
        data-role={shell() ? "tool" : "user"}
        classList={{ shell: shell(), dropping: dropping() }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer?.files.length) return
          e.preventDefault()
          setDropping(false)
          void attachFiles(e.dataTransfer.files)
        }}
      >
        <Show when={(props.attachments?.length ?? 0) + files().length}>
          <div class="fell-chips">
            <For each={props.attachments ?? []}>
              {(a) => (
                <span class="chip">
                  {a.name}
                  <Show when={a.detail}>
                    <span class="dim"> {a.detail}</span>
                  </Show>
                  <button aria-label={`Remove ${a.name}`} onClick={() => props.onDetach?.(a.id)}>
                    <IconClose size={11} />
                  </button>
                </span>
              )}
            </For>
            <For each={files()}>
              {(f) => (
                <span class="chip" title={f.url.startsWith("file:") ? decodeURI(f.url) : f.name}>
                  <Show when={f.mime.startsWith("image/") && f.url.startsWith("data:")}>
                    <img class="chip-thumb" src={f.url} alt="" />
                  </Show>
                  {f.name}
                  <Show when={sizeLabel(f.size)}>
                    <span class="dim"> {sizeLabel(f.size)}</span>
                  </Show>
                  <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((held) => held.filter((h) => h !== f))}>
                    <IconClose size={11} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <div class="fell-field">
          <Show when={shell()}>
            <span class="fell-mode" title="Runs in the project's shell. Backspace at the start returns to writing.">
              <IconTerminal size={14} /> Shell
            </span>
          </Show>
          <Show when={located().length}>
            <MentionMirror text={text()} mentions={located()} ref={(el) => (mirror = el)} />
          </Show>
          <textarea
            ref={area}
            class="fell-input selectable"
            rows={1}
            spellcheck={!shell()}
            placeholder={shell() ? "A command to run in the project" : "Write to opencode.  / commands   @ files   ! shell"}
            aria-label={shell() ? "shell command" : "message"}
            aria-autocomplete="list"
            aria-controls={open() ? SUGGEST_ID : undefined}
            aria-activedescendant={open() && items().length ? optionID(active()) : undefined}
            value={text()}
            onInput={onInput}
            onKeyDown={onKey}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onSelect={syncCaret}
            onBlur={() => setClosedAt(trigger()?.start)}
            onFocus={() => setClosedAt(undefined)}
            onScroll={() => mirror && (mirror.scrollTop = area.scrollTop)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.files
              if (!pasted?.length) return
              e.preventDefault()
              void attachFiles(pasted)
            }}
          />
        </div>
        <Show when={dropping()}>
          <div class="fell-drop label" aria-hidden="true">
            Drop to attach
          </div>
        </Show>
        <div class="fell-controls">
          <div class="seg" role="radiogroup" aria-label="agent">
            <For each={props.agents}>
              {(a) => (
                <button role="radio" aria-checked={props.agent === a} classList={{ on: props.agent === a }} onClick={() => props.onAgent(a)}>
                  {a}
                </button>
              )}
            </For>
          </div>
          <button
            class="model-pill"
            classList={{ unset: !props.model.modelID }}
            onClick={props.onModel}
            title={props.model.modelID ? `${props.model.providerID}/${props.model.modelID}: choose another model` : "Choose a model"}
          >
            <span>{props.model.name || props.model.modelID || "Choose a model"}</span>
            <Show when={props.model.variant}>
              <span class="variant">{props.model.variant}</span>
            </Show>
          </button>
          <button class="icon-btn" onClick={() => void chooseFiles()} title="Attach a file">
            <IconFile size={16} />
          </button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => void attachFiles(e.currentTarget.files).then(() => (picker.value = ""))} />
          <span class="spacer" />
          <Speed reply={props.reply} />
          <span class="usage" title="Context in use, by who used it">
            <Vessel limit={props.context.limit} spent={props.context.spent} size={16} />
            <span class="num">
              {compact(used())}
              <Show when={props.context.limit > 0}>
                <span class="dim"> of {compact(props.context.limit)}</span>
              </Show>
            </span>
          </span>
          <span class="num cost">${props.context.cost.toFixed(2)}</span>
          <Show
            when={busy()}
            fallback={
              <button class="send" onClick={() => void send()} disabled={!ready()} title={shell() ? "Run (Enter)" : "Send (Enter)"}>
                <IconArrow dir="up" size={16} />
              </button>
            }
          >
            <button class="send stop" onClick={stop} title="Stop (Esc)">
              <IconStop size={14} />
            </button>
          </Show>
        </div>
        <Show when={failure()}>
          <div class="fell-error" role="alert">
            {failure()}
          </div>
        </Show>
      </div>
    </footer>
  )
}
