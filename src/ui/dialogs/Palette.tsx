import type { Session } from "@opencode-ai/sdk/v2/types"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useWeft } from "../../engine/context"
import {
  IconCopy,
  IconCross,
  IconDrop,
  IconFile,
  IconFolder,
  IconFork,
  IconGear,
  IconNeedle,
  IconOpen,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconScissors,
  IconSettle,
  IconSlash,
  IconTurn,
  IconWaves,
} from "../icons"
import { basename, fuzzy, openable, rememberModel, since, sortProviders, usableModels, type Match } from "./catalog"
import { ask, openDialog } from "./controller"
import { Dialog, useDialog } from "./Dialog"
import { createCursor, KeyHints, Marked, Query } from "./list"
import { reducedMotionPreference, setReducedMotion } from "./motion"
import { saveSessionFile, toggleShare } from "./sessionActions"
import { toast, toastError } from "./Toast"

type Group = "actions" | "sessions" | "commands" | "models" | "projects"

type Item = {
  group: Group
  key: string
  title: string
  sub?: string
  hint?: string
  terms?: string
  core?: boolean
  run: () => void | Promise<unknown>
}

type Found = Item & { index: number; hits?: number[] }

const ORDER: Group[] = ["actions", "sessions", "commands", "models", "projects"]
const PER_GROUP = 6

const GROUP_NAMES: Record<Group, string> = {
  actions: "Actions",
  sessions: "Sessions",
  commands: "Commands",
  models: "Models",
  projects: "Projects",
}

type Icon = typeof IconPlus

const SOURCE_NAMES: Record<string, string> = { mcp: "MCP", skill: "Skill" }

/** Sessions have no icon: they show a small marble instead. */
const GROUP_ICONS: Partial<Record<Group, Icon>> = {
  actions: IconPlus,
  commands: IconSlash,
  models: IconDrop,
  projects: IconFolder,
}

const ACTION_ICONS: Record<string, Icon> = {
  new: IconPlus,
  model: IconDrop,
  connect: IconPlug,
  projects: IconTurn,
  folder: IconFolder,
  rename: IconNeedle,
  fork: IconFork,
  compact: IconScissors,
  share: IconOpen,
  archive: IconSettle,
  export: IconCopy,
  delete: IconCross,
  settings: IconGear,
  restart: IconRefresh,
  motion: IconWaves,
  about: IconFile,
}

const iconOf = (item: Item) => (item.group === "actions" && ACTION_ICONS[item.key]) || GROUP_ICONS[item.group]

/** A session's small marble: the same inks for every session, turned by its id so neighbours differ. */
const turn = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)

export type PaletteProps = {
  sessionID?: string
  onClose: () => void
  /** Called with a session to show; defaults to actions.openSession. */
  onSession?: (id: string) => void
  /** Called with a slash command picked from the list; defaults to running it with no arguments. */
  onCommand?: (name: string) => void
  /** Starts a new session the way the app does (with the model and agent chosen before it); defaults to createSession. */
  onNewSession?: () => void
}

/** Ctrl+K: one search over actions, sessions in every project, slash commands, models and projects. */
export function Palette(props: PaletteProps) {
  return (
    <Dialog onClose={props.onClose} name="Command palette" tint="indigo" width={640} align="top" class="palette">
      <PaletteBody {...props} />
    </Dialog>
  )
}

function PaletteBody(props: PaletteProps) {
  const { state, actions } = useWeft()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const showSession = (id: string) => (props.onSession ? props.onSession(id) : actions.openSession(id))
  const replying = () => Object.values(state.status).filter((status) => status.type !== "idle").length

  async function newSession() {
    if (props.onNewSession) return props.onNewSession()
    if (!state.directory) return openDialog({ kind: "projects" })
    await showSession((await actions.createSession(state.directory)).id)
  }

  async function restartEngine() {
    const running = replying()
    if (
      running &&
      !(await ask({
        title: "Restart the engine now?",
        confirm: "Restart",
        danger: true,
        body: [`${running === 1 ? "1 running reply stops" : `${running} running replies stop`} where they are. What they wrote so far is kept.`],
      }))
    )
      return
    await actions.restartEngine()
  }

  const sessionID = () => props.sessionID
  const session = () => (props.sessionID ? state.info[props.sessionID] : undefined)

  const actionItems = (): Item[] => {
    const id = sessionID()
    const s = session()
    const list: (Item | false)[] = [
      {
        group: "actions",
        key: "new",
        title: "New session",
        hint: "Ctrl N",
        core: true,
        run: newSession,
      },
      { group: "actions", key: "model", title: "Choose model…", core: true, run: () => openDialog({ kind: "model", sessionID: id }) },
      { group: "actions", key: "connect", title: "Connect a provider…", terms: "api key login oauth", core: true, run: () => openDialog({ kind: "connect" }) },
      { group: "actions", key: "projects", title: "Switch project…", core: true, run: () => openDialog({ kind: "projects" }) },
      {
        group: "actions",
        key: "folder",
        title: "Open folder…",
        run: async () => {
          const dir = await actions.pickProjectFolder()
          if (dir) await actions.openProject(dir)
        },
      },
      !!id && { group: "actions", key: "rename", title: "Rename session…", run: () => openDialog({ kind: "rename", sessionID: id }) },
      !!id && {
        group: "actions",
        key: "fork",
        title: "Fork session",
        run: async () => showSession((await actions.forkSession(id)).id),
      },
      !!id && { group: "actions", key: "compact", title: "Compact session", terms: "summarize", run: () => actions.summarize(id) },
      !!s && {
        group: "actions",
        key: "share",
        title: s.share ? "Stop sharing session" : "Share session publicly…",
        terms: "link publish",
        run: () => toggleShare(actions, s),
      },
      !!id && {
        group: "actions",
        key: "archive",
        title: s?.time.archived ? "Unarchive session" : "Archive session",
        run: () => actions.archiveSession(id, !s?.time.archived),
      },
      !!s && {
        group: "actions",
        key: "export",
        title: "Export session as JSON…",
        terms: "save file download",
        run: () => saveSessionFile(actions, s),
      },
      !!id && { group: "actions", key: "delete", title: "Delete session…", run: () => openDialog({ kind: "delete", sessionID: id }) },
      { group: "actions", key: "settings", title: "Settings", hint: "Ctrl ,", core: true, run: () => openDialog({ kind: "settings" }) },
      { group: "actions", key: "restart", title: "Restart engine", run: restartEngine },
      {
        group: "actions",
        key: "motion",
        title: reducedMotionPreference() ? "Allow motion" : "Reduce motion",
        terms: "animation accessibility",
        run: () => setReducedMotion(!reducedMotionPreference()),
      },
      { group: "actions", key: "about", title: "About Weft", terms: "license notice", run: () => openDialog({ kind: "settings", tab: "about" }) },
    ]
    return list.filter((x): x is Item => !!x)
  }

  const sessionItems = (): Item[] => {
    const seen = new Map<string, Session>()
    for (const list of [...Object.values(state.sessions), ...Object.values(state.archived ?? {})]) for (const s of list) seen.set(s.id, s)
    return [...seen.values()]
      .sort((a, b) => Number(!!a.time.archived) - Number(!!b.time.archived) || b.time.updated - a.time.updated)
      .map((s) => ({
        group: "sessions" as const,
        key: s.id,
        title: s.title,
        sub: s.time.archived ? `${basename(s.directory)} · archived` : basename(s.directory),
        hint: since(s.time.updated),
        terms: s.time.archived ? "archived" : undefined,
        run: () => showSession(s.id),
      }))
  }

  const commandItems = (): Item[] =>
    state.commands.map((c) => ({
      group: "commands" as const,
      key: c.name,
      title: `/${c.name}`,
      sub: c.description,
      hint: c.source && c.source !== "command" ? (SOURCE_NAMES[c.source] ?? c.source) : undefined,
      run: () => {
        if (props.onCommand) return props.onCommand(c.name)
        if (sessionID()) return actions.command(sessionID()!, c.name, "")
        toast("Open a session to run a command", "warn")
      },
    }))

  const modelItems = (): Item[] => {
    const connected = new Set(state.providers.connected)
    return sortProviders(state.providers.all, state.providers.connected)
      .filter((p) => connected.has(p.id))
      .flatMap((p) =>
        usableModels(p).map((m) => ({
          group: "models" as const,
          key: `${p.id}/${m.id}`,
          title: m.name,
          sub: `${p.id}/${m.id}`,
          run: () => {
            if (sessionID()) actions.setModel(sessionID()!, p.id, m.id)
            else {
              actions.setDraftModel?.(p.id, m.id)
              toast(`The next session starts with ${m.name}`, "success")
            }
            rememberModel({ providerID: p.id, modelID: m.id })
          },
        })),
      )
  }

  const projectItems = (): Item[] =>
    openable(state.projects).map((p) => ({
      group: "projects" as const,
      key: p.id,
      title: p.name ?? basename(p.worktree),
      sub: p.worktree,
      hint: p.worktree === state.directory ? "Open now" : undefined,
      run: () => actions.openProject(p.worktree),
    }))

  const sources: Record<Group, () => Item[]> = {
    actions: actionItems,
    sessions: sessionItems,
    commands: commandItems,
    models: modelItems,
    projects: projectItems,
  }
  const total = createMemo(() => ORDER.reduce((n, group) => n + sources[group]().length, 0))

  const results = createMemo(() => {
    const raw = query().trim()
    const slash = raw.startsWith("/")
    const q = slash ? raw.slice(1) : raw
    const groups = slash ? (["commands"] as Group[]) : q ? ORDER : (["actions", "sessions", "projects"] as Group[])
    let index = 0
    return groups
      .map((group) => {
        const scored = sources[group]()
          .filter((item) => q || group !== "actions" || item.core)
          .map((item) => {
            const title = fuzzy(q, item.title)
            const other = [item.sub, item.terms].some((t) => t?.toLowerCase().includes(q.toLowerCase()))
            const match: Match | undefined = title ?? (other ? { score: 900, hits: [] } : undefined)
            return match ? { item, match, titleHits: title?.hits } : undefined
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
        if (q) scored.sort((a, b) => b.match.score - a.match.score)
        const limit = slash ? 40 : q || group === "sessions" ? PER_GROUP : Infinity
        return { group, items: scored.slice(0, limit).map((s): Found => ({ ...s.item, hits: s.titleHits, index: 0 })) }
      })
      .filter((g) => g.items.length)
      .map((g) => ({ ...g, items: g.items.map((item) => ({ ...item, index: index++ })) }))
  })

  const flat = createMemo(() => results().flatMap((g) => g.items))
  const nav = createCursor(() => flat().length, query)

  async function choose(index: number) {
    const item = flat()[index]
    if (!item) return
    dialog.close()
    try {
      await item.run()
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <>
      <Query
        label="Search"
        placeholder="Search actions, sessions, /commands, models and projects"
        value={query()}
        onInput={setQuery}
        onKeyDown={(e) => nav.onKey(e, choose)}
        count={`${flat().length} of ${total()}`}
      />
      <div class="dlg-list palette-list" ref={nav.bind} role="listbox" aria-label="Results">
        <Show when={flat().length} fallback={<p class="dlg-empty">Nothing matches “{query().trim()}”</p>}>
          <For each={results()}>
            {(group) => (
              <section class="dlg-group">
                <h3 class="dlg-group-title">{GROUP_NAMES[group.group]}</h3>
                <For each={group.items}>
                  {(item) => (
                    <button
                      class="dlg-row palette-row"
                      data-index={item.index}
                      data-group={item.group}
                      role="option"
                      aria-selected={nav.cursor() === item.index}
                      classList={{ on: nav.cursor() === item.index, danger: item.key === "delete" }}
                      onMouseMove={() => nav.setCursor(item.index)}
                      onClick={() => choose(item.index)}
                    >
                      <span class="row-icon">
                        <Show when={iconOf(item)} fallback={<span class="mini-marble" style={{ "--turn": `${turn(item.key)}deg` }} />}>
                          {(icon) => <Dynamic component={icon()} size={16} />}
                        </Show>
                      </span>
                      <span class="row-title">
                        <Marked text={item.title} hits={item.hits} />
                      </span>
                      <Show when={item.sub}>
                        <span class="row-sub">{item.sub}</span>
                      </Show>
                      <span class="spacer" />
                      <Show when={item.hint}>
                        <Show when={item.group === "actions"} fallback={<span class="num row-hint">{item.hint}</span>}>
                          <kbd>{item.hint}</kbd>
                        </Show>
                      </Show>
                    </button>
                  )}
                </For>
              </section>
            )}
          </For>
        </Show>
      </div>
      <footer class="dialog-foot">
        <KeyHints
          keys={[
            ["↑↓", "Move"],
            ["↵", "Run"],
            ["/", "Commands"],
            ["Esc", "Close"],
          ]}
        />
      </footer>
    </>
  )
}
