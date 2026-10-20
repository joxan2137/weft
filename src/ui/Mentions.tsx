import type { Command } from "@opencode-ai/sdk/v2/types"
import { createEffect, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Mention } from "../engine/contract"
import { IconFile, IconFolder, IconSlash } from "./icons"
import "./workbench.css"

export type Trigger = { kind: "file" | "command"; query: string; start: number; end: number }

export const SUGGEST_ID = "fell-suggest"
export const optionID = (index: number) => `${SUGGEST_ID}-${index}`

export type Suggestion = { key: string; label: string; detail?: string; tag?: string; icon: "file" | "folder" | "command" }

/** The `@file` or leading `/command` token the caret sits in, if any. */
export function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret)
  const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? ""
  const command = /^\/(\S*)$/.exec(before)
  if (command) return { kind: "command", query: command[1], start: 0, end: caret + rest.length }
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: "file", query: at[1], start: caret - at[1].length - 1, end: caret + rest.length }
}

/** Where each mentioned path still appears as an `@path` token in the text. */
export function locateMentions(text: string, paths: string[]): Mention[] {
  const found: Mention[] = []
  for (const path of paths) {
    const token = `@${path}`
    let from = 0
    while (from <= text.length) {
      const start = text.indexOf(token, from)
      if (start < 0) break
      const end = start + token.length
      const bounded = (start === 0 || /\s/.test(text[start - 1])) && (end === text.length || /\s/.test(text[end]))
      if (bounded) {
        found.push({ path, start, end })
        break
      }
      from = end
    }
  }
  return found.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}

export function commandSuggestions(commands: Command[], query: string, limit = 8): Suggestion[] {
  const q = query.toLowerCase()
  return commands
    .map((c) => ({ c, at: c.name.toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map(({ c }) => ({
      key: c.name,
      label: c.name,
      detail: c.description,
      tag: c.source && c.source !== "command" ? c.source : undefined,
      icon: "command" as const,
    }))
}

export function fileSuggestions(paths: string[]): Suggestion[] {
  return paths.map((raw) => {
    const path = raw.replace(/\\/g, "/")
    const folder = path.endsWith("/")
    const trimmed = folder ? path.slice(0, -1) : path
    const cut = trimmed.lastIndexOf("/")
    return {
      key: path,
      label: trimmed.slice(cut + 1) + (folder ? "/" : ""),
      detail: cut >= 0 ? trimmed.slice(0, cut + 1) : undefined,
      icon: folder ? ("folder" as const) : ("file" as const),
    }
  })
}

function emptyText(kind: Trigger["kind"], query: string, loading?: boolean) {
  if (loading) return "Searching…"
  if (kind === "command") return "No matching commands."
  return query ? "No matching files." : "Type to search the project."
}

function Highlight(props: { text: string; query: string }) {
  const at = () => (props.query ? props.text.toLowerCase().indexOf(props.query.toLowerCase()) : -1)
  return (
    <Show when={at() >= 0} fallback={props.text}>
      {props.text.slice(0, at())}
      <b>{props.text.slice(at(), at() + props.query.length)}</b>
      {props.text.slice(at() + props.query.length)}
    </Show>
  )
}

const SUGGEST_ICON = { file: IconFile, folder: IconFolder, command: IconSlash }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The sheet that floats above the inkwell for `@` files and `/` commands. */
export function Suggest(props: {
  kind: Trigger["kind"]
  query: string
  items: Suggestion[]
  active: number
  loading?: boolean
  onPick: (index: number) => void
  onHover: (index: number) => void
}) {
  let list!: HTMLUListElement
  createEffect(() => list.children[props.active]?.scrollIntoView({ block: "nearest" }))
  return (
    <div class="suggest rise" data-kind={props.kind}>
      <ul ref={list} id={SUGGEST_ID} role="listbox" aria-label={props.kind === "file" ? "Files" : "Commands"}>
        <For each={props.items} fallback={<li class="suggest-empty">{emptyText(props.kind, props.query, props.loading)}</li>}>
          {(item, i) => (
            <li
              id={optionID(i())}
              role="option"
              data-kind={item.icon}
              aria-selected={i() === props.active}
              classList={{ on: i() === props.active }}
              onMouseEnter={() => props.onHover(i())}
              onMouseDown={(e) => {
                e.preventDefault()
                props.onPick(i())
              }}
            >
              <span class="suggest-icon" aria-hidden="true">
                <Dynamic component={SUGGEST_ICON[item.icon]} />
              </span>
              <span class="suggest-label">
                <Highlight text={item.label} query={props.query} />
              </span>
              <Show when={item.tag}>
                <span class="suggest-tag">{item.tag}</span>
              </Show>
              <Show when={item.detail}>
                <span class="suggest-detail">{item.detail}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <footer class="suggest-foot">
        <span class="suggest-count num" aria-live="polite">
          <Show when={props.loading} fallback={plural(props.items.length, props.kind)}>
            <span class="spinner" aria-hidden="true" />
            Searching
          </Show>
        </span>
        <span class="spacer" />
        <span class="suggest-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> choose
        </span>
        <span class="suggest-keys">
          <kbd>Enter</kbd> insert
        </span>
        <span class="suggest-keys">
          <kbd>Esc</kbd> close
        </span>
      </footer>
    </div>
  )
}

/** Paints `@path` tokens as inline chips behind the transparent textarea. */
export function MentionMirror(props: { text: string; mentions: Mention[]; ref?: (el: HTMLDivElement) => void }) {
  const segments = () => {
    const out: { text: string; mention?: boolean }[] = []
    let at = 0
    for (const m of props.mentions) {
      if (m.start === undefined || m.end === undefined || m.start < at) continue
      out.push({ text: props.text.slice(at, m.start) })
      out.push({ text: props.text.slice(m.start, m.end), mention: true })
      at = m.end
    }
    out.push({ text: `${props.text.slice(at)}​` })
    return out
  }
  return (
    <div class="fell-mirror" ref={props.ref} aria-hidden="true">
      <For each={segments()}>{(s) => (s.mention ? <mark class="fell-mention">{s.text}</mark> : s.text)}</For>
    </div>
  )
}
