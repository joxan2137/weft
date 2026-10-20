import type { Session } from "@opencode-ai/sdk/v2/types"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Marble } from "../art/Marble"
import { useWeft } from "../engine/context"
import type { LoomView, SessionView } from "../engine/view"
import { confirmShare, MenuItem, Popover } from "./dialogs"
import { setThemePreference, theme } from "../theme/theme"
import { IconChevron, IconFolder, IconGear, IconMoon, IconMore, IconPlus, IconSearch, IconSun } from "./icons"
import { tildify } from "./Titlebar"

export type SessionAction = "rename" | "fork" | "share" | "export" | "archive" | "delete"

function since(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })
}

/** The engine's address for the footer: just the port when it runs on this machine. */
function shortAddress(url: string) {
  const host = url.replace(/^https?:\/\//, "")
  const port = host.match(/^(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/)?.[1]
  return port ? `port ${port}` : host
}

/** Left-to-right marks keep a path's slashes in place inside the right-to-left box that trims its start. */
const ltr = (text: string) => `\u200e${text}\u200e`

function group(ms: number) {
  const day = 86_400_000
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (ms >= start.getTime()) return "Today"
  if (ms >= start.getTime() - day) return "Yesterday"
  if (ms >= start.getTime() - 6 * day) return "This week"
  return "Earlier"
}

/** The sessions pane still renders from props alone (the mock harness) when no engine is provided. */
function useWeftIfProvided() {
  try {
    return useWeft()
  } catch {
    return undefined
  }
}

/** An archived session's row: a plain print (its messages are not loaded), over the live session so its menu stays current. */
function archivedView(session: () => Session): SessionView {
  return {
    get session() {
      return session()
    },
    draft: { warp: "linen", picks: [] },
  }
}

function EntryMenu(props: {
  view: SessionView
  anchor: HTMLElement
  onAction: (view: SessionView, action: SessionAction) => void
  onClose: () => void
}) {
  const run = (action: SessionAction) => async () => {
    props.onClose()
    if (action === "share" && !props.view.session.share && !(await confirmShare())) return
    props.onAction(props.view, action)
  }
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement="bottom-end" label="Session actions" class="session-menu">
      <MenuItem onSelect={run("rename")}>
        <span>Rename</span>
      </MenuItem>
      <MenuItem onSelect={run("fork")}>
        <span>Fork</span>
      </MenuItem>
      <MenuItem onSelect={run("share")}>
        <span>{props.view.session.share ? "Stop sharing" : "Share"}</span>
      </MenuItem>
      <MenuItem onSelect={run("export")}>
        <span>Export as JSON</span>
      </MenuItem>
      <MenuItem onSelect={run("archive")}>
        <span>{props.view.session.time.archived ? "Unarchive" : "Archive"}</span>
      </MenuItem>
      <MenuItem danger onSelect={run("delete")}>
        <span>Delete</span>
      </MenuItem>
    </Popover>
  )
}

function Entry(props: {
  view: SessionView
  activeID?: string
  depth: number
  onOpen: (id: string) => void
  onAction?: (view: SessionView, action: SessionAction) => void
}) {
  const [menu, setMenu] = createSignal<HTMLElement>()
  let more: HTMLButtonElement | undefined
  return (
    <>
      <div class="swatch-row" classList={{ menu: !!menu() }}>
        <button
          class="swatch-entry"
          classList={{ active: props.view.session.id === props.activeID, child: props.depth > 0 }}
          onClick={() => props.onOpen(props.view.session.id)}
          onContextMenu={(event) => {
            if (!props.onAction) return
            event.preventDefault()
            setMenu(more ?? event.currentTarget)
          }}
          title={props.view.session.title}
        >
          <Marble draft={props.view.draft} seed={props.view.session.id} size={props.depth > 0 ? 26 : 34} />
          <span class="entry-text">
            <span class="entry-title">{props.view.session.title}</span>
            <span class="entry-meta">
              {since(props.view.session.time.updated)}
              <Show when={props.view.picks !== undefined}> · {props.view.picks} messages</Show>
            </span>
          </span>
        </button>
        <Show when={props.onAction}>
          <button
            ref={more}
            class="entry-more"
            title="Session actions"
            aria-haspopup="menu"
            aria-expanded={!!menu()}
            onClick={() => setMenu(menu() ? undefined : more)}
          >
            <IconMore size={15} />
          </button>
        </Show>
      </div>
      <Show when={menu() && props.onAction}>
        <EntryMenu view={props.view} anchor={menu()!} onAction={props.onAction!} onClose={() => setMenu(undefined)} />
      </Show>
      <For each={props.view.children ?? []}>
        {(child) => <Entry view={child} activeID={props.activeID} depth={props.depth + 1} onOpen={props.onOpen} onAction={props.onAction} />}
      </For>
    </>
  )
}

/** The sessions pane: every session as its marbled print, the inks of its own messages floated and combed. */
export function SwatchBook(props: {
  loom: Pick<LoomView, "directory" | "branch" | "sessions" | "activeID" | "engine">
  onOpen: (id: string) => void
  onNew: () => void
  onProject: () => void
  onSettings?: () => void
  onAction?: (view: SessionView, action: SessionAction) => void
}) {
  const weft = useWeftIfProvided()
  const [query, setQuery] = createSignal("")
  const [showArchived, setShowArchived] = createSignal(false)
  const groups = createMemo(() => {
    const q = query().trim().toLowerCase()
    const out = new Map<string, SessionView[]>()
    for (const v of props.loom.sessions) {
      if (q && !v.session.title.toLowerCase().includes(q)) continue
      const g = group(v.session.time.updated)
      out.set(g, [...(out.get(g) ?? []), v])
    }
    return out
  })
  // Sections are keyed by name and rows by their cached view, so a refetch or a streamed update re-creates no rows.
  const names = () => [...groups().keys()]
  const archived = createMemo(() => {
    const q = query().trim().toLowerCase()
    const all = weft?.state.archived?.[props.loom.directory] ?? []
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all
  })
  const archivedViews = new Map<string, SessionView>()
  const viewOfArchived = (id: string) => {
    let view = archivedViews.get(id)
    if (!view) {
      let last = archived().find((s) => s.id === id)!
      view = archivedView(() => (last = weft?.state.info[id] ?? last))
      archivedViews.set(id, view)
    }
    return view
  }
  const project = () => props.loom.directory.split(/[\\/]/).filter(Boolean).pop() ?? props.loom.directory

  return (
    <nav class="book">
      <button class="project" onClick={props.onProject} title={`${props.loom.directory}: open another project`}>
        <IconFolder size={16} />
        <span class="project-text">
          <span class="project-name">
            {project()}
            <Show when={props.loom.branch}>
              <span class="project-branch">{props.loom.branch}</span>
            </Show>
          </span>
          <span class="project-path">{ltr(tildify(props.loom.directory))}</span>
        </span>
      </button>
      <button class="new-session" onClick={props.onNew}>
        <IconPlus size={16} />
        <span>New session</span>
        <kbd>Ctrl N</kbd>
      </button>
      <label class="search">
        <IconSearch size={15} />
        <input placeholder="Search sessions" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <div class="book-list">
        <For each={names()}>
          {(name) => (
            <section class="book-group">
              <h3 class="label">{name}</h3>
              <For each={groups().get(name) ?? []}>
                {(v) => <Entry view={v} activeID={props.loom.activeID} depth={0} onOpen={props.onOpen} onAction={props.onAction} />}
              </For>
            </section>
          )}
        </For>
        <Show when={!names().length}>
          <p class="book-empty">
            {query().trim()
              ? `No session matches “${query().trim()}”.`
              : props.loom.directory
                ? "No sessions yet. Write below to start one."
                : "Open a project to see its sessions."}
          </p>
        </Show>
        <Show when={archived().length}>
          <section class="book-group archived-group">
            <button class="archived-toggle label" aria-expanded={showArchived()} onClick={() => setShowArchived(!showArchived())}>
              <IconChevron dir={showArchived() ? "down" : "right"} size={13} />
              Archived
              <span class="num">{archived().length}</span>
            </button>
            <Show when={showArchived()}>
              <For each={archived().map((s) => s.id)}>
                {(id) => <Entry view={viewOfArchived(id)} activeID={props.loom.activeID} depth={0} onOpen={props.onOpen} onAction={props.onAction} />}
              </For>
            </Show>
          </section>
        </Show>
      </div>
      <footer class="book-foot">
        <span class={`dot ${props.loom.engine.state}`} />
        <span class="foot-engine" title={props.loom.engine.url}>
          opencode {props.loom.engine.version} <span class="dim">· {shortAddress(props.loom.engine.url)}</span>
        </span>
        <button
          class="foot-gear"
          title={theme() === "dark" ? "Day: ink on paper" : "Night: light in dark water"}
          onClick={() => setThemePreference(theme() === "dark" ? "light" : "dark")}
        >
          <Show when={theme() === "dark"} fallback={<IconMoon size={16} />}>
            <IconSun size={16} />
          </Show>
        </button>
        <Show when={props.onSettings}>
          <button class="foot-gear" title="Settings (Ctrl ,)" onClick={() => props.onSettings?.()}>
            <IconGear size={16} />
          </button>
        </Show>
      </footer>
    </nav>
  )
}
