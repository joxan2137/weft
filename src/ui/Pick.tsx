import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2/types"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, useContext } from "solid-js"
import { Portal } from "solid-js/web"
import { WeftContext } from "../engine/context"
import { PLACEHOLDERS } from "../engine/liberate"
import { measuredRate, rateLabel } from "../engine/speed"
import { partText, type PickView, type Role, type WarpView } from "../engine/view"
import { ask, MenuItem, Popover, toast, toastError } from "./dialogs"
import { renderMarkdown } from "./markdown"
import { Brocade } from "./parts/Brocade"
import { Prose } from "./parts/Prose"
import { Reverse } from "./parts/Reverse"
import { IconCopy, IconFork, IconMore, IconNeedle, IconScissors } from "./icons"
import { copyText, openExternal } from "./platform"
import { ink } from "../art/ink"

/** One edit gesture: the part under the pointer (or the system prompt's template), its new text and the message's role. */
export type PickEdit = { partID?: string; text: string; role: Role; resend: boolean }

export type PickActions = {
  save: (pick: PickView, edit: PickEdit) => void
  fork: (pick: PickView) => void
  /** a user message goes with its replies unless `keepReplies` */
  remove: (pick: PickView, keepReplies?: boolean) => void
  openSession?: (id: string) => void
  insertAfter?: (pick: PickView, text: string, role: Role) => void
  setMuted?: (pick: PickView, muted: boolean) => void
  move?: (pick: PickView, step: -1 | 1) => void
  regenerate?: (pick: PickView) => void
  /** the system prompt only: drop the rewrite and go back to opencode's default prompt */
  resetWarp?: (pick: PickView) => void
}

const ROLES: Role[] = ["system", "user", "assistant"]

/** Who said it, in words (docs/DESIGN.md A.1). */
export const SPEAKER: Record<Role, string> = { system: "Source", user: "You", assistant: "opencode" }
const KNOWN_PLACEHOLDERS = new Set<string>(PLACEHOLDERS)
const dev = import.meta.env.DEV ? new URLSearchParams(location.search) : undefined

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

const isEditable = (part: Part): part is TextPart | ReasoningPart =>
  (part.type === "text" && !part.synthetic && !part.ignored) || part.type === "reasoning"

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/** Deleted messages are gone for good, in OpenCode Desktop too: every message action that deletes asks first. */
function confirmCut(title: string, confirm: string, what: string) {
  return ask({
    title,
    confirm,
    danger: true,
    body: [what, "OpenCode Desktop shares the engine's database, so the change shows there too. This cannot be undone."],
  })
}

async function removePick(pick: PickView, actions: PickActions) {
  if (!pick.replies) {
    if (await confirmCut("Delete this message?", "Delete message", "This message will be removed from the engine's database.")) actions.remove(pick)
    return
  }
  const what = `This message and the ${plural(pick.replies, "reply", "replies")} answering it will be removed from the engine's database: OpenCode Desktop shows them as one turn. To keep the replies, cancel and choose Delete message only in the message's menu.`
  if (await confirmCut("Delete this turn?", "Delete turn", what)) actions.remove(pick)
}

async function removeMessageOnly(pick: PickView, actions: PickActions) {
  const what = `This message will be removed from the engine's database and its ${plural(pick.replies ?? 0, "reply", "replies")} kept. OpenCode Desktop hides replies whose message is gone, yet still sends them to the model.`
  if (await confirmCut("Delete only this message?", "Delete message only", what)) actions.remove(pick, true)
}

async function regeneratePick(pick: PickView, actions: PickActions, later: number) {
  const what = `This reply and the ${plural(later, "message")} after it will be removed from the engine's database, then the model answers again.`
  if (later > 0 && !(await confirmCut("Regenerate from here?", "Delete and regenerate", what))) return
  actions.regenerate?.(pick)
}

/** The second click of a double-click lands on whatever slid under the pointer after the first one. */
const single = (run: () => void) => (event: MouseEvent) => event.detail < 2 && run()

/** A refused clipboard says so instead of failing silently. */
const copy = (text: string) => void copyText(text).catch(() => toast("The text could not be copied", "warn"))

/** What an edit starts from: the double-clicked part when it holds text, else the first prose part. */
function targetOf(pick: PickView, partID?: string): { partID?: string; text: string; reverse?: boolean } {
  if (pick.warp) return { partID: pick.parts[0]?.id, text: pick.warp.template }
  const chosen = pick.parts.find((p) => p.id === partID)
  const part = chosen && isEditable(chosen) ? chosen : pick.parts.find((p) => p.type === "text" && isEditable(p))
  if (!part || !isEditable(part)) return { text: "" }
  return { partID: part.id, text: part.text, reverse: part.type === "reasoning" }
}

function Spools(props: { role: Role; onPick: (role: Role) => void }) {
  return (
    <div class="spools" role="radiogroup" aria-label="role">
      <For each={ROLES}>
        {(role) => (
          <button
            class="spool"
            data-role={role}
            role="radio"
            aria-checked={props.role === role}
            classList={{ active: props.role === role }}
            onClick={() => props.onPick(role)}
          >
            <span class="pot" aria-hidden="true" />
            <span>{SPEAKER[role]}</span>
          </button>
        )}
      </For>
    </div>
  )
}


function Editor(props: {
  pick: PickView
  index: number
  actions: PickActions
  done: () => void
  /** the part being edited; absent when inserting a new message after this one */
  target?: { partID?: string; text: string; reverse?: boolean }
  insertRole?: Role
  /** messages after this one, which Save and resend deletes */
  later?: number
}) {
  const warp = () => !!props.pick.warp
  const inserting = () => props.insertRole !== undefined
  const [text, setText] = createSignal(props.target?.text ?? "")
  const [role, setRole] = createSignal<Role>(props.insertRole ?? props.pick.role)
  let area!: HTMLTextAreaElement

  /** The part changed after the editor copied it (a reply that kept streaming, an edit elsewhere): saving would cut it back. */
  const stale = () => {
    const id = props.target?.partID
    const part = id && !warp() ? props.pick.parts.find((p) => p.id === id) : undefined
    return !!part && isEditable(part) && part.text !== props.target?.text
  }
  const unchanged = () => text() === (props.target?.text ?? "") && role() === props.pick.role

  const fit = () => {
    area.style.height = "auto"
    area.style.height = `${Math.min(area.scrollHeight + 2, window.innerHeight * 0.6)}px`
  }
  onMount(() => {
    fit()
    area.focus({ preventScroll: true })
    area.setSelectionRange(area.value.length, area.value.length)
  })

  const canResend = () =>
    !warp() && !inserting() && !props.pick.reverted && props.pick.info.role === "user" && role() === "user" && !props.target?.reverse

  const save = async (resend: boolean) => {
    if (inserting()) {
      if (text().trim()) props.actions.insertAfter?.(props.pick, text(), role())
      return props.done()
    }
    const resending = resend && canResend()
    if (!resending && unchanged()) return props.done()
    if (stale()) return toast("This message changed while the editor was open. Copy your text, press Cancel and edit it again.", "warn")
    const what = `The ${plural(props.later ?? 0, "message")} after this one will be removed from the engine's database before the model answers.`
    if (resending && props.later && !(await confirmCut("Save and resend?", "Delete and resend", what))) return
    props.actions.save(props.pick, { partID: props.target?.partID, text: text(), role: role(), resend: resending })
    const rect = area.getBoundingClientRect()
    ink.stir(rect.left + 24, rect.top + rect.height / 2, role())
    props.done()
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation()
      props.done()
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) save(event.shiftKey)
  }

  const hint = () => {
    const no = String(props.index).padStart(2, "0")
    if (inserting()) return `A new message after ${no}`
    if (warp()) return "Rewriting the source"
    return props.target?.reverse ? `Rewriting the reasoning of ${no}` : `Rewriting message ${no}`
  }

  return (
    <div class="editor rise" data-role={role()} classList={{ inserting: inserting() }}>
      <div class="editor-bar">
        <span class="editor-hint">{hint()}</span>
        <span class="spacer" />
        <Show when={!warp()}>
          <Spools role={role()} onPick={setRole} />
        </Show>
      </div>
      <textarea
        ref={area}
        class="editor-text"
        value={text()}
        placeholder={inserting() ? `What does ${SPEAKER[role()].toLowerCase()} say?` : undefined}
        onInput={(e) => {
          setText(e.currentTarget.value)
          fit()
        }}
        onKeyDown={onKey}
        spellcheck={role() !== "system"}
      />
      <div class="editor-actions">
        <Show when={!warp() && !inserting()}>
          <button class="btn ghost" onClick={() => props.actions.fork(props.pick)}>
            <IconFork size={14} /> Fork from here
          </button>
          <button class="btn ghost danger" onClick={() => void removePick(props.pick, props.actions)}>
            <IconScissors size={14} /> Delete
          </button>
        </Show>
        <Show when={warp() && props.pick.warp?.rewritten && props.actions.resetWarp}>
          <button
            class="btn ghost"
            onClick={() => {
              props.actions.resetWarp?.(props.pick)
              props.done()
            }}
          >
            Restore the default
          </button>
        </Show>
        <span class="spacer" />
        <button class="btn ghost" onClick={props.done}>
          Cancel <kbd>Esc</kbd>
        </button>
        <Show when={canResend()}>
          <button class="btn" onClick={() => save(true)}>
            Save and resend <kbd>Ctrl Shift ↵</kbd>
          </button>
        </Show>
        <button class="btn primary" onClick={() => save(false)} disabled={inserting() && !text().trim()}>
          {inserting() ? "Insert" : "Save"} <kbd>Ctrl ↵</kbd>
        </button>
      </div>
    </div>
  )
}

/** The system prompt's template with its {{placeholders}} as chips; hovering one shows what the plugin last saw there. */
function WarpBody(props: { warp: WarpView }) {
  let root!: HTMLDivElement
  const [hover, setHover] = createSignal<{ name: string; left: number; top: number }>()
  let closeTimer = 0

  const html = createMemo(() => {
    const names: string[] = []
    const marked = props.warp.template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
      KNOWN_PLACEHOLDERS.has(name) ? `WEFTPH${names.push(name) - 1}X` : whole,
    )
    return renderMarkdown(marked).replace(
      /WEFTPH(\d+)X/g,
      (_, i: string) => `<span class="ph-chip" data-ph="${names[Number(i)]}" tabindex="0">${names[Number(i)]}</span>`,
    )
  })
  createEffect(() => (root.innerHTML = html()))

  const show = (chip: HTMLElement) => {
    window.clearTimeout(closeTimer)
    const rect = chip.getBoundingClientRect()
    setHover({ name: chip.dataset.ph ?? "", left: Math.min(rect.left, window.innerWidth - 500), top: rect.bottom + 6 })
  }
  const hide = () => {
    window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(() => setHover(undefined), 140)
  }
  onCleanup(() => window.clearTimeout(closeTimer))

  onMount(() => {
    const pinned = dev?.get("chip")
    if (!pinned) return
    requestAnimationFrame(() => {
      const chip = root.querySelector<HTMLElement>(`.ph-chip[data-ph="${CSS.escape(pinned)}"]`)
      if (chip) show(chip)
    })
  })

  const chipOf = (event: Event) => (event.target as HTMLElement).closest<HTMLElement>(".ph-chip")
  const value = () => {
    const name = hover()?.name
    return name ? props.warp.values?.[name] : undefined
  }

  return (
    <>
      <div
        ref={root}
        class="prose law selectable warp-body"
        onClick={(e) => {
          // A plain click would navigate the app window itself to the link.
          const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-external]")
          if (!link) return
          e.preventDefault()
          void openExternal(link.getAttribute("href") ?? "").catch(toastError)
        }}
        onMouseOver={(e) => {
          const chip = chipOf(e)
          if (chip) show(chip)
        }}
        onMouseOut={(e) => chipOf(e) && hide()}
        onFocusIn={(e) => {
          const chip = chipOf(e)
          if (chip) show(chip)
        }}
        onFocusOut={hide}
      />
      <Show when={hover()}>
        {(h) => (
          <Portal>
            <div
              class="ph-pop"
              role="tooltip"
              style={{ left: `${Math.max(8, h().left)}px`, top: `${h().top}px` }}
              onMouseEnter={() => window.clearTimeout(closeTimer)}
              onMouseLeave={hide}
            >
              <div class="ph-pop-head">
                <span class="label">{`{{${h().name}}}`}</span>
                <span class="num dim">
                  <Show when={props.warp.observedAt} fallback="not observed yet">
                    seen {clock(props.warp.observedAt!)}
                    <Show when={props.warp.exact === false}> · approximate</Show>
                  </Show>
                </span>
              </div>
              <Show
                when={value() !== undefined}
                fallback={<p class="ph-pop-empty">Filled in by the engine on the next turn. Weft shows it here once a turn has run.</p>}
              >
                <pre class="ph-pop-value">{value() || "(empty)"}</pre>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}

function Body(props: { pick: PickView; actions: PickActions; root?: string }) {
  const lastText = createMemo(() => {
    const texts = props.pick.parts.filter((p) => p.type === "text")
    return texts[texts.length - 1]?.id
  })
  return (
    <For each={props.pick.parts}>
      {(part: Part) => (
        <div class="part" data-part={part.id}>
          <Switch>
            <Match when={part.type === "text" && !(part as TextPart).synthetic}>
              <Prose
                text={(part as TextPart).text}
                live={props.pick.live && part.id === lastText()}
                class={props.pick.role === "system" ? "law" : ""}
              />
            </Match>
            <Match when={part.type === "reasoning"}>
              <Reverse
                text={(part as ReasoningPart).text}
                live={props.pick.live && !(part as ReasoningPart).time.end}
                seconds={
                  (part as ReasoningPart).time.end
                    ? ((part as ReasoningPart).time.end! - (part as ReasoningPart).time.start) / 1000
                    : undefined
                }
              />
            </Match>
            <Match when={part.type === "tool"}>
              <Brocade part={part as ToolPart} root={props.root} onOpenSession={props.actions.openSession} />
            </Match>
            <Match when={part.type === "file"}>
              <div class="attachment mono">{(part as Extract<Part, { type: "file" }>).filename ?? "attachment"}</div>
            </Match>
          </Switch>
        </div>
      )}
    </For>
  )
}

function PickMenu(props: {
  pick: PickView
  anchor: HTMLElement
  busy?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  later: number
  actions: PickActions
  onInsert: (role: Role) => void
  onClose: () => void
}) {
  const warp = () => !!props.pick.warp
  const run = (action: () => void) => () => {
    props.onClose()
    action()
  }
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement="bottom-end" label="Message actions" class="pick-menu">
      <Show when={props.actions.insertAfter}>
        <div
          class="menu-row"
          classList={{ disabled: props.busy || props.pick.reverted }}
          title={props.busy ? "Stop the session to insert a message" : props.pick.reverted ? "Unrevert first: an insert deletes this undone message" : undefined}
        >
          <span class="menu-row-label">Insert after</span>
          <For each={ROLES}>
            {(role) => (
              <button class="spool mini" data-role={role} disabled={props.busy || props.pick.reverted} onClick={run(() => props.onInsert(role))}>
                <span class="pot" aria-hidden="true" />
                <span>{SPEAKER[role]}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={!warp()}>
        <Show when={props.actions.setMuted}>
          <MenuItem onSelect={run(() => props.actions.setMuted?.(props.pick, !props.pick.muted))}>
            <span>{props.pick.muted ? "Unmute" : "Mute"}</span>
            <span class="menu-note">{props.pick.muted ? "back into the current" : "let it settle: kept, never sent"}</span>
          </MenuItem>
        </Show>
        <Show when={props.actions.move && props.canMoveUp}>
          <MenuItem onSelect={run(() => props.actions.move?.(props.pick, -1))}>
            <span>Move up</span>
            <span class="menu-note">↑</span>
          </MenuItem>
        </Show>
        <Show when={props.actions.move && props.canMoveDown}>
          <MenuItem onSelect={run(() => props.actions.move?.(props.pick, 1))}>
            <span>Move down</span>
            <span class="menu-note">↓</span>
          </MenuItem>
        </Show>
      </Show>
      <MenuItem onSelect={run(() => copy(warp() ? props.pick.warp!.template : partText(props.pick.parts)))}>
        <span>Copy</span>
      </MenuItem>
      <Show when={!warp()}>
        <MenuItem onSelect={run(() => props.actions.fork(props.pick))}>
          <span>Fork from here</span>
        </MenuItem>
        <Show when={props.pick.role === "assistant" && !props.pick.reverted && props.actions.regenerate}>
          <MenuItem onSelect={run(() => void regeneratePick(props.pick, props.actions, props.later))}>
            <span>Regenerate</span>
          </MenuItem>
        </Show>
        <MenuItem danger onSelect={run(() => void removePick(props.pick, props.actions))}>
          <span>{props.pick.replies ? "Delete turn" : "Delete"}</span>
        </MenuItem>
        <Show when={props.pick.replies}>
          <MenuItem danger onSelect={run(() => void removeMessageOnly(props.pick, props.actions))}>
            <span>Delete message only</span>
            <span class="menu-note">keep its replies</span>
          </MenuItem>
        </Show>
      </Show>
    </Popover>
  )
}

/** One message in the conversation. Double-click a part to edit it. */
export function Pick(props: {
  pick: PickView
  index: number
  actions: PickActions
  root?: string
  busy?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  /** messages after this one in the conversation */
  later?: number
}) {
  const initialEdit = dev?.get("edit") === String(props.index)
  const [editing, setEditing] = createSignal<ReturnType<typeof targetOf> | undefined>(initialEdit ? targetOf(props.pick) : undefined)
  const [inserting, setInserting] = createSignal<Role>()
  const [folded, setFolded] = createSignal(!!props.pick.warp && !dev?.has("unfold"))
  const [ghost, setGhost] = createSignal(false)
  const [menu, setMenu] = createSignal<HTMLElement>()
  let more!: HTMLButtonElement
  let article!: HTMLElement
  const info = () => props.pick.info
  const model = () => (info().role === "assistant" ? (info() as { modelID: string }).modelID : "")
  const tokens = () => {
    const i = info()
    return i.role === "assistant" ? i.tokens.output + i.tokens.reasoning : 0
  }
  const rate = createMemo(() => (props.pick.live ? undefined : measuredRate(info(), props.pick.parts)))
  const isWarp = () => !!props.pick.warp
  const toolOnly = () => props.pick.parts.length > 0 && props.pick.parts.every((p) => p.type === "tool")
  const who = () => (toolOnly() ? "Tools" : SPEAKER[props.pick.role])
  const weft = useContext(WeftContext)
  const defaultAgent = () =>
    weft?.state.config?.default_agent ?? weft?.state.agents.find((a) => a.mode !== "subagent" && !a.hidden)?.name ?? "build"
  /** the speaker is always opencode; an agent other than the default one is named beside it */
  const agent = () => {
    const i = info()
    if (toolOnly() || i.role !== "assistant" || !i.agent || i.agent === defaultAgent()) return undefined
    return i.agent
  }

  onMount(() => {
    if (dev?.get("menu") === String(props.index)) requestAnimationFrame(() => setMenu(more))
    if (initialEdit) requestAnimationFrame(() => article.scrollIntoView({ block: "center" }))
  })

  // The system prompt keeps its row when another session opens (it has the same id in every session): an open editor must not carry over.
  createEffect(
    on(
      () => props.pick.info.sessionID,
      () => {
        setEditing(undefined)
        setInserting(undefined)
        setMenu(undefined)
      },
      { defer: true },
    ),
  )

  function edit(partID?: string) {
    // A reply still streaming keeps growing: an editor opened now would hold a cut-off copy.
    if (props.pick.live) return
    setEditing(targetOf(props.pick, partID))
  }

  function onDouble(event: MouseEvent) {
    if (editing()) return
    const target = event.target as HTMLElement
    if (target.closest("button, a, .brocade-body, figure, .ph-chip")) return
    window.getSelection()?.removeAllRanges()
    edit(target.closest<HTMLElement>("[data-part]")?.dataset.part)
  }

  return (
    <article
      ref={article}
      class="pick"
      data-role={props.pick.role}
      data-pick={props.index}
      classList={{
        editing: !!editing(),
        live: props.pick.live,
        folded: folded() && !editing(),
        warp: isWarp(),
        muted: !!props.pick.muted || !!props.pick.reverted,
      }}
      onDblClick={onDouble}
    >
      <header class="pick-head">
        <span class="drop" data-role={toolOnly() ? "tool" : props.pick.role} aria-hidden="true" />
        <span class="who">{who()}</span>
        <Show when={agent()}>{(name) => <span class="tag">{name()}</span>}</Show>
        <Show when={props.pick.warp?.rewritten}>
          <span class="tag warp-label">rewritten</span>
        </Show>
        <Show when={props.pick.muted}>
          <span class="tag muted-label" title="Settled: kept in the conversation, never sent to the model">
            settled · not sent
          </span>
        </Show>
        <Show when={props.pick.reverted}>
          <span class="tag muted-label" title="Undone in OpenCode: kept for its Redo, left out of the model's context. The next prompt deletes it for good.">
            undone
          </span>
        </Show>
        <Show when={props.pick.mends?.length}>
          <span class="tag darn" onMouseEnter={() => setGhost(true)} onMouseLeave={() => setGhost(false)} title="Edited: hover to see the earlier text">
            edited
          </span>
        </Show>
        <span class="pick-meta num">
          <Show when={props.pick.source}>{props.pick.source} · </Show>
          <Show when={model()}>{model()} · </Show>
          {clock(info().time.created)}
          <Show when={tokens()}> · {tokens().toLocaleString()} tokens</Show>
          <Show when={rate()}>{(r) => <> · {rateLabel(r())} tok/s</>}</Show>
        </span>
        <span class="spacer" />
        <Show when={!editing()}>
          <span class="pick-tools" classList={{ open: !!menu() }}>
            <button title={props.pick.live ? "Edit once the reply is finished" : "Edit (double-click)"} disabled={props.pick.live} onClick={() => edit()}>
              <IconNeedle size={15} />
            </button>
            <button title="Copy" onClick={() => copy(isWarp() ? props.pick.warp!.template : partText(props.pick.parts))}>
              <IconCopy size={15} />
            </button>
            <Show when={!isWarp()}>
              <button title="Fork from here" onClick={single(() => props.actions.fork(props.pick))}>
                <IconFork size={15} />
              </button>
              <button title="Delete" class="danger" onClick={single(() => void removePick(props.pick, props.actions))}>
                <IconScissors size={15} />
              </button>
            </Show>
            <button ref={more} title="More" aria-haspopup="menu" onClick={() => setMenu(menu() ? undefined : more)}>
              <IconMore size={15} />
            </button>
          </span>
        </Show>
      </header>
      <Show when={ghost() && props.pick.mends?.length}>
        <div class="palimpsest" aria-hidden="true">
          {props.pick.mends![props.pick.mends!.length - 1].text}
        </div>
      </Show>
      <div class="pick-body">
        <Show
          when={editing()}
          fallback={
            <Show when={props.pick.warp} fallback={<Body pick={props.pick} actions={props.actions} root={props.root} />}>
              {(warp) => <WarpBody warp={warp()} />}
            </Show>
          }
        >
          {(target) => (
            <Editor pick={props.pick} index={props.index} actions={props.actions} target={target()} later={props.later} done={() => setEditing(undefined)} />
          )}
        </Show>
      </div>
      <Show when={isWarp() && !editing()}>
        <button class="unfold label" onClick={() => setFolded(!folded())}>
          {folded() ? `Read the whole source · ${props.pick.warp!.template.split("\n").length} lines` : "Fold the source"}
        </button>
      </Show>
      <Show when={inserting()} keyed>
        {(role) => (
          <div class="pick-insert">
            <Editor pick={props.pick} index={props.index} actions={props.actions} insertRole={role} done={() => setInserting(undefined)} />
          </div>
        )}
      </Show>
      <Show when={menu()}>
        {(anchor) => (
          <PickMenu
            pick={props.pick}
            anchor={anchor()}
            busy={props.busy}
            canMoveUp={props.canMoveUp}
            canMoveDown={props.canMoveDown}
            later={props.later ?? 0}
            actions={props.actions}
            onInsert={setInserting}
            onClose={() => setMenu(undefined)}
          />
        )}
      </Show>
    </article>
  )
}
