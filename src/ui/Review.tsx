import type { SnapshotFileDiff, UserMessage, VcsFileDiff } from "@opencode-ai/sdk/v2/types"
import { formatPatch, structuredPatch } from "diff"
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { useWeft } from "../engine/context"
import { IconChevron, IconClose, IconCopy, IconFolder, IconOpen, IconRefresh } from "./icons"
import { DiffView } from "./parts/Brocade"
import { copyText, inTauri } from "./platform"
import "./workbench.css"

type Mode = "git" | "branch" | "session" | "turn"

type Status = "added" | "modified" | "deleted"

type Changed = { path: string; patch: string; additions: number; deletions: number; status: Status }

type AnyDiff = { file?: string; path?: string; patch?: string; additions: number; deletions: number; status?: Status }

const MODES: { mode: Mode; label: string; title: string }[] = [
  { mode: "git", label: "Uncommitted", title: "Uncommitted changes in the working tree" },
  { mode: "branch", label: "Branch", title: "Changes against the default branch" },
  { mode: "session", label: "Session", title: "Everything this session changed" },
  { mode: "turn", label: "Last turn", title: "What the last turn changed" },
]

const COMPARED: Record<Mode, string> = {
  git: "Against the last commit",
  branch: "Against the default branch",
  session: "Since this session began",
  turn: "From the last turn",
}

const EMPTY: Record<Mode, string> = {
  git: "No uncommitted changes.",
  branch: "No changes against the default branch.",
  session: "This session has not changed any files.",
  turn: "The last turn did not change any files.",
}

const STATUS_WORD: Record<Status, string> = { added: "Added", modified: "Edited", deleted: "Deleted" }

/** Extensions Windows runs rather than shows when a file is opened with its default app. */
const LAUNCHES =
  /\.(exe|com|bat|cmd|msi|msp|msc|scr|pif|cpl|hta|lnk|url|reg|inf|scf|sct|shb|shs|jar|chm|js|jse|vbs|vbe|vb|wsf|wsh|ws|ps1|psm1|psd1|ps1xml|psc1|application|appref-ms|appx|appxbundle|msix|msixbundle|appinstaller|gadget|diagcab|settingcontent-ms|library-ms|search-ms)$/i

const isAbsolute = (path: string) => /^([a-zA-Z]:[\\/]|[\\/])/.test(path)

function relativeTo(path: string, root: string | undefined) {
  const slashed = path.replace(/\\/g, "/")
  const base = root?.replace(/\\/g, "/").replace(/\/$/, "")
  if (base && slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return slashed.slice(base.length + 1)
  return slashed
}

function normalize(diff: AnyDiff, root: string | undefined): Changed {
  const path = relativeTo(diff.path ?? diff.file ?? "", root)
  const status = diff.status ?? (diff.deletions && !diff.additions ? "deleted" : "modified")
  return { path, patch: diff.patch ?? "", additions: diff.additions, deletions: diff.deletions, status }
}

/** Re-cut a patch to `context` lines around each change, so full-file snapshot patches read like `git diff`. */
export function focusPatch(patch: string, context = 3) {
  const head: string[] = []
  const hunks: { old: number; new: number; rows: string[] }[] = []
  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n")
  for (const line of lines) {
    const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (start) hunks.push({ old: Number(start[1]), new: Number(start[2]), rows: [] })
    else if (!hunks.length) head.push(line)
    else if (!line.startsWith("\\")) hunks[hunks.length - 1].rows.push(line.startsWith("+") || line.startsWith("-") ? line : ` ${line.slice(1)}`)
  }
  const out = [...head]
  for (const hunk of hunks) {
    const changed = hunk.rows.map((r) => r[0] !== " ")
    const keep = hunk.rows.map((_, i) => changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean))
    let oldNo = hunk.old
    let newNo = hunk.new
    let run: { old: number; new: number; rows: string[] } | undefined
    const flush = () => {
      if (!run) return
      const olds = run.rows.filter((r) => r[0] !== "+").length
      const news = run.rows.filter((r) => r[0] !== "-").length
      out.push(`@@ -${run.old},${olds} +${run.new},${news} @@`, ...run.rows)
      run = undefined
    }
    hunk.rows.forEach((row, i) => {
      if (keep[i]) {
        run ??= { old: oldNo, new: newNo, rows: [] }
        run.rows.push(row)
      } else flush()
      if (row[0] !== "+") oldNo++
      if (row[0] !== "-") newNo++
    })
    flush()
  }
  return out.join("\n")
}

/** The file text on both sides of a full-context snapshot patch (one hunk), or undefined. */
function sidesOf(patch: string | undefined) {
  if (!patch) return undefined
  const before: string[] = []
  const after: string[] = []
  const newline = { before: true, after: true }
  let hunks = 0
  let mark = " "
  for (const line of (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n")) {
    if (line.startsWith("@@")) hunks++
    else if (!hunks) continue
    else if (line.startsWith("\\")) {
      if (mark !== "+") newline.before = false
      if (mark !== "-") newline.after = false
    } else {
      mark = line[0] ?? " "
      if (mark !== "+") before.push(line.slice(1))
      if (mark !== "-") after.push(line.slice(1))
    }
  }
  if (hunks > 1) return undefined
  const text = (lines: string[], eol: boolean) => (lines.length ? lines.join("\n") + (eol ? "\n" : "") : "")
  return { before: text(before, newline.before), after: text(after, newline.after) }
}

/** What a file looks like now against before its first change in the session, as one patch. */
function netPatch(file: string, first: string | undefined, last: string | undefined) {
  const from = sidesOf(first)
  const to = sidesOf(last)
  if (!from || !to) return undefined
  const net = structuredPatch(file, file, from.before, to.after, "", "", { context: 3, timeout: 250 })
  if (!net) return undefined
  const rows = net.hunks.flatMap((h) => h.lines)
  return {
    patch: net.hunks.length ? formatPatch(net) : "",
    additions: rows.filter((r) => r[0] === "+").length,
    deletions: rows.filter((r) => r[0] === "-").length,
  }
}

/** Folds every turn's snapshot diffs into one net change per file. */
function sessionChanges(turns: SnapshotFileDiff[][]): AnyDiff[] {
  const byFile = new Map<string, SnapshotFileDiff[]>()
  for (const diffs of turns) for (const d of diffs) if (d.file) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d])
  return [...byFile.entries()].flatMap(([file, steps]): AnyDiff[] => {
    const first = steps[0]
    const last = steps[steps.length - 1]
    if (steps.length === 1) return [first]
    const status: Status = first.status === "added" ? "added" : last.status === "deleted" ? "deleted" : "modified"
    const net = netPatch(file, first.patch, last.patch)
    if (net) return net.additions || net.deletions ? [{ file, status, ...net }] : []
    const sum = (key: "additions" | "deletions") => steps.reduce((n, s) => n + s[key], 0)
    return [{ file, status, patch: last.patch, additions: sum("additions"), deletions: sum("deletions") }]
  })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Added and removed lines, with a small meter scaled so the most changed file fills it. */
function Stat(props: { additions: number; deletions: number; widest: number }) {
  const share = (n: number) => `${(n / Math.max(1, props.widest)) * 100}%`
  return (
    <span class="review-stat num" aria-label={`${props.additions} added, ${props.deletions} removed`}>
      <Show when={props.additions}>
        <span class="add">+{props.additions}</span>
      </Show>
      <Show when={props.deletions}>
        <span class="del">−{props.deletions}</span>
      </Show>
      <Show when={props.additions + props.deletions > 0}>
        <span class="review-meter" aria-hidden="true">
          <span class="add" style={{ width: share(props.additions) }} />
          <span class="del" style={{ width: share(props.deletions) }} />
        </span>
      </Show>
    </span>
  )
}

function FileRow(props: { file: Changed; widest: number; open: boolean; onToggle: () => void; onOpen: () => void }) {
  const cut = () => props.file.path.lastIndexOf("/") + 1
  const patch = createMemo(() => (props.open && props.file.patch ? focusPatch(props.file.patch) : ""))
  const openTitle = () => (!inTauri ? "Copy path" : LAUNCHES.test(props.file.path) ? "Show in folder" : "Open")
  return (
    <article class="review-file" classList={{ open: props.open }} data-status={props.file.status}>
      <header
        class="review-file-head"
        role="button"
        tabindex="0"
        aria-expanded={props.open}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
          e.preventDefault()
          props.onToggle()
        }}
        title={props.file.path}
      >
        <span class="review-fold" aria-hidden="true">
          <IconChevron dir={props.open ? "down" : "right"} />
        </span>
        <span class="review-status" role="img" aria-label={STATUS_WORD[props.file.status]} title={STATUS_WORD[props.file.status]} />
        <span class="review-path">
          <span class="review-name">{props.file.path.slice(cut())}</span>
          <span class="review-dir">{props.file.path.slice(0, cut())}</span>
        </span>
        <Stat additions={props.file.additions} deletions={props.file.deletions} widest={props.widest} />
        <button
          class="icon-btn review-open"
          title={openTitle()}
          aria-label={`${openTitle()}: ${props.file.path}`}
          disabled={props.file.status === "deleted"}
          onClick={(e) => {
            e.stopPropagation()
            props.onOpen()
          }}
        >
          {!inTauri ? <IconCopy /> : LAUNCHES.test(props.file.path) ? <IconFolder /> : <IconOpen />}
        </button>
      </header>
      <Show when={props.open}>
        <Show when={patch()} fallback={<p class="review-note">No text diff for this file.</p>}>
          <DiffView diff={patch()} max={160} />
        </Show>
      </Show>
    </article>
  )
}

/** A sheet over the conversation: what the work has changed, file by file. */
export function Review(props: { sessionID?: string; onClose: () => void }) {
  const { state, http } = useWeft()
  const [mode, setMode] = createSignal<Mode>("git")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [notice, setNotice] = createSignal<string>()

  const root = createMemo(() => {
    const dir = state.directory
    if (!dir) return undefined
    const lower = dir.replace(/\\/g, "/").toLowerCase()
    const project = state.projects
      .filter((p) => lower.startsWith(p.worktree.replace(/\\/g, "/").toLowerCase()))
      .sort((a, b) => b.worktree.length - a.worktree.length)[0]
    return project && project.worktree !== "/" ? project.worktree : dir
  })

  const fromVcs = () => mode() === "git" || mode() === "branch"
  const [vcs, { refetch }] = createResource(
    () => {
      const m = mode()
      return (m === "git" || m === "branch") && state.directory ? { mode: m, directory: state.directory } : undefined
    },
    async (q) => ({
      mode: q.mode,
      files: (await http.get<VcsFileDiff[]>("/vcs/diff", { directory: q.directory, query: { mode: q.mode, context: 3 } })).data,
    }),
  )
  const vcsFiles = () => {
    if (vcs.error) return undefined
    const latest = vcs.latest
    return latest?.mode === mode() ? latest.files : undefined
  }

  /** User messages of the turns still in effect: a pending revert hides its turn and every later one. */
  const userMessages = () => {
    const id = props.sessionID
    const messages = (id && state.content[id]?.messages) || []
    const revertedAt = id ? messages.findIndex((m) => m.id === state.info[id]?.revert?.messageID) : -1
    return (revertedAt < 0 ? messages : messages.slice(0, revertedAt)).filter((m): m is UserMessage => m.role === "user")
  }

  const sessionFiles = createMemo(() => (mode() === "session" ? sessionChanges(userMessages().map((m) => m.summary?.diffs ?? [])) : []))
  const turnDiffs = (): AnyDiff[] => userMessages().at(-1)?.summary?.diffs ?? []
  const working = () => !!props.sessionID && (state.status[props.sessionID]?.type ?? "idle") !== "idle"

  const files = createMemo<Changed[]>(() => {
    const source = mode() === "session" ? sessionFiles() : mode() === "turn" ? turnDiffs() : (vcsFiles() ?? [])
    return source
      .map((d) => normalize(d, root()))
      .filter((f) => f.path)
      .sort((a, b) => a.path.localeCompare(b.path))
  })

  const totals = createMemo(() =>
    files().reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 }),
  )
  const widest = createMemo(() => Math.max(1, ...files().map((f) => f.additions + f.deletions)))
  const against = () => (mode() === "branch" ? `Against ${state.vcs?.default_branch ?? "main"}` : COMPARED[mode()])
  const allOpen = () => files().length > 0 && files().every((f) => expanded().has(f.path))
  const loading = () => fromVcs() && vcs.loading && !vcsFiles()

  const fileSet = createMemo(() => files().map((f) => f.path).join("\n"))
  createEffect(on(fileSet, () => setExpanded(new Set(files().length <= 6 ? files().map((f) => f.path) : []))))
  createEffect(on(() => (props.sessionID ? state.diffs[props.sessionID] : undefined), () => void refetch(), { defer: true }))

  function toggle(path: string) {
    const next = new Set(expanded())
    if (!next.delete(path)) next.add(path)
    setExpanded(next)
  }

  async function openFile(path: string) {
    const base = root()
    const absolute = isAbsolute(path) || !base ? path : `${base}${base.includes("\\") ? "\\" : "/"}${base.includes("\\") ? path.replace(/\//g, "\\") : path}`
    try {
      if (!inTauri) {
        await copyText(absolute)
        setNotice(`Copied ${absolute}`)
        return
      }
      if (!base || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return setNotice(`${path} is outside the project.`)
      const opener = await import("@tauri-apps/plugin-opener")
      await (LAUNCHES.test(path) ? opener.revealItemInDir(absolute) : opener.openPath(absolute))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  let drawer!: HTMLElement
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const onFocus = () => void refetch()
  const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose()
  onMount(() => {
    window.addEventListener("focus", onFocus)
    drawer.focus({ preventScroll: true })
  })
  onCleanup(() => {
    window.removeEventListener("focus", onFocus)
    if (drawer.contains(document.activeElement)) returnFocus?.focus({ preventScroll: true })
  })

  return (
    <>
      <div class="review-scrim" aria-hidden="true" onClick={props.onClose} />
      <aside ref={drawer} class="review rise" tabindex="-1" aria-label="Review changes" onKeyDown={onKey}>
        <header class="review-head">
          <div class="review-heading">
            <h2 class="review-title">Changes</h2>
            <p class="review-sub">
              <Show when={files().length}>
                <span class="num">{plural(files().length, "file")}</span>
                <span class="add num">+{totals().additions}</span>
                <span class="del num">−{totals().deletions}</span>
                <span class="review-sep" aria-hidden="true" />
              </Show>
              <span>{against()}</span>
            </p>
          </div>
          <span class="spacer" />
          <button class="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => void refetch()} disabled={!fromVcs()}>
            <IconRefresh />
          </button>
          <button class="icon-btn" title="Close (Esc)" aria-label="Close" onClick={props.onClose}>
            <IconClose size={14} />
          </button>
        </header>
        <div class="review-bar">
          <div class="seg review-modes" role="radiogroup" aria-label="Compare">
            <For each={MODES}>
              {(m) => (
                <button
                  role="radio"
                  aria-checked={mode() === m.mode}
                  classList={{ on: mode() === m.mode }}
                  disabled={(m.mode === "session" || m.mode === "turn") && !props.sessionID}
                  title={m.title}
                  onClick={() => setMode(m.mode)}
                >
                  {m.label}
                </button>
              )}
            </For>
          </div>
          <span class="spacer" />
          <Show when={files().length}>
            <button class="btn ghost" onClick={() => setExpanded(new Set(allOpen() ? [] : files().map((f) => f.path)))}>
              {allOpen() ? "Collapse all" : "Expand all"}
            </button>
          </Show>
        </div>
        <Show when={notice()}>
          <p class="review-notice" title="Dismiss" onClick={() => setNotice(undefined)}>
            <span class="review-notice-text">{notice()}</span>
            <IconClose size={12} />
          </p>
        </Show>
        <div class="review-body">
          <Switch>
            <Match when={loading()}>
              <p class="review-empty">
                <span class="spinner" aria-hidden="true" /> Reading changes…
              </p>
            </Match>
            <Match when={fromVcs() && vcs.error}>
              <p class="review-empty bad">{vcs.error instanceof Error ? vcs.error.message : "Could not read changes."}</p>
            </Match>
            <Match when={!files().length}>
              <p class="review-empty">{!state.directory ? "Open a project to review its changes." : mode() === "turn" && working() ? "This turn has not changed any files yet." : EMPTY[mode()]}</p>
            </Match>
            <Match when={true}>
              <For each={files()}>
                {(file) => (
                  <FileRow
                    file={file}
                    widest={widest()}
                    open={expanded().has(file.path)}
                    onToggle={() => toggle(file.path)}
                    onOpen={() => void openFile(file.path)}
                  />
                )}
              </For>
            </Match>
          </Switch>
        </div>
      </aside>
    </>
  )
}
