import { createMemo, createSignal, For, Show } from "solid-js"
import { useWeft } from "../../engine/context"
import { IconFolder, IconPlus } from "../icons"
import { basename, best, fuzzy, openable, since } from "./catalog"
import { Dialog, useDialog } from "./Dialog"
import { createCursor, KeyHints, Marked, Query } from "./list"
import { toastError } from "./Toast"

type ProjectProps = { onClose: () => void; onOpen?: (directory: string) => void }

/** Known projects, most recent first, plus "Open folder…"; the open one is marked. */
export function ProjectPicker(props: ProjectProps) {
  return (
    <Dialog onClose={props.onClose} name="Open a project" tint="ochre" width={680} align="top" class="projects">
      <ProjectPickerBody {...props} />
    </Dialog>
  )
}

function ProjectPickerBody(props: ProjectProps) {
  const { state, actions } = useWeft()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const all = createMemo(() => openable(state.projects))
  const items = createMemo(() => {
    const q = query().trim()
    return all()
      .map((p) => {
        const name = p.name ?? basename(p.worktree)
        const named = fuzzy(q, name)
        return { project: p, name, hits: named?.hits, score: best(named, fuzzy(q, p.worktree))?.score }
      })
      .filter((x) => x.score !== undefined)
      .sort((a, b) => (q ? b.score! - a.score! : (b.project.time.updated ?? 0) - (a.project.time.updated ?? 0)))
  })
  const sessions = (directory: string) => state.sessions[directory]?.length ?? 0
  const nav = createCursor(() => items().length + 1, query)

  async function open(directory: string) {
    dialog.close()
    try {
      if (props.onOpen) props.onOpen(directory)
      else await actions.openProject(directory)
    } catch (error) {
      toastError(error)
    }
  }

  async function browse() {
    try {
      const directory = await actions.pickProjectFolder()
      if (directory) await open(directory)
    } catch (error) {
      toastError(error)
    }
  }

  const choose = (index: number) => (index < items().length ? open(items()[index].project.worktree) : browse())

  return (
    <>
      <Query
        label="Search projects"
        placeholder="Search projects"
        value={query()}
        onInput={setQuery}
        onKeyDown={(e) => nav.onKey(e, choose)}
        count={`${items().length} of ${all().length}`}
      />
      <div class="dlg-list project-list" ref={nav.bind} role="listbox" aria-label="Projects">
        <For each={items()}>
          {(item, i) => (
            <button
              class="dlg-row project-row"
              data-index={i()}
              role="option"
              aria-selected={nav.cursor() === i()}
              classList={{ on: nav.cursor() === i(), current: item.project.worktree === state.directory }}
              onMouseMove={() => nav.setCursor(i())}
              onClick={() => choose(i())}
            >
              <span class="row-icon">
                <IconFolder size={16} />
              </span>
              <span class="row-text">
                <span class="row-title">
                  <Marked text={item.name} hits={item.hits} />
                </span>
                <span class="row-sub path">{item.project.worktree}</span>
              </span>
              <span class="row-tags">
                <Show when={item.project.worktree === state.directory}>
                  <span class="tag current-tag">Open now</span>
                </Show>
                <Show when={item.project.vcs}>
                  <span class="tag">{item.project.vcs}</span>
                </Show>
                <span class="num row-hint">
                  {sessions(item.project.worktree)} {sessions(item.project.worktree) === 1 ? "session" : "sessions"} ·{" "}
                  {since(item.project.time.updated)}
                </span>
              </span>
            </button>
          )}
        </For>
        <Show when={!items().length && query().trim()}>
          <p class="dlg-empty">No project matches “{query().trim()}”</p>
        </Show>
      </div>
      <footer class="dialog-foot">
        <button
          class="btn"
          data-index={items().length}
          classList={{ focus: nav.cursor() === items().length }}
          onClick={browse}
          onMouseMove={() => nav.setCursor(items().length)}
        >
          <IconPlus size={14} /> Open folder…
        </button>
        <span class="spacer" />
        <KeyHints
          keys={[
            ["↑↓", "Move"],
            ["↵", "Open"],
            ["Esc", "Close"],
          ]}
        />
      </footer>
    </>
  )
}
