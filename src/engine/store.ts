import { batch } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import type {
  Config,
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  Project,
  Provider,
  QuestionRequest,
  Session,
  SnapshotFileDiff,
  UserMessage,
} from "@opencode-ai/sdk/v2/types"
import { errorMessage, isNotFound, type Api, type MessageWithParts } from "./api"
import type { EngineState, SessionContent, SessionError, WeftState } from "./contract"
import type { EngineEvent } from "./events"
import { yoloEnabled } from "./yolo"

const FIRST_PAGE = 40
const OLDER_PAGE = 200
const SESSION_PAGE = 200
const CACHED_SESSIONS = 40
const IDLE_REFETCH_MS = 20_000
const PROVIDER_DEBOUNCE_MS = 300
const CANARY_TOOL = "weft_canary"
const DIRECTORY_KEY = "weft.directory"
const CHOICE_KEY = "weft.choice."
const SKIPPED_PARTS = new Set<string>(["patch", "step-start", "step-finish"])

export type Choice = WeftState["choice"][string]

/** Ids written by events while a page request is in flight; they win over the page. */
type LoadGuard = { touched: Set<string>; removed: Set<string>; parts: Set<string>; removedParts: Set<string> }

type RequestKind = "permissions" | "questions"

const byID = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Messages sort by (time.created, id): ids wrapped on 2026-08-14, so never by id alone. */
export function compareMessages(a: Message, b: Message) {
  return a.time.created - b.time.created || byID(a, b)
}

const newestFirst = (a: Session, b: Session) => b.time.updated - a.time.updated || byID(b, a)
const keepPart = (part: Part) => !SKIPPED_PARTS.has(part.type)
const listed = (session: Session) => !session.parentID && !session.time.archived
const shelved = (session: Session) => !session.parentID && !!session.time.archived

function sortedIndex<T>(list: readonly T[], item: T, compare: (a: T, b: T) => number) {
  let low = 0
  let high = list.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (compare(list[middle], item) < 0) low = middle + 1
    else high = middle
  }
  return low
}

function indexOfID(list: readonly { id: string }[], id: string) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) return i
  return -1
}

function toFileDiff(diff: SnapshotFileDiff): FileDiff {
  return {
    path: diff.file ?? "",
    status: diff.status ?? "modified",
    additions: diff.additions,
    deletions: diff.deletions,
    patch: diff.patch ?? "",
  }
}

/** `key`, `options` and model headers can hold credentials; the UI never sees them. */
function withoutSecrets(provider: Provider): Provider {
  const safe: Provider = { ...provider, options: {}, models: {} }
  delete safe.key
  for (const [id, model] of Object.entries(provider.models)) safe.models[id] = { ...model, options: {}, headers: {} }
  return safe
}

/** Provider options (resolved api keys), model headers and MCP headers, env and oauth secrets stay out of the store. */
function configWithoutSecrets(config: Config): Config {
  const safe: Config = { ...config }
  if (config.provider)
    safe.provider = Object.fromEntries(
      Object.entries(config.provider).map(([id, provider]) => [
        id,
        {
          ...provider,
          options: undefined,
          models:
            provider.models &&
            Object.fromEntries(Object.entries(provider.models).map(([key, model]) => [key, { ...model, options: undefined, headers: undefined }])),
        },
      ]),
    )
  if (config.mcp)
    safe.mcp = Object.fromEntries(
      Object.entries(config.mcp).map(([name, server]) => [
        name,
        server && typeof server === "object"
          ? ({ ...server, headers: undefined, environment: undefined, oauth: undefined } as typeof server)
          : server,
      ]),
    )
  return safe
}

function readStored<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage is a convenience; a blocked or full store just forgets
  }
}

const warn = (what: string) => (error: unknown) => console.warn(`[weft] ${what}:`, errorMessage(error))

function initialState(): WeftState {
  return {
    engine: { state: "idle" },
    liberated: undefined,
    projects: [],
    home: "",
    directory: undefined,
    sessions: {},
    archived: {},
    info: {},
    content: {},
    status: {},
    permissions: {},
    questions: {},
    todos: {},
    diffs: {},
    providers: { all: [], connected: [], default: {}, auth: {} },
    agents: [],
    commands: [],
    config: undefined,
    mcp: {},
    lsp: [],
    vcs: undefined,
    choice: {},
    errors: {},
  }
}

function sessionError(error: { name: string; data?: unknown } | undefined): SessionError {
  const message = (error?.data as { message?: unknown } | undefined)?.message
  const name = error?.name ?? "UnknownError"
  return { name, message: typeof message === "string" && message ? message : name, at: Date.now() }
}

export type WeftStore = ReturnType<typeof createWeftStore>

export function createWeftStore(api: Api) {
  const [state, setState] = createStore<WeftState>(initialState())
  const guards = new Map<string, Set<LoadGuard>>()
  const inflight = new Map<string, Promise<void>>()
  const cursors = new Map<string, string | undefined>()
  const pending = new Map<string, Set<string>>()
  const resolving = new Map<string, Promise<Session | undefined>>()
  const bootstrapped = new Set<string>()
  const sequences = new Map<string, number>()
  /** part id → field that received deltas since the part's last full update (deltas are not stored) */
  const streaming = new Map<string, string>()
  /** sessions holding content, least recently opened first */
  const recent: string[] = []
  let bootstrapping: Promise<void> | undefined
  let openID: string | undefined
  let providerTimer: ReturnType<typeof setTimeout> | undefined

  const markGuards = (sessionID: string, mark: (guard: LoadGuard) => void) => guards.get(sessionID)?.forEach(mark)
  const ready = () => state.engine.state === "ready"

  // ───────── sessions ─────────

  function placed(list: Session[], session: Session, belongs: boolean) {
    const rest = list.filter((item) => item.id !== session.id)
    if (belongs) rest.splice(sortedIndex(rest, session, newestFirst), 0, session)
    return rest
  }

  function listSession(id: string) {
    const session = state.info[id]
    if (!session) return
    const directory = session.directory
    if (state.sessions[directory]) setState("sessions", directory, (list) => placed(list, session, listed(session)))
    if (state.archived?.[directory]) setState("archived", directory, (list) => placed(list, session, shelved(session)))
  }

  function remember(session: Session) {
    batch(() => {
      setState("info", session.id, reconcile(session))
      listSession(session.id)
    })
  }

  function forget(id: string) {
    const directory = state.info[id]?.directory
    batch(() => {
      if (directory && state.sessions[directory])
        setState("sessions", directory, (list) => list.filter((item) => item.id !== id))
      if (directory && state.archived?.[directory])
        setState("archived", directory, (list) => list.filter((item) => item.id !== id))
      setState(
        produce((draft) => {
          delete draft.info[id]
          delete draft.content[id]
          delete draft.status[id]
          delete draft.permissions[id]
          delete draft.questions[id]
          delete draft.todos[id]
          delete draft.diffs[id]
          delete draft.choice[id]
          delete draft.errors?.[id]
        }),
      )
    })
    cursors.delete(id)
    pending.delete(id)
    sequences.delete(id)
    if (recent.includes(id)) recent.splice(recent.indexOf(id), 1)
    writeStored(CHOICE_KEY + id, undefined)
    if (openID === id) openID = undefined
  }

  function resolve(id: string): Promise<Session | undefined> {
    const known = state.info[id]
    if (known) return Promise.resolve(known)
    let request = resolving.get(id)
    if (!request) {
      request = api.session
        .get(id)
        .then(
          (session) => {
            remember(session)
            return state.info[id]
          },
          (error) => {
            if (!isNotFound(error)) warn(`resolve ${id}`)(error)
            return undefined
          },
        )
        .finally(() => resolving.delete(id))
      resolving.set(id, request)
    }
    return request
  }

  // ───────── content ─────────

  const emptyContent = (loaded: boolean): SessionContent => ({
    messages: [],
    parts: {},
    loaded,
    hasOlder: false,
    loadingOlder: false,
  })

  const evictable = (sessionID: string) =>
    sessionID !== openID &&
    (state.status[sessionID]?.type ?? "idle") === "idle" &&
    !pending.get(sessionID)?.size &&
    !guards.has(sessionID) &&
    !state.permissions[sessionID]?.length &&
    !state.questions[sessionID]?.length

  /** Keeps the content of the last CACHED_SESSIONS sessions; an evicted session reloads when opened again. */
  function touch(sessionID: string) {
    if (recent.includes(sessionID)) recent.splice(recent.indexOf(sessionID), 1)
    recent.push(sessionID)
    const evicted: string[] = []
    for (let i = 0; recent.length - evicted.length > CACHED_SESSIONS && i < recent.length - 1; i++)
      if (evictable(recent[i])) evicted.push(recent[i])
    if (evicted.length === 0) return
    for (const id of evicted) {
      recent.splice(recent.indexOf(id), 1)
      cursors.delete(id)
    }
    setState("content", produce((content) => evicted.forEach((id) => delete content[id])))
  }

  function ensureContent(sessionID: string, loaded = false) {
    if (state.content[sessionID]) return
    setState("content", sessionID, emptyContent(loaded))
    touch(sessionID)
  }

  function patchContent(sessionID: string, patch: Partial<SessionContent>) {
    if (state.content[sessionID]) setState("content", sessionID, patch)
  }

  function upsertMessage(info: Message) {
    const sessionID = info.sessionID
    const messages = state.content[sessionID]?.messages
    if (!messages) return
    const index = indexOfID(messages, info.id)
    if (index < 0) {
      setState("content", sessionID, "messages", produce((list) => void list.splice(sortedIndex(list, info, compareMessages), 0, info)))
      return
    }
    const moved = messages[index].time.created !== info.time.created
    setState("content", sessionID, "messages", index, reconcile(info))
    if (moved) setState("content", sessionID, "messages", (list) => [...list].sort(compareMessages))
  }

  function messageUpdated(info: Message) {
    markGuards(info.sessionID, (guard) => {
      guard.touched.add(info.id)
      guard.removed.delete(info.id)
    })
    pending.get(info.sessionID)?.delete(info.id)
    upsertMessage(info)
  }

  function messageRemoved(sessionID: string, messageID: string) {
    markGuards(sessionID, (guard) => {
      guard.removed.add(messageID)
      guard.touched.delete(messageID)
    })
    pending.get(sessionID)?.delete(messageID)
    if (!state.content[sessionID]) return
    state.content[sessionID].parts[messageID]?.forEach((part) => streaming.delete(part.id))
    setState(
      "content",
      sessionID,
      produce((content) => {
        const index = indexOfID(content.messages, messageID)
        if (index >= 0) content.messages.splice(index, 1)
        delete content.parts[messageID]
      }),
    )
  }

  function partUpdated(part: Part) {
    if (!keepPart(part)) return
    streaming.delete(part.id)
    const sessionID = part.sessionID
    const loading = (guards.get(sessionID)?.size ?? 0) > 0
    markGuards(sessionID, (guard) => {
      guard.parts.add(part.id)
      guard.removedParts.delete(part.id)
    })
    const content = state.content[sessionID]
    if (!content) return
    if (!loading && indexOfID(content.messages, part.messageID) < 0) return
    const parts = content.parts[part.messageID]
    if (!parts) {
      setState("content", sessionID, "parts", part.messageID, [part])
      return
    }
    const index = indexOfID(parts, part.id)
    if (index >= 0) setState("content", sessionID, "parts", part.messageID, index, reconcile(part))
    else setState("content", sessionID, "parts", part.messageID, produce((list) => void list.splice(sortedIndex(list, part, byID), 0, part)))
  }

  function partRemoved(sessionID: string, messageID: string, partID: string) {
    streaming.delete(partID)
    markGuards(sessionID, (guard) => {
      guard.removedParts.add(partID)
      guard.parts.delete(partID)
    })
    const parts = state.content[sessionID]?.parts[messageID]
    if (!parts) return
    const index = indexOfID(parts, partID)
    if (index >= 0) setState("content", sessionID, "parts", messageID, produce((list) => void list.splice(index, 1)))
  }

  function partDelta(delta: { sessionID: string; messageID: string; partID: string; field: string; delta: string }) {
    markGuards(delta.sessionID, (guard) => guard.parts.add(delta.partID))
    const parts = state.content[delta.sessionID]?.parts[delta.messageID]
    if (!parts) return
    const index = indexOfID(parts, delta.partID)
    if (index < 0) return
    streaming.set(delta.partID, delta.field)
    setState(
      "content",
      delta.sessionID,
      "parts",
      delta.messageID,
      index,
      produce((part) => {
        const fields = part as unknown as Record<string, unknown>
        const current = fields[delta.field]
        fields[delta.field] = (typeof current === "string" ? current : "") + delta.delta
      }),
    )
  }

  /** The stored copy of a streaming part lags behind its deltas; keep the local one while it only extends it. */
  function streamedPast(local: Part | undefined, fetched: Part) {
    const field = local && streaming.get(local.id)
    if (!field) return undefined
    const mine = (local as unknown as Record<string, unknown>)[field]
    const stored = (fetched as unknown as Record<string, unknown>)[field]
    return typeof mine === "string" && typeof stored === "string" && mine.startsWith(stored) ? local : undefined
  }

  function mergeParts(current: readonly Part[], fetched: readonly Part[], guard: LoadGuard) {
    const local = new Map(current.map((part) => [part.id, part] as const))
    const merged = new Map<string, Part>()
    for (const part of fetched)
      if (keepPart(part) && !guard.removedParts.has(part.id)) merged.set(part.id, streamedPast(local.get(part.id), part) ?? part)
    for (const part of current) if (guard.parts.has(part.id) && !guard.removedParts.has(part.id)) merged.set(part.id, part)
    return [...merged.values()].sort(byID)
  }

  /** Folds a fetched page in; with `windowed`, messages inside the page's range that it lacks were deleted elsewhere. */
  function merge(sessionID: string, items: MessageWithParts[], guard: LoadGuard, windowed: boolean) {
    const content = state.content[sessionID]
    if (!content) return
    const messages = new Map(unwrap(content.messages).map((message) => [message.id, message] as const))
    const fetched = new Set<string>()
    const partLists: [string, Part[]][] = []
    let oldest: Message | undefined
    for (const { info, parts } of items) {
      if (guard.removed.has(info.id)) continue
      fetched.add(info.id)
      if (!oldest || compareMessages(info, oldest) < 0) oldest = info
      if (!(guard.touched.has(info.id) && messages.has(info.id))) messages.set(info.id, info)
      partLists.push([info.id, mergeParts(unwrap(content.parts[info.id]) ?? [], parts, guard)])
    }
    const stale: string[] = []
    if (windowed) {
      const optimistic = pending.get(sessionID)
      for (const message of messages.values()) {
        if (fetched.has(message.id) || guard.touched.has(message.id) || optimistic?.has(message.id)) continue
        if (!oldest || compareMessages(message, oldest) >= 0) stale.push(message.id)
      }
      for (const id of stale) messages.delete(id)
    }
    batch(() => {
      setState("content", sessionID, "messages", reconcile([...messages.values()].sort(compareMessages)))
      for (const [id, parts] of partLists) setState("content", sessionID, "parts", id, reconcile(parts))
      if (stale.length > 0) setState("content", sessionID, "parts", produce((parts) => stale.forEach((id) => delete parts[id])))
    })
  }

  async function backfillParents(sessionID: string, items: MessageWithParts[], guard: LoadGuard) {
    const known = new Set(state.content[sessionID]?.messages.map((message) => message.id))
    const missing = new Set<string>()
    for (const { info } of items)
      if (info.role === "assistant" && info.parentID && !known.has(info.parentID)) missing.add(info.parentID)
    for (const id of missing) {
      if (guard.removed.has(id)) continue
      try {
        merge(sessionID, [await api.session.message(sessionID, id)], guard, false)
      } catch (error) {
        if (!isNotFound(error)) warn(`parent ${id}`)(error)
      }
    }
  }

  /**
   * A refetched latest page whose oldest message was not loaded yet may sit above a gap: messages written
   * elsewhere (OpenCode Desktop sends no events here) between it and the loaded ones.
   */
  function joinsLoaded(sessionID: string, items: MessageWithParts[]) {
    const oldest = items.reduce<Message | undefined>((a, { info }) => (!a || compareMessages(info, a) < 0 ? info : a), undefined)
    return !oldest || indexOfID(state.content[sessionID]?.messages ?? [], oldest.id) >= 0
  }

  async function loadPage(sessionID: string, mode: "latest" | "older") {
    const guard: LoadGuard = { touched: new Set(), removed: new Set(), parts: new Set(), removedParts: new Set() }
    const active = guards.get(sessionID) ?? new Set<LoadGuard>()
    active.add(guard)
    guards.set(sessionID, active)
    ensureContent(sessionID)
    try {
      if (mode === "older") {
        const before = cursors.get(sessionID)
        if (!before) return patchContent(sessionID, { hasOlder: false })
        patchContent(sessionID, { loadingOlder: true })
        const page = await api.session
          .messages(sessionID, { limit: OLDER_PAGE, before })
          .finally(() => patchContent(sessionID, { loadingOlder: false }))
        batch(() => {
          merge(sessionID, page.items, guard, false)
          cursors.set(sessionID, page.cursor)
          patchContent(sessionID, { hasOlder: !!page.cursor })
        })
        return
      }
      const first = !state.content[sessionID]?.loaded
      const page = await api.session.messages(sessionID, { limit: FIRST_PAGE })
      const gapped = !first && !!page.cursor && !joinsLoaded(sessionID, page.items)
      batch(() => {
        merge(sessionID, page.items, guard, true)
        if (!first && !gapped) return
        cursors.set(sessionID, page.cursor)
        patchContent(sessionID, { loaded: true, hasOlder: !!page.cursor })
      })
      await backfillParents(sessionID, page.items, guard)
    } finally {
      active.delete(guard)
      if (active.size === 0) guards.delete(sessionID)
    }
  }

  function load(sessionID: string, mode: "latest" | "older") {
    const key = `${mode}:${sessionID}`
    const running = inflight.get(key)
    if (running) return running
    const task = loadPage(sessionID, mode).finally(() => inflight.delete(key))
    inflight.set(key, task)
    return task
  }

  async function loadTodos(sessionID: string) {
    const todos = await api.session.todo(sessionID)
    if (state.info[sessionID]) setState("todos", sessionID, todos)
  }

  async function refresh(sessionID: string) {
    try {
      remember(await api.session.get(sessionID))
    } catch (error) {
      if (isNotFound(error)) return forget(sessionID)
      throw error
    }
    await load(sessionID, "latest")
  }

  async function open(sessionID: string) {
    openID = sessionID
    if (state.content[sessionID]) touch(sessionID)
    hydrateChoice(sessionID)
    const session = await resolve(sessionID)
    if (!session) throw new Error("This session no longer exists")
    await Promise.all([load(sessionID, "latest"), loadTodos(sessionID).catch(warn(`todos ${sessionID}`))])
    if (!state.choice[sessionID]) {
      const fallback = fallbackChoice(sessionID)
      if (fallback) setState("choice", sessionID, reconcile(fallback))
    }
  }

  function addPending(info: UserMessage, parts: Part[]) {
    const sessionID = info.sessionID
    ensureContent(sessionID)
    const ids = pending.get(sessionID) ?? new Set<string>()
    ids.add(info.id)
    pending.set(sessionID, ids)
    batch(() => {
      upsertMessage(info)
      setState("content", sessionID, "parts", info.id, [...parts].sort(byID))
    })
  }

  const promptText = (sessionID: string, messageID: string) =>
    (state.content[sessionID]?.parts[messageID] ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")

  function dropPending(sessionID: string, messageID: string) {
    if (!pending.get(sessionID)?.delete(messageID)) return
    messageRemoved(sessionID, messageID)
  }

  /**
   * A prompt failed before its user message was stored; a message the engine did store comes back with its event.
   * The first error of a turn names the cause; `prompt_async` follows it with a generic stack trace.
   */
  function sessionFailed(sessionID: string, error: SessionError) {
    batch(() => {
      const dropped = [...(pending.get(sessionID) ?? [])]
      const unsent = dropped.map((id) => promptText(sessionID, id)).filter(Boolean).join("\n\n")
      for (const id of dropped) dropPending(sessionID, id)
      if (error.name === "MessageAbortedError" || state.errors?.[sessionID]) return
      setState("errors", sessionID, unsent ? { ...error, unsent } : error)
    })
  }

  function clearError(sessionID: string) {
    if (state.errors?.[sessionID]) setState(produce((draft) => void delete draft.errors?.[sessionID]))
  }

  // ───────── permissions and questions ─────────

  function queueRequest(kind: RequestKind, request: PermissionRequest | QuestionRequest) {
    setState(
      produce((draft) => {
        const lists = draft[kind] as Record<string, { id: string }[]>
        const list = (lists[request.sessionID] ??= [])
        const index = indexOfID(list, request.id)
        if (index >= 0) list[index] = request
        else list.splice(sortedIndex(list, request, byID), 0, request)
      }),
    )
  }

  function approvePermission(request: PermissionRequest, directory?: string) {
    const at = state.info[request.sessionID]?.directory ?? directory ?? state.directory
    void api.permission.reply(at, request.id, "once").catch((error) => {
      warn("yolo permission")(error)
      queueRequest("permissions", request)
    })
  }

  function addRequest(kind: RequestKind, request: PermissionRequest | QuestionRequest, directory?: string) {
    if (kind === "permissions" && yoloEnabled()) {
      approvePermission(request as PermissionRequest, directory)
      return
    }
    queueRequest(kind, request)
  }

  function removeRequest(kind: RequestKind, sessionID: string, requestID: string) {
    setState(
      produce((draft) => {
        const list = (draft[kind] as Record<string, { id: string }[]>)[sessionID]
        const index = list ? indexOfID(list, requestID) : -1
        if (index >= 0) list.splice(index, 1)
      }),
    )
  }

  function replaceRequests(kind: RequestKind, directory: string, requests: (PermissionRequest | QuestionRequest)[]) {
    if (kind === "permissions" && yoloEnabled()) {
      for (const request of requests) approvePermission(request as PermissionRequest, directory)
      return
    }
    setState(
      produce((draft) => {
        const lists = draft[kind] as Record<string, { id: string }[]>
        for (const id of Object.keys(lists)) if (draft.info[id]?.directory === directory) delete lists[id]
        for (const request of requests) {
          const list = (lists[request.sessionID] ??= [])
          const index = indexOfID(list, request.id)
          if (index >= 0) list[index] = request
          else list.push(request)
        }
        for (const request of requests) lists[request.sessionID].sort(byID)
      }),
    )
    for (const request of requests) void resolve(request.sessionID)
  }

  // ───────── directory-scoped lists ─────────

  const sortProjects = (projects: Project[]) => [...projects].sort((a, b) => b.time.updated - a.time.updated)

  function upsertProject(project: Project) {
    setState("projects", (list) => sortProjects([...list.filter((item) => item.id !== project.id), project]))
  }

  async function refreshProviders(directory = state.directory) {
    const [list, auth] = await Promise.all([api.provider.list(directory), api.provider.auth(directory)])
    setState(
      "providers",
      reconcile({ all: list.all.map(withoutSecrets), connected: list.connected, default: list.default, auth }),
    )
  }

  function scheduleProviders() {
    clearTimeout(providerTimer)
    providerTimer = setTimeout(() => void refreshProviders().catch(warn("providers")), PROVIDER_DEBOUNCE_MS)
  }

  async function refreshMcp() {
    const directory = state.directory
    if (!directory) return
    const mcp = await api.mcp.status(directory)
    if (state.directory === directory) setState("mcp", reconcile(mcp))
  }

  async function refreshLsp() {
    const directory = state.directory
    if (!directory) return
    const lsp = await api.lsp.status(directory)
    if (state.directory === directory) setState("lsp", reconcile(lsp, { key: "id" }))
  }

  async function refreshConfig() {
    const directory = state.directory
    if (!directory) return
    const config = await api.config.get(directory)
    if (state.directory === directory) setState("config", reconcile(configWithoutSecrets(config)))
  }

  async function bootstrapDirectory(directory: string) {
    bootstrapped.add(directory)
    if (!state.sessions[directory]) setState("sessions", directory, [])
    const active = () => state.directory === directory
    const tasks: Promise<unknown>[] = [
      api.session.list(directory, { roots: true, limit: SESSION_PAGE }).then((sessions) =>
        batch(() => {
          for (const session of sessions) setState("info", session.id, reconcile(session))
          const known = sessions.map((session) => unwrap(state.info[session.id]))
          setState("sessions", directory, known.filter(listed).sort(newestFirst))
          setState("archived", directory, known.filter(shelved).sort(newestFirst))
        }),
      ),
      api.session.status(directory).then((statuses) =>
        batch(() => {
          for (const [id, status] of Object.entries(statuses)) setState("status", id, reconcile(status))
          for (const id of Object.keys(state.status))
            if (!statuses[id] && state.info[id]?.directory === directory && state.status[id]?.type !== "idle")
              setState("status", id, reconcile({ type: "idle" }))
        }),
      ),
      api.permission.list(directory).then((requests) => replaceRequests("permissions", directory, requests)),
      api.question.list(directory).then((requests) => replaceRequests("questions", directory, requests)),
    ]
    if (active())
      tasks.push(
        refreshConfig(),
        refreshMcp(),
        refreshLsp(),
        refreshProviders(directory),
        api.vcs.get(directory).then(
          (vcs) => active() && setState("vcs", reconcile(vcs)),
          () => active() && setState("vcs", undefined),
        ),
        api.agents(directory).then((agents) => active() && setState("agents", reconcile(agents, { key: "name" }))),
        api.commands(directory).then((commands) => active() && setState("commands", reconcile(commands, { key: "name" }))),
        api.toolIDs(directory).then((ids) => active() && setState("liberated", ids.includes(CANARY_TOOL))),
      )
    const results = await Promise.allSettled(tasks)
    for (const result of results) if (result.status === "rejected") warn(`bootstrap ${directory}`)(result.reason)
  }

  function recentProject() {
    return state.projects.find((project) => project.worktree && project.worktree !== "/")?.worktree
  }

  const normalPath = (path: string) => path.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
  const samePath = (a: string, b: string) => normalPath(a) === normalPath(b)

  function bootstrap() {
    bootstrapping ??= (async () => {
      const [path, projects] = await Promise.allSettled([api.path(), api.project.list()])
      if (path.status === "fulfilled") setState("home", path.value.home)
      if (projects.status === "fulfilled") setState("projects", reconcile(sortProjects(projects.value), { key: "id" }))
      const cwd = path.status === "fulfilled" && !samePath(path.value.directory, path.value.home) ? path.value.directory : undefined
      const directory = state.directory ?? readStored<string>(DIRECTORY_KEY) ?? recentProject() ?? cwd
      if (!directory) return
      if (state.directory !== directory) setState("directory", directory)
      const others = [...bootstrapped].filter((item) => item !== directory)
      await Promise.all([bootstrapDirectory(directory), ...others.map((item) => bootstrapDirectory(item))])
      if (openID) await refresh(openID).catch(warn(`refresh ${openID}`))
    })().finally(() => (bootstrapping = undefined))
    return bootstrapping
  }

  async function openDirectory(directory: string) {
    setState("directory", directory)
    writeStored(DIRECTORY_KEY, directory)
    await bootstrapDirectory(directory)
    const projects = await api.project.list().catch(() => undefined)
    if (projects) setState("projects", reconcile(sortProjects(projects), { key: "id" }))
  }

  // ───────── model and agent choice ─────────

  function hydrateChoice(sessionID: string) {
    if (state.choice[sessionID]) return
    const stored = readStored<Choice>(CHOICE_KEY + sessionID)
    if (stored?.agent) setState("choice", sessionID, reconcile(stored))
  }

  function defaultAgent() {
    return (
      state.config?.default_agent ??
      state.agents.find((agent) => agent.mode !== "subagent" && !agent.hidden)?.name ??
      "build"
    )
  }

  /** The model and variant an agent's config names; like OpenCode Desktop, switching to the agent switches to them. */
  function agentChoice(agent: string): Choice | undefined {
    const own = state.agents.find((item) => item.name === agent)
    return own?.model && { providerID: own.model.providerID, modelID: own.model.modelID, variant: own.variant, agent }
  }

  function fallbackChoice(sessionID: string): Choice | undefined {
    const session = state.info[sessionID]
    const lastUser = state.content[sessionID]?.messages.findLast((message): message is UserMessage => message.role === "user")
    const agent = session?.agent ?? lastUser?.agent ?? defaultAgent()
    if (session?.model)
      return { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant, agent }
    if (lastUser?.model.modelID) return { ...lastUser.model, agent }
    const own = agentChoice(agent)
    if (own) return own
    const configured = state.config?.model
    const slash = configured?.indexOf("/") ?? -1
    if (configured && slash > 0) return { providerID: configured.slice(0, slash), modelID: configured.slice(slash + 1), agent }
    const providerID = state.providers.connected[0]
    const modelID = providerID ? state.providers.default[providerID] : undefined
    return providerID && modelID ? { providerID, modelID, agent } : undefined
  }

  function choiceFor(sessionID: string): Choice | undefined {
    hydrateChoice(sessionID)
    return state.choice[sessionID] ?? fallbackChoice(sessionID)
  }

  function setChoice(sessionID: string, choice: Choice) {
    setState("choice", sessionID, reconcile(choice))
    writeStored(CHOICE_KEY + sessionID, choice)
  }

  /** The model chosen before a session existed, handed once to the session created next. */
  function takeDraft() {
    const draft = state.draft && { ...state.draft }
    if (draft) setState("draft", undefined)
    return draft
  }

  // ───────── events ─────────

  function reduce({ directory, payload }: EngineEvent) {
    const sessionID = (payload.properties as { sessionID?: unknown } | undefined)?.sessionID
    const carriesInfo = payload.type === "session.created" || payload.type === "session.updated" || payload.type === "session.deleted"
    if (typeof sessionID === "string" && !carriesInfo && !state.info[sessionID]) void resolve(sessionID)

    switch (payload.type) {
      case "global.disposed":
        void bootstrap()
        return
      case "server.instance.disposed":
        if (bootstrapped.has(payload.properties.directory)) void bootstrapDirectory(payload.properties.directory)
        return
      case "project.updated":
        upsertProject(payload.properties as Project)
        return
      case "session.created":
      case "session.updated":
        remember(payload.properties.info)
        return
      case "session.deleted":
        forget(payload.properties.info?.id ?? payload.properties.sessionID)
        return
      case "session.status":
        if (payload.properties.status.type === "busy") clearError(payload.properties.sessionID)
        setState("status", payload.properties.sessionID, reconcile(payload.properties.status))
        return
      case "session.idle":
        setState("status", payload.properties.sessionID, reconcile({ type: "idle" }))
        return
      case "session.error":
        if (payload.properties.sessionID) sessionFailed(payload.properties.sessionID, sessionError(payload.properties.error))
        return
      case "session.compacted":
        if (state.content[payload.properties.sessionID]?.loaded)
          void load(payload.properties.sessionID, "latest").catch(warn("compacted"))
        return
      case "session.diff":
        setState("diffs", payload.properties.sessionID, payload.properties.diff.map(toFileDiff))
        return
      case "todo.updated":
        setState("todos", payload.properties.sessionID, payload.properties.todos)
        return
      case "message.updated":
        messageUpdated(payload.properties.info)
        return
      case "message.removed":
        messageRemoved(payload.properties.sessionID, payload.properties.messageID)
        return
      case "message.part.updated":
        partUpdated(payload.properties.part)
        return
      case "message.part.removed":
        partRemoved(payload.properties.sessionID, payload.properties.messageID, payload.properties.partID)
        return
      case "message.part.delta":
        partDelta(payload.properties)
        return
      case "permission.asked":
        addRequest("permissions", payload.properties, directory)
        return
      case "permission.replied":
        removeRequest("permissions", payload.properties.sessionID, payload.properties.requestID)
        return
      case "question.asked":
        addRequest("questions", payload.properties)
        return
      case "question.replied":
      case "question.rejected":
        removeRequest("questions", payload.properties.sessionID, payload.properties.requestID)
        return
      case "lsp.updated":
        if (directory === state.directory) void refreshLsp().catch(warn("lsp"))
        return
      case "mcp.tools.changed":
        if (directory === state.directory) void refreshMcp().catch(warn("mcp"))
        return
      case "vcs.branch.updated":
        if (directory === state.directory) setState("vcs", (vcs) => ({ ...vcs, branch: payload.properties.branch }))
        return
      case "integration.connection.updated":
      case "catalog.updated":
      case "models-dev.refreshed":
        scheduleProviders()
        return
    }
  }

  function apply(events: EngineEvent[]) {
    batch(() => events.forEach(reduce))
  }

  // ───────── open-session upkeep (B.3.5) ─────────

  // WebView2 reports a minimised window as visible: only a focused one refetches, and focus refetches on return.
  function refetchOpen() {
    if (!openID || !ready() || document.visibilityState !== "visible" || !document.hasFocus()) return
    void refresh(openID).catch(warn(`refresh ${openID}`))
  }

  const onFocus = () => refetchOpen()
  window.addEventListener("focus", onFocus)
  const idleTimer = setInterval(() => {
    if (openID && (state.status[openID]?.type ?? "idle") === "idle") refetchOpen()
  }, IDLE_REFETCH_MS)

  return {
    state,
    setEngine: (engine: EngineState) => setState("engine", reconcile(engine)),
    apply,
    bootstrap,
    bootstrapDirectory,
    openDirectory,
    /** After a stream reconnect: lists, then the open session. */
    resync: () => bootstrap(),
    open,
    close: () => void (openID = undefined),
    refresh,
    loadOlder: (sessionID: string) => load(sessionID, "older"),
    resolve,
    remember,
    forget,
    ensureContent,
    addPending,
    dropPending,
    removeRequest,
    clearTodos: (sessionID: string) => setState("todos", sessionID, []),
    clearError,
    /** A request that failed after its caller stopped waiting (command, shell). */
    fail: (sessionID: string, error: unknown) =>
      sessionFailed(sessionID, { name: "RequestError", message: errorMessage(error), at: Date.now() }),
    choiceFor,
    setChoice,
    setDraft: (draft: NonNullable<WeftState["draft"]>) => setState("draft", { ...draft }),
    takeDraft,
    agentChoice,
    defaultAgent,
    refreshProviders: () => refreshProviders(),
    refreshMcp,
    refreshConfig,
    sequence(aggregateID: string, seq: number) {
      if (seq > (sequences.get(aggregateID) ?? 0)) sequences.set(aggregateID, seq)
    },
    lastSequence: (sessionID: string) => sequences.get(sessionID),
    dispose() {
      window.removeEventListener("focus", onFocus)
      clearInterval(idleTimer)
      clearTimeout(providerTimer)
    },
  }
}
