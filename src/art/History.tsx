import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { partText, type PickView } from "../engine/view"
import { IconClose, IconSearch } from "../ui/icons"
import { SPEAKER } from "../ui/Pick"

/** A preview reads as words, not markdown source: code spans keep their text; emphasis, heading and quote marks go. */
function plain(markdown: string) {
  return markdown
    .split(/(`[^`\n]*`)/)
    .map((piece, i) => (i % 2 ? piece.slice(1, -1) : piece.replace(/^\s*(#{1,6}|>)\s*|\*{1,3}(?=\S)|(?<=\S)\*{1,3}|`+/gm, "")))
    .join("")
}

function summary(pick: PickView) {
  const text = plain(partText(pick.parts)).replace(/\s+/g, " ").trim()
  if (text) return text
  const tools = pick.parts.filter((p) => p.type === "tool").map((p) => (p.type === "tool" ? p.tool : ""))
  return tools.length ? `Used ${tools.join(", ")}` : "(empty)"
}

const roleOf = (pick: PickView) => (pick.parts.length > 0 && pick.parts.every((p) => p.type === "tool") ? "tool" : pick.role)

/** The whole conversation at a glance: one line per message. Type to find one, Enter to go there. */
export function History(props: { picks: PickView[]; title?: string; onClose: () => void; onJump: (index: number) => void }) {
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  let input!: HTMLInputElement

  const rows = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.picks
      .map((pick, index) => ({ pick, index, text: summary(pick) }))
      .filter((row) => !q || row.text.toLowerCase().includes(q) || SPEAKER[row.pick.role].toLowerCase().includes(q))
  })

  onMount(() => input.focus())

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") props.onClose()
    else if (event.key === "ArrowDown") setCursor(Math.min(rows().length - 1, cursor() + 1))
    else if (event.key === "ArrowUp") setCursor(Math.max(0, cursor() - 1))
    else if (event.key === "Enter") {
      const row = rows()[cursor()]
      if (row) props.onJump(row.index)
    } else return
    event.preventDefault()
  }

  return (
    <>
      <div class="history-scrim" onClick={props.onClose} />
      <div class="history rise" onKeyDown={onKey}>
        <header class="history-head">
          <div>
            <h2 class="history-title">The whole conversation</h2>
            <p class="history-sub">
              {props.title ?? "This session"} · {props.picks.length} messages
            </p>
          </div>
          <button class="icon-btn" onClick={props.onClose} title="Close (Esc)">
            <IconClose size={16} />
          </button>
        </header>
        <label class="search history-search">
          <IconSearch size={15} />
          <input
            ref={input}
            value={query()}
            placeholder="Find a message"
            spellcheck={false}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setCursor(0)
            }}
          />
        </label>
        <ol class="history-list">
          <For each={rows()} fallback={<li class="history-none">Nothing matches.</li>}>
            {(row, i) => (
              <li data-role={roleOf(row.pick)} classList={{ on: i() === cursor(), muted: row.pick.muted }}>
                <button onClick={() => props.onJump(row.index)} onMouseEnter={() => setCursor(i())}>
                  <span class="drop" />
                  <span class="history-who">{roleOf(row.pick) === "tool" ? "Tools" : SPEAKER[row.pick.role]}</span>
                  <span class="history-text">{row.text}</span>
                  <Show when={row.pick.mends?.length}>
                    <span class="tag">edited</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ol>
      </div>
    </>
  )
}
