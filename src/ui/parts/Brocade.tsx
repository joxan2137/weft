import type { ToolPart } from "@opencode-ai/sdk/v2/types"
import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { readRun, settled } from "../../engine/workflow"
import { IconCheck, IconChevron, IconCross, IconFile, IconFork, IconSearch, IconTerminal, IconTool } from "../icons"
import { WorkflowView } from "./Workflow"

type Todo = { content: string; status: string; priority?: string }

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v))

export function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function relative(path: string, root?: string) {
  const same = (p: string) => p.replace(/\\/g, "/").toLowerCase()
  if (root && same(path).startsWith(same(root))) return path.slice(root.length).replace(/^[\\/]/, "")
  return path
}

type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number }

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let o = 0
  let n = 0
  for (const line of diff.split("\n")) {
    if (/^(Index:|===|--- |\+\+\+ |diff --git|new file|deleted file|index )/.test(line)) continue
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
    if (hunk) {
      o = Number(hunk[1])
      n = Number(hunk[2])
      out.push({ kind: "hunk", text: line })
      continue
    }
    if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), new: n++ })
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: o++ })
    else if (line.startsWith(" ") || line === "") {
      if (out.length === 0 && line === "") continue
      out.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ })
    } else if (!line.startsWith("\\")) out.push({ kind: "ctx", text: line })
  }
  while (out.length && out[out.length - 1].kind === "ctx" && out[out.length - 1].text === "") out.pop()
  return out
}

export function DiffView(props: { diff: string; max?: number }) {
  const lines = createMemo(() => parseUnifiedDiff(props.diff))
  const [all, setAll] = createSignal(false)
  const shown = () => (all() ? lines() : lines().slice(0, props.max ?? 40))
  return (
    <div class="diff selectable">
      <For each={shown()}>
        {(l) => (
          <div class={`diff-line ${l.kind}`}>
            <span class="diff-no num">{l.kind === "hunk" ? "" : (l.new ?? l.old ?? "")}</span>
            <span class="diff-mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "hunk" ? "@" : " "}</span>
            <span class="diff-text">{l.kind === "hunk" ? l.text.replace(/^@@.*@@/, "").trim() || "⋯" : l.text}</span>
          </div>
        )}
      </For>
      <Show when={!all() && lines().length > (props.max ?? 40)}>
        <button class="more label" onClick={() => setAll(true)}>
          {lines().length - (props.max ?? 40)} more lines
        </button>
      </Show>
    </div>
  )
}

function Terminal(props: { command: string; output: string; exit?: number }) {
  const [all, setAll] = createSignal(false)
  const lines = () => props.output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
  const shown = () => (all() ? lines() : lines().slice(-14))
  return (
    <div class="term selectable">
      <div class="term-cmd">
        <span class="term-prompt" aria-hidden="true">
          <IconTerminal size={12} />
        </span>
        {props.command}
      </div>
      <Show when={!all() && lines().length > 14}>
        <button class="more label" onClick={() => setAll(true)}>
          {lines().length - 14} earlier lines
        </button>
      </Show>
      <For each={shown()}>
        {(line) => <div class="term-line" classList={{ bad: /\b(error|fail(ed)?|ENOENT|panic)\b/i.test(line) }}>{line || " "}</div>}
      </For>
    </div>
  )
}

function Todos(props: { todos: Todo[] }) {
  return (
    <ul class="todos">
      <For each={props.todos}>
        {(t) => (
          <li class={`todo ${t.status}`}>
            <span class="todo-mark" aria-hidden="true" />
            <span>{t.content}</span>
          </li>
        )}
      </For>
    </ul>
  )
}

const TOOL_LABEL: Record<string, string> = {
  bash: "Ran",
  edit: "Edited",
  write: "Wrote",
  read: "Read",
  glob: "Found files",
  grep: "Searched",
  list: "Listed",
  todowrite: "Plan",
  todoread: "Plan",
  webfetch: "Fetched",
  websearch: "Searched the web",
  codesearch: "Searched code",
  task: "Subagent",
  workflow: "Workflow",
  patch: "Patched",
  apply_patch: "Patched",
  question: "Asked",
  skill: "Skill",
  lsp: "Language server",
}

/** How long a finished call ran. */
function took(state: ToolPart["state"]) {
  const time = (state as { time?: { start?: number; end?: number } }).time
  if (!time?.start || !time.end) return ""
  const s = (time.end - time.start) / 1000
  return s < 0.1 ? "" : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
}

/** A tool call as a slip of paper in the current: what it did, its result, how long it took. */
export function Brocade(props: { part: ToolPart; root?: string; onOpenSession?: (id: string) => void }) {
  const state = () => props.part.state
  const input = () => (state().input ?? {}) as Record<string, unknown>
  const meta = () => ("metadata" in state() ? ((state() as { metadata?: Record<string, unknown> }).metadata ?? {}) : {})
  const output = () => (state().status === "completed" ? (state() as { output: string }).output : "")
  const error = () => (state().status === "error" ? (state() as { error: string }).error : "")
  const title = () => ("title" in state() ? ((state() as { title?: string }).title ?? "") : "")
  const tool = () => props.part.tool
  const run = createMemo(() => (tool() === "workflow" ? readRun(meta(), state().status) : undefined))
  const [collapsed, setCollapsed] = createSignal(false)

  const headline = createMemo((): JSX.Element => {
    const i = input()
    switch (tool()) {
      case "bash":
        return i.description ? <span>{str(i.description)}</span> : <span class="mono">{str(i.command)}</span>
      case "edit":
      case "write":
      case "read":
        return <span class="mono path">{relative(str(i.filePath), props.root)}</span>
      case "glob":
      case "grep":
        return (
          <span class="mono">
            {str(i.pattern)}
            <Show when={i.path}>
              <span class="dim"> in {relative(str(i.path), props.root)}</span>
            </Show>
          </span>
        )
      case "webfetch":
        return <span class="mono path">{str(i.url)}</span>
      case "todowrite":
        return undefined
      case "task":
        return <span>{str(i.description)}</span>
      case "workflow":
        return <span>{run()?.name ?? (str(i.name) || title() || "script")}</span>
      case "question": {
        const asked = Array.isArray(i.questions) ? (i.questions as { question?: unknown }[]) : []
        return <span>{str(asked[0]?.question) + (asked.length > 1 ? ` (+${asked.length - 1})` : "")}</span>
      }
      default:
        return <span>{title() || Object.values(i).map(str).join(" ").slice(0, 120)}</span>
    }
  })

  const stat = createMemo(() => {
    const m = meta()
    const fd = m.filediff as { additions?: number; deletions?: number } | undefined
    if (fd && (fd.additions || fd.deletions)) return `+${fd.additions ?? 0} −${fd.deletions ?? 0}`
    if (tool() === "todowrite") {
      const todos = (m.todos as Todo[] | undefined) ?? []
      return `${todos.filter((t) => t.status === "completed").length} of ${todos.length}`
    }
    const agents = run()?.agents
    if (agents?.length) return `${agents.filter(settled).length} of ${agents.length} agents`
    return ""
  })

  return (
    <section class={`brocade tool-${tool()}`} data-role="tool" data-status={state().status} classList={{ collapsed: collapsed() }}>
      <header class="brocade-head" onClick={() => setCollapsed(!collapsed())}>
        <span class="brocade-icon" aria-hidden="true">
          <Switch fallback={<IconTool size={14} />}>
            <Match when={tool() === "bash"}>
              <IconTerminal size={14} />
            </Match>
            <Match when={["edit", "write", "read", "patch", "apply_patch"].includes(tool())}>
              <IconFile size={14} />
            </Match>
            <Match when={["glob", "grep", "websearch", "codesearch", "webfetch"].includes(tool())}>
              <IconSearch size={14} />
            </Match>
            <Match when={tool() === "workflow"}>
              <IconFork size={14} />
            </Match>
          </Switch>
        </span>
        <span class="brocade-tool">{TOOL_LABEL[tool()] ?? tool()}</span>
        <span class="brocade-title">{headline()}</span>
        <span class="brocade-stat num">{stat()}</span>
        <span class="brocade-took num">{took(state())}</span>
        <span class="brocade-status" aria-label={state().status}>
          <Switch fallback={<IconCheck size={13} />}>
            <Match when={state().status === "running" || state().status === "pending"}>
              <span class="spinner" />
            </Match>
            <Match when={state().status === "error" || (tool() === "bash" && typeof meta().exit === "number" && meta().exit !== 0)}>
              <span class="bad">
                <IconCross size={13} />
              </span>
            </Match>
          </Switch>
        </span>
        <span class="brocade-fold" aria-hidden="true">
          <IconChevron dir={collapsed() ? "right" : "down"} size={13} />
        </span>
      </header>
      <Show when={!collapsed()}>
        <div class="brocade-body">
          <Switch
            fallback={
              <Show when={output() || error()}>
                <pre class="brocade-out selectable">{(error() || output()).slice(0, 4000)}</pre>
              </Show>
            }
          >
            <Match when={tool() === "bash"}>
              <Terminal command={str(input().command)} output={str(meta().output) || output() || error()} />
            </Match>
            <Match when={(tool() === "edit" || tool() === "apply_patch" || tool() === "patch") && meta().diff}>
              <DiffView diff={str(meta().diff)} />
            </Match>
            <Match when={tool() === "write"}>
              <pre class="brocade-out selectable">{str(input().content).slice(0, 3000)}</pre>
            </Match>
            <Match when={tool() === "read"}>
              <Show when={error()}>
                <pre class="brocade-out bad selectable">{error()}</pre>
              </Show>
            </Match>
            <Match when={tool() === "todowrite" || tool() === "todoread"}>
              <Todos todos={(meta().todos as Todo[] | undefined) ?? (input().todos as Todo[] | undefined) ?? []} />
            </Match>
            <Match when={tool() === "task"}>
              <div class="task-link">
                <span class="dim">{str(input().subagent_type) || "general"} agent</span>
                <Show when={meta().sessionId}>
                  <button class="link" onClick={() => props.onOpenSession?.(str(meta().sessionId))}>
                    open session
                  </button>
                </Show>
              </div>
            </Match>
            <Match when={run()}>
              {(r) => <WorkflowView run={r()} output={output()} error={error()} onOpenSession={props.onOpenSession} />}
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  )
}
