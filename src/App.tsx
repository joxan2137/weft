import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  getOwner,
  lazy,
  mapArray,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  type Accessor,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2/types"
import { Boot, type BootDownload, type BootPhase } from "./art/Boot"
import { History } from "./art/History"
import { SessionHead } from "./art/SessionHead"
import { Water } from "./art/Water"
import type { Draft, WeftPick } from "./art/weave"
import { isBusy } from "./engine/api"
import { useWeft } from "./engine/context"
import type { EngineState } from "./engine/contract"
import { deriveCloth, forkPlan, readMeta, type Observed, type Seed } from "./engine/liberate"
import { seedFor } from "./engine/prompts"
import { latestReply } from "./engine/speed"
import { draftOf, weftOf, type ChangedFile, type ContextView, type LoomView, type PickView, type SessionView } from "./engine/view"
import { Cloth } from "./ui/Cloth"
import { DraftPanel } from "./ui/DraftPanel"
import { EmptyLoom } from "./ui/EmptyLoom"
import { Fell } from "./ui/Fell"
import type { PickActions } from "./ui/Pick"
import { SwatchBook, type SessionAction } from "./ui/SwatchBook"
import { Titlebar } from "./ui/Titlebar"
import {
  announceShared,
  ask,
  currentModel,
  DialogHost,
  openDialog,
  overlayOpen,
  QuestionDock,
  saveSessionFile,
  Toaster,
  toast,
  toastError,
  type DialogRequest,
} from "./ui/dialogs"
import { findModel } from "./ui/dialogs/catalog"
import { copyText, inTauri, openLogs } from "./ui/platform"

// Both drawers start closed: xterm and the diff library load on first open, not at launch.
const Review = lazy(() => import("./ui/Review").then((m) => ({ default: m.Review })))
const Terminal = lazy(() => import("./ui/Terminal").then((m) => ({ default: m.Terminal })))

const LAST_SESSION_KEY = "weft.lastSession."
const BLANK_SEED: Seed = { file: "", text: "" }
const AS_SENT = "as sent"
const PROJECT_WAIT_MS = 15_000
const BOOT_PHASE: Record<EngineState["state"], BootPhase> = {
  idle: "resolving",
  resolving: "resolving",
  installing: "installing",
  starting: "starting",
  ready: "ready",
  error: "error",
}

/** Development-only URL flags that put the app in a state a screenshot can show (no clicks needed). */
const devFlags = import.meta.env.DEV ? new URLSearchParams(location.search) : new URLSearchParams()

function readLast(directory: string) {
  try {
    return localStorage.getItem(LAST_SESSION_KEY + directory) ?? undefined
  } catch {
    return undefined
  }
}

function writeLast(directory: string, id: string | undefined) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY + directory, id)
    else localStorage.removeItem(LAST_SESSION_KEY + directory)
  } catch {
    // remembering the last session is a convenience
  }
}

/** A sparkline for a session whose messages are not loaded: estimated from its token and change totals. */
function summaryDraft(session: Session | undefined): Draft {
  const warp = session && readMeta(session).system ? "weld" : "linen"
  const tokens = session?.tokens
  const files = session?.summary?.files ?? 0
  if (!tokens || tokens.input + tokens.output === 0) {
    const woven = session && session.time.updated > session.time.created + 1000
    return {
      warp,
      picks: woven ? [{ dye: "user", weave: "plain", tokens: 120 }] : [],
    }
  }
  const turns = Math.max(1, Math.min(9, Math.round(Math.log2(1 + (tokens.input + tokens.output) / 4000))))
  const picks: WeftPick[] = []
  for (let turn = 0; turn < turns; turn++) {
    picks.push({
      dye: "user",
      weave: "plain",
      tokens: Math.max(40, tokens.input / turns / 40),
    })
    if (tokens.reasoning)
      picks.push({
        dye: "assistant",
        weave: "satin",
        tokens: tokens.reasoning / turns,
      })
    if (files && turn % 2 === 1) picks.push({ dye: "tool", weave: "basket", tokens: 180 })
    picks.push({
      dye: "assistant",
      weave: session?.summary?.additions ? "twill" : "plain",
      tokens: tokens.output / turns,
    })
  }
  return { warp, picks }
}

/** The engine download in bytes, read only when the engine state carries them. */
function downloadOf(engine: EngineState): BootDownload | undefined {
  if (engine.state !== "installing") return undefined
  const received = "received" in engine && typeof engine.received === "number" ? engine.received : undefined
  const total = "total" in engine && typeof engine.total === "number" && engine.total > 0 ? engine.total : undefined
  return { version: engine.version, received, total }
}

export function App() {
  const { state, actions } = useWeft()
  const owner = getOwner()

  const [activeID, setActiveID] = createSignal<string>()
  const [bookOpen, setBookOpen] = createSignal(true)
  const [draftOpen, setDraftOpen] = createSignal(true)
  const [clothOpen, setClothOpen] = createSignal(devFlags.has("cloth"))
  const [reviewOpen, setReviewOpen] = createSignal(devFlags.has("review"))
  const [terminalOpen, setTerminalOpen] = createSignal(devFlags.has("terminal"))
  const [booted, setBooted] = createSignal(false)
  const [dismissed, setDismissed] = createSignal<Record<string, number>>({})

  // ───────── boot ─────────

  const holdBoot = devFlags.get("boot") === "hold"
  // The store picks the project only after the engine answers its first instance request, which
  // takes seconds on a fresh engine: until then New session and the prompt would ask for a folder.
  const [gaveUpOnProject, setGaveUpOnProject] = createSignal(false)
  createEffect(
    on(
      () => state.engine.state === "ready",
      (ready) => {
        setGaveUpOnProject(false)
        if (!ready) return
        const timer = window.setTimeout(() => setGaveUpOnProject(true), PROJECT_WAIT_MS)
        onCleanup(() => window.clearTimeout(timer))
      },
    ),
  )
  // The engine runs in the home folder, which is never the project unless the user picks it: with
  // nothing chosen yet the store leaves the directory empty once it knows the home folder.
  const projectless = () => state.engine.state === "ready" && !!state.home && !state.directory
  const openingProject = () => state.engine.state === "ready" && !state.directory && !projectless() && !gaveUpOnProject()
  const bootPhase = () => {
    const phase = BOOT_PHASE[state.engine.state]
    return (holdBoot || openingProject()) && phase === "ready" ? "starting" : phase
  }
  const bootDownload = () => downloadOf(state.engine)
  const bootProgress = () => {
    const engine = state.engine
    if (engine.state !== "installing") return undefined
    const download = bootDownload()
    return download?.received !== undefined && !download.total ? undefined : engine.progress
  }
  const bootDetail = () => {
    const engine = state.engine
    if (engine.state === "installing" || engine.state === "starting") return engine.version ? `opencode ${engine.version}` : undefined
    if (openingProject()) return "opening the project"
    return undefined
  }
  const bootFailure = () => (state.engine.state === "error" ? { kind: state.engine.kind, message: state.engine.message } : undefined)
  async function copyBootFailure() {
    const failure = bootFailure()
    if (!failure) return
    await copyText(`Weft could not run the opencode engine (${failure.kind}).\n${failure.message}`)
    toast("Details copied", "success")
  }
  createEffect(
    on(
      () => state.engine.state,
      (now) => now !== "ready" && setBooted(false),
    ),
  )

  // First launch: ask for a project folder instead of quietly working in the home folder.
  createEffect(
    on(
      () => booted() && projectless(),
      (unchosen) => unchosen && openDialog({ kind: "projects" }),
    ),
  )

  // ───────── the open session ─────────

  const session = () => {
    const id = activeID()
    return id ? state.info[id] : undefined
  }
  const content = () => {
    const id = activeID()
    return id ? state.content[id] : undefined
  }
  const busy = () => {
    const id = activeID()
    return !!id && (state.status[id]?.type ?? "idle") !== "idle"
  }

  async function open(id: string) {
    setActiveID(id)
    try {
      await actions.openSession(id)
      const opened = state.info[id]
      if (!opened) return
      if (!opened.parentID) writeLast(opened.directory, id)
      if (opened.directory !== state.directory) await actions.openProject(opened.directory)
    } catch (error) {
      if (activeID() === id) setActiveID(undefined)
      if (state.directory && readLast(state.directory) === id) writeLast(state.directory, undefined)
      toastError(error)
    }
  }

  /** Agent chosen before any session exists (the model goes to state.draft); the first send's session starts with it. */
  const [unsaved, setUnsaved] = createSignal<{ agent?: string }>({})

  async function createSession(directory: string) {
    const created = await actions.createSession(directory)
    const { agent } = unsaved()
    if (agent) actions.setAgent(created.id, agent)
    setUnsaved({})
    return created
  }

  const openSessionID = () => {
    const id = activeID()
    return id && state.info[id] ? id : undefined
  }

  async function ensureSession() {
    const id = openSessionID()
    if (id) return id
    const directory = state.directory
    if (!directory) {
      openDialog({ kind: "projects" })
      throw new Error("Open a project first")
    }
    const created = await createSession(directory)
    await open(created.id)
    return created.id
  }

  async function newSession() {
    if (!state.directory) return openDialog({ kind: "projects" })
    try {
      await open((await createSession(state.directory)).id)
    } catch (error) {
      toastError(error)
    }
  }

  // On ready and on every project switch: reopen the project's last session (or a dev ?open= one).
  let devOpen = devFlags.get("open") ?? undefined
  createEffect(
    on(
      () => (state.engine.state === "ready" ? state.directory : undefined),
      (directory) => {
        if (!directory) return
        const current = activeID()
        if (current && state.info[current]?.directory === directory) return
        const wanted = devOpen ?? readLast(directory)
        devOpen = undefined
        if (wanted) void open(wanted)
        else setActiveID(undefined)
      },
    ),
  )

  // The store keeps the open session fresh (focus, idle refetch); an empty scrollback has none.
  createEffect(() => activeID() || actions.closeSession())

  // A deleted session leaves the scrollback empty.
  let seen: string | undefined
  createEffect(() => {
    const id = activeID()
    if (id && state.info[id]) seen = id
    else if (id && seen === id && !state.info[id]) {
      if (state.directory && readLast(state.directory) === id) writeLast(state.directory, undefined)
      setActiveID(undefined)
    }
  })

  // ───────── the scrollback ─────────

  const model = createMemo(() => (openSessionID() ? currentModel(state, activeID()) : currentModel(state)))
  const modelInfo = createMemo(() => findModel(state, model()))

  const [turn, setTurn] = createSignal(0)
  createEffect(
    on(
      () => {
        const id = activeID()
        return id ? (state.status[id]?.type ?? "idle") : undefined
      },
      (now, before) => {
        if (now === "idle" && before && before !== "idle") setTurn((n) => n + 1)
      },
    ),
  )
  const [observed] = createResource(
    () => (inTauri && activeID() ? { id: activeID()!, turn: turn() } : undefined),
    async ({ id }) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return (
        (await invoke<Observed | null>("observed_system", {
          sessionId: id,
        }).catch(() => null)) ?? undefined
      )
    },
  )
  const seenSystem: Accessor<Observed | undefined> = () => (observed.state === "errored" ? undefined : observed.latest)

  const seed = createMemo<Seed>(() => {
    const prompt = seenSystem()?.segments.prompt
    if (prompt) return { file: AS_SENT, text: prompt }
    const ref = model()
    return seedFor({
      providerID: ref?.providerID ?? "",
      apiID: modelInfo()?.model.api.id ?? ref?.modelID ?? "",
    })
  })

  const derived = createMemo<PickView[]>(() => {
    const s = session()
    if (!s) return []
    const c = content()
    return deriveCloth({
      session: s,
      messages: c?.messages ?? [],
      parts: c?.parts ?? {},
      seed: seed(),
      observed: seenSystem(),
    })
  })
  /** Messages keep their identity across updates, so streaming re-renders one part, not the whole conversation. */
  const [cloth, setCloth] = createStore<{ picks: PickView[] }>({ picks: [] })
  createEffect(() => setCloth("picks", reconcile(derived(), { key: "id" })))

  const rewritten = () => !!cloth.picks[0]?.warp?.rewritten
  // One memo per message: a streamed delta re-reads its own text, and the sparkline changes only when a message's stream or weight does.
  const wefts = mapArray(
    () => cloth.picks,
    (pick) =>
      createMemo(() => weftOf(pick), undefined, {
        equals: (a, b) => a.dye === b.dye && a.weave === b.weave && a.tokens === b.tokens,
      }),
  )
  const activeDraft = createMemo<Draft>(() => ({
    warp: rewritten() ? "weld" : "linen",
    picks: wefts().map((weft) => weft()),
  }))

  // ───────── the sessions pane ─────────

  function draftFor(id: string): { draft: Draft; picks?: number } {
    if (id === activeID() && cloth.picks.length) return { draft: activeDraft(), picks: cloth.picks.length - 1 }
    const s = state.info[id]
    const c = state.content[id]
    if (!s || !c?.loaded) return { draft: summaryDraft(s) }
    const picks = deriveCloth({
      session: s,
      messages: c.messages,
      parts: c.parts,
      seed: BLANK_SEED,
    })
    return {
      draft: draftOf(picks, !!readMeta(s).system),
      picks: picks.length - 1,
    }
  }

  const views = new Map<string, SessionView>()
  function viewOf(id: string): SessionView {
    const known = views.get(id)
    if (known) return known
    const shape = runWithOwner(owner, () => createMemo(() => draftFor(id)))!
    let last = state.info[id]
    const view: SessionView = {
      get session() {
        return (last = state.info[id] ?? last)
      },
      get draft() {
        return shape().draft
      },
      get picks() {
        return shape().picks
      },
      get children() {
        if (id !== activeID()) return undefined
        return Object.values(state.info)
          .filter((s) => s.parentID === id)
          .sort((a, b) => b.time.updated - a.time.updated)
          .map((s) => viewOf(s.id))
      },
    }
    views.set(id, view)
    return view
  }

  const engineView = createMemo<LoomView["engine"]>(() => {
    const engine = state.engine
    const version = "version" in engine ? engine.version : ""
    const kind = engine.state === "ready" ? "ready" : engine.state === "error" ? "error" : engine.state === "idle" ? "stopped" : "starting"
    return {
      version: version || "…",
      url: engine.state === "ready" ? engine.url : "",
      state: kind,
    }
  })

  const book = createMemo(() => ({
    directory: state.directory ?? "",
    branch: state.vcs?.branch,
    sessions: (state.directory ? (state.sessions[state.directory] ?? []) : []).map((s) => viewOf(s.id)),
    activeID: activeID(),
    engine: engineView(),
  }))

  async function sessionAction(view: SessionView, action: SessionAction) {
    const id = view.session.id
    try {
      switch (action) {
        case "rename":
          return openDialog({ kind: "rename", sessionID: id })
        case "delete":
          return openDialog({ kind: "delete", sessionID: id })
        case "fork": {
          const fork = await actions.forkSession(id)
          toast("Forked into a new session", "success")
          return open(fork.id)
        }
        case "archive": {
          const archived = !view.session.time.archived
          await actions.archiveSession(id, archived)
          return toast(archived ? "Session archived" : "Session restored", "success")
        }
        case "share": {
          const url = await actions.shareSession(id, !view.session.share)
          return url ? announceShared(url) : toast("Sharing stopped")
        }
        case "export":
          return saveSessionFile(actions, view.session)
      }
    } catch (error) {
      toastError(error)
    }
  }

  // ───────── the top pane ─────────

  const contextView = createMemo<ContextView>(() => {
    const picks = cloth.picks
    const s = session()
    const assistants = (content()?.messages ?? []).filter((m): m is AssistantMessage => m.role === "assistant")
    const summed = assistants.reduce(
      (t, m) => ({
        input: t.input + m.tokens.input,
        output: t.output + m.tokens.output,
        reasoning: t.reasoning + m.tokens.reasoning,
        cacheRead: t.cacheRead + m.tokens.cache.read,
        cacheWrite: t.cacheWrite + m.tokens.cache.write,
        cost: t.cost + m.cost,
      }),
      {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
    )
    const totals = s?.tokens
      ? {
          input: s.tokens.input,
          output: s.tokens.output,
          reasoning: s.tokens.reasoning,
          cacheRead: s.tokens.cache.read,
          cacheWrite: s.tokens.cache.write,
          cost: s.cost ?? summed.cost,
        }
      : summed
    const last = assistants.findLast((m) => m.tokens.input + m.tokens.output + m.tokens.cache.read > 0)
    const window = last
      ? last.tokens.input + last.tokens.cache.read + last.tokens.cache.write + last.tokens.output + last.tokens.reasoning
      : 0
    const woven = activeDraft().picks.filter((_, i) => !picks[i]?.muted && !picks[i]?.reverted)
    const weight = woven.reduce((a, p) => a + p.tokens, 0)
    const scale = window > 0 && weight > 0 ? window / weight : 1
    const limit = modelInfo()?.model.limit.context ?? 0
    return {
      limit,
      spent: woven.map((p) => ({
        dye: p.dye,
        tokens: Math.round(p.tokens * scale),
      })),
      ...totals,
    }
  })

  const lastReply = createMemo(() => latestReply(cloth.picks))

  const changed = createMemo<ChangedFile[]>(() => {
    const s = session()
    if (!s) return []
    const net = s.summary?.diffs
    if (net?.length)
      return net.map((d) => ({
        path: d.file ?? "",
        additions: d.additions,
        deletions: d.deletions,
        status: d.status,
      }))
    const merged = new Map<string, ChangedFile>()
    for (const message of content()?.messages ?? []) {
      if (message.role !== "user") continue
      for (const diff of message.summary?.diffs ?? []) {
        const path = diff.file ?? ""
        const before = merged.get(path)
        merged.set(path, {
          path,
          additions: (before?.additions ?? 0) + diff.additions,
          deletions: (before?.deletions ?? 0) + diff.deletions,
          status: before?.status === "added" ? "added" : diff.status,
        })
      }
    }
    return [...merged.values()]
  })

  // ───────── the prompt ─────────

  const agentNames = createMemo(() => state.agents.filter((a) => a.mode !== "subagent" && !a.hidden).map((a) => a.name))
  const agent = () => {
    const id = openSessionID()
    return (id ? state.choice[id]?.agent : unsaved().agent) || state.config?.default_agent || agentNames()[0] || "build"
  }
  const modelPill = () => {
    const ref = model()
    const variant = ref?.variant === "default" ? undefined : ref?.variant
    return {
      providerID: ref?.providerID ?? "",
      modelID: ref?.modelID ?? "",
      variant,
      name: modelInfo()?.model.name,
    }
  }

  // Looking at models or agents before a session exists must not leave an empty session in the shared database.
  function chooseModel() {
    const id = openSessionID()
    openDialog(id ? { kind: "model", sessionID: id } : { kind: "model" })
  }

  function chooseAgent(name: string) {
    const id = openSessionID()
    if (id) actions.setAgent(id, name)
    else setUnsaved((choice) => ({ ...choice, agent: name }))
  }

  // ───────── message actions (docs/DESIGN.md B.5) ─────────

  const offerStop = (sessionID: string) =>
    toast("The session is still running. Stop it, then try again.", "warn", {
      label: "Stop",
      run: () => actions.abort(sessionID).catch(toastError),
    })

  function guarded(run: (sessionID: string) => Promise<unknown>) {
    const id = activeID()
    if (!id) return
    run(id).catch((error) => (isBusy(error) ? offerStop(id) : toastError(error)))
  }

  // An undo in OpenCode keeps its messages for Redo until the next prompt, which deletes them (liberate.ts `revertedIDs`).
  const reverted = () => cloth.picks.filter((p) => p.reverted).length
  const theReverted = (n: number) => (n === 1 ? "the reverted message" : `the ${n} reverted messages`)
  /** G18: unrevert restores a snapshot, which in the home-folder project rewrites files across the whole home folder. */
  const unrevertBlocked = () => {
    const s = session()
    return !!s?.revert?.snapshot && s.projectID === "global" && state.projects.find((p) => p.id === "global")?.vcs === "git"
  }

  async function insertDropsReverted() {
    const count = reverted()
    if (count === 0) return true
    return ask({
      title: "Insert and drop the reverted messages?",
      confirm: "Delete and insert",
      danger: true,
      body: [
        `Inserting stores a new message, and the engine first deletes ${theReverted(count)} for good, as OpenCode does with anything sent after an undo.`,
        "To keep them, cancel and press Unrevert first.",
      ],
    })
  }

  const pickActions: PickActions = {
    save: (pick, edit) =>
      guarded(async (id) => {
        // Saving the default system prompt unchanged would freeze today's provider prompt into the session.
        if (pick.warp) return edit.text === pick.warp.template ? undefined : actions.editSystem(id, edit.text)
        if (edit.role !== pick.role) await actions.setRole(id, pick.id, edit.role)
        if (edit.resend) return actions.resendFrom(id, pick.id, edit.text, edit.partID)
        const part = pick.parts.find((p) => p.id === edit.partID)
        if (edit.partID && part && "text" in part && part.text !== edit.text) await actions.editPart(id, pick.id, edit.partID, edit.text)
      }),
    resetWarp: () => guarded((id) => actions.editSystem(id, undefined)),
    fork: (pick) =>
      guarded(async (id) => {
        const plan = forkPlan(state.content[id]?.messages ?? [], readMeta(state.info[id]), pick.id)
        const fork = await actions.forkSession(id, plan.fromMessageID, plan.drop)
        toast("Forked into a new session", "success")
        await open(fork.id)
      }),
    remove: (pick, keepReplies) => guarded((id) => actions.removeMessage(id, pick.id, keepReplies)),
    insertAfter: (pick, text, role) =>
      guarded(async (id) => {
        if (await insertDropsReverted()) await actions.insertAfter(id, pick.warp ? undefined : pick.id, text, role)
      }),
    setMuted: (pick, muted) => guarded((id) => actions.setMuted(id, pick.id, muted)),
    move: (pick, step) =>
      guarded(async (id) => {
        const woven = cloth.picks.filter((p) => !p.warp)
        const at = woven.findIndex((p) => p.id === pick.id)
        if (at < 0 || (step < 0 && at === 0)) return
        await actions.move(id, pick.id, step < 0 ? woven[at - 1].id : woven[at + 2]?.id)
      }),
    regenerate: (pick) => guarded((id) => actions.regenerate(id, pick.id)),
    openSession: (id) => void open(id),
  }

  /** The open session, then its subagent sessions: a request from any of them holds the open turn. */
  const lineage = createMemo(() => {
    const root = activeID()
    if (!root) return []
    const children = new Map<string, string[]>()
    for (const s of Object.values(state.info)) if (s.parentID) children.set(s.parentID, [...(children.get(s.parentID) ?? []), s.id])
    const ids = [root]
    for (let i = 0; i < ids.length; i++) for (const child of children.get(ids[i]) ?? []) if (!ids.includes(child)) ids.push(child)
    return ids
  })
  const permission = () => {
    for (const id of lineage()) {
      const request = state.permissions[id]?.[0]
      if (request) return request
    }
    return undefined
  }
  const asking = () => lineage().find((id) => state.questions[id]?.length) ?? activeID()
  const subagentOf = (sessionID: string | undefined) =>
    sessionID && sessionID !== activeID() ? state.info[sessionID]?.title || "a subagent" : undefined

  const error = () => {
    const id = activeID()
    const failure = id ? state.errors?.[id] : undefined
    return failure && dismissed()[id!] !== failure.at ? failure : undefined
  }

  function jumpTo(index: number) {
    setClothOpen(false)
    requestAnimationFrame(() =>
      document.querySelector(`article.pick[data-pick="${index}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    )
  }

  // ───────── keys and dev flags ─────────

  function onKey(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || overlayOpen()) return
    if (event.key.toLowerCase() === "n" && !event.shiftKey) {
      event.preventDefault()
      void newSession()
    } else if (event.key === "`") {
      event.preventDefault()
      setTerminalOpen(!terminalOpen())
    }
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => window.removeEventListener("keydown", onKey))

  const devDialog = devFlags.get("dialog") as DialogRequest["kind"] | null
  if (devDialog)
    createEffect(
      on(booted, (done) => {
        if (!done) return
        const id = activeID()
        if (devDialog === "model") openDialog({ kind: "model", sessionID: id })
        else if (devDialog === "rename" || devDialog === "delete") id && openDialog({ kind: devDialog, sessionID: id })
        else if (devDialog === "palette" || devDialog === "projects" || devDialog === "connect" || devDialog === "settings")
          openDialog({ kind: devDialog })
      }),
    )

  if (devFlags.has("toast"))
    createEffect(
      on(booted, (done) => {
        if (!done) return
        toast("Forked into a new session", "success")
        toast("The session is still running. Stop it, then try again.", "warn", { label: "Stop", run: () => undefined })
      }),
    )

  const unliberated = () => state.liberated === false || devFlags.has("unliberated")
  const [column, setColumn] = createSignal<HTMLElement>()

  return (
    <div class="app" classList={{ "book-closed": !bookOpen(), "draft-closed": !draftOpen() }}>
      <Water column={column} />
      <Show when={!booted()}>
        <Boot
          phase={bootPhase()}
          progress={bootProgress()}
          download={bootDownload()}
          detail={bootDetail()}
          failure={bootFailure()}
          onDone={() => setBooted(true)}
          onRetry={() => void actions.restartEngine().catch(toastError)}
          onSettings={() => openDialog({ kind: "settings", tab: "engine" })}
          onLogs={inTauri ? () => void openLogs().catch(toastError) : undefined}
          onCopy={() => void copyBootFailure().catch(toastError)}
        />
      </Show>
      <Titlebar
        title={session()?.title}
        directory={state.directory}
        live={busy()}
        bookOpen={bookOpen()}
        draftOpen={draftOpen()}
        clothOpen={clothOpen()}
        reviewOpen={reviewOpen()}
        terminalOpen={terminalOpen()}
        onBook={() => setBookOpen(!bookOpen())}
        onDraft={() => setDraftOpen(!draftOpen())}
        onCloth={() => setClothOpen(!clothOpen())}
        onReview={() => setReviewOpen(!reviewOpen())}
        onTerminal={() => setTerminalOpen(!terminalOpen())}
      />
      <Show when={bookOpen()}>
        <SwatchBook
          loom={book()}
          onOpen={(id) => void open(id)}
          onNew={() => void newSession()}
          onProject={() => openDialog({ kind: "projects" })}
          onSettings={() => openDialog({ kind: "settings" })}
          onAction={(view, action) => void sessionAction(view, action)}
        />
      </Show>
      <main class="loom">
        <Cloth
          picks={cloth.picks}
          permission={permission()}
          permissionFrom={subagentOf(permission()?.sessionID)}
          root={state.directory}
          actions={pickActions}
          busy={busy()}
          onPermission={(reply) => {
            const request = permission()
            if (request) void actions.replyPermission(request.sessionID, request.id, reply).catch(toastError)
          }}
          empty={
            <EmptyLoom
              hint={session() ? undefined : state.directory ? "Write something and a new session begins." : "Open a project folder to begin."}
            />
          }
          onColumn={setColumn}
          head={
            <Show when={session()}>
              {(s) => (
                <SessionHead
                  id={s().id}
                  title={s().title}
                  draft={draftOf(cloth.picks, !!readMeta(s()).system)}
                  created={s().time.created}
                  updated={s().time.updated}
                  model={modelPill().name ?? (modelPill().modelID || undefined)}
                />
              )}
            </Show>
          }
          notice={
            <>
              <Show when={error()}>
                {(failure) => (
                  <div class="notice-band" role="alert">
                    <span class="label">Error</span>
                    <span class="notice-text selectable">{failure().message}</span>
                    <button
                      class="btn ghost"
                      onClick={() =>
                        setDismissed((all) => ({
                          ...all,
                          [activeID()!]: failure().at,
                        }))
                      }
                      aria-label="Dismiss error"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </Show>
              <Show when={reverted()}>
                {(count) => (
                  <div class="notice-band" role="status">
                    <span class="label">Undone</span>
                    <span class="notice-text">
                      {count() === 1 ? "1 message was" : `${count()} messages were`} undone in OpenCode and kept for its Redo. Anything sent next
                      (a message, a command, a compaction, an inserted message) deletes {count() === 1 ? "it" : "them"} for good, as OpenCode
                      does.
                    </span>
                    <button
                      class="btn ghost"
                      disabled={busy() || unrevertBlocked()}
                      title={
                        unrevertBlocked()
                          ? "Off for the home-folder project: unrevert would restore files across the whole home folder"
                          : "Bring the reverted messages back (OpenCode's Redo)"
                      }
                      onClick={() => guarded((id) => actions.unrevert(id))}
                    >
                      Unrevert
                    </button>
                  </div>
                )}
              </Show>
            </>
          }
          banner={
            <>
              <Show when={state.engine.state === "ready" && state.engine.notice}>
                {(notice) => (
                  <div class="liberation-banner" role="status">
                    <span class="label">Engine</span>
                    <span>{notice()}</span>
                  </div>
                )}
              </Show>
              <Show when={unliberated()}>
                <div class="liberation-banner" role="status">
                  <span class="label">Plugin not loaded</span>
                  <span>Edits are saved, but the engine plugin is not loaded, so the model sees the original conversation.</span>
                  <button class="btn ghost" onClick={() => openDialog({ kind: "settings", tab: "liberation" })}>
                    Details
                  </button>
                </div>
              </Show>
            </>
          }
          hasOlder={content()?.hasOlder}
          loadingOlder={content()?.loadingOlder}
          onOlder={() => {
            const id = activeID()
            return id ? actions.loadOlder(id).catch(toastError) : undefined
          }}
        >
          <Show when={asking()}>{(id) => <QuestionDock sessionID={id()} />}</Show>
          <Fell
            context={contextView()}
            reply={lastReply()}
            agent={agent()}
            agents={agentNames()}
            model={modelPill()}
            sessionID={activeID()}
            onAgent={(name) => void chooseAgent(name)}
            onModel={() => void chooseModel()}
            onSession={ensureSession}
          />
        </Cloth>
        <Show when={reviewOpen()}>
          <Review sessionID={activeID()} onClose={() => setReviewOpen(false)} />
        </Show>
        <Show when={terminalOpen()}>
          <Terminal onClose={() => setTerminalOpen(false)} />
        </Show>
        <Show when={clothOpen() && session()}>
          <History picks={cloth.picks} title={session()?.title} onClose={() => setClothOpen(false)} onJump={jumpTo} />
        </Show>
      </main>
      <Show when={draftOpen()}>
        <DraftPanel
          loom={{
            context: contextView(),
            changed: changed(),
            engine: engineView(),
          }}
          todos={(activeID() && state.todos[activeID()!]) || []}
        />
      </Show>
      <DialogHost sessionID={activeID()} onSession={(id) => void open(id)} onNewSession={() => void newSession()} />
      <Toaster />
    </div>
  )
}
