// Liberation (docs/DESIGN.md B.5): the `metadata.weft` schema, the cloth derivation and every edit
// operation. Type-only imports keep it loadable by plain Node for tools/e2e-liberation.mjs.
import type { Message, Part, Session, TextPart, UserMessage } from "@opencode-ai/sdk/v2/types"
import type { Actions, Http, SessionContent } from "./contract"
import { buildSeam, seamProblem, type Seam } from "./seam"
import type { Mend, PickView, Role } from "./view"

export type WeftMeta = {
  v: 1
  system?: { text: string; seed?: string; at?: number }
  roles?: Record<string, Role>
  order?: Record<string, number>
  muted?: Record<string, true>
  thought?: Record<string, true>
  mends?: Record<string, Mend[]>
  /** the hand-off card pinned at the end of the system prompt, and the message it starts keeping from */
  seam?: Seam
}

/** The pieces opencode joins into its system prompt, as split by the plugin. */
export type Segments = {
  prompt: string
  environment: string
  references: string
  instructions: string
  mcp: string
  skills: string
  structuredOutput: string
  clientSystem: string
}

/** What the plugin recorded about the session's last main-loop call (`<observed>/<sessionID>.json`). */
export type Observed = {
  at: number
  version: string
  model: string
  exact: boolean
  segments: Segments
  rewritten: boolean
  sent: string
}

/** A vendored provider prompt (src/engine/prompts.ts `seedFor`). */
export type Seed = { file: string; text: string }

export type LiberationActions = Pick<
  Actions,
  | "editPart"
  | "setRole"
  | "editSystem"
  | "removeMessage"
  | "removePart"
  | "setMuted"
  | "insertAfter"
  | "move"
  | "resendFrom"
  | "regenerate"
  | "seamPreview"
  | "seamSession"
  | "unseamSession"
>

type Entry = { info: Message; parts: Part[] }

/** Id of the virtual pick 00 (the system prompt), also the key of its mends. */
export const WARP_ID = "warp"
const MEND_LIMIT = 8
/** Calls this close together are one edit (Save with a new text and a new role): one mend. */
const MEND_GESTURE_MS = 2_000

const SEGMENT_OF = {
  prompt: "prompt",
  environment: "environment",
  references: "references",
  instructions: "instructions",
  mcp: "mcp",
  skills: "skills",
  structured_output: "structuredOutput",
  client_system: "clientSystem",
} as const satisfies Record<string, keyof Segments>

export type Placeholder = keyof typeof SEGMENT_OF | "opencode"

export const PLACEHOLDERS: Placeholder[] = [...(Object.keys(SEGMENT_OF) as (keyof typeof SEGMENT_OF)[]), "opencode"]

/** The placeholder lines that follow the provider prompt in a seeded pick 00. */
export const SEED_TAIL = PLACEHOLDERS.filter((name) => name !== "prompt" && name !== "opencode")
  .map((name) => `{{${name}}}`)
  .join("\n")

const KIMI_PROVIDERS = ["kimi-for-coding", "moonshotai", "moonshotai-cn"]

/** opencode 1.19.1 `SystemPrompt.provider` (src/session/system.ts:28-51): the provider prompt file a model gets. */
export function providerPromptFile(model: { providerID: string; apiID: string }): { file: string; modelName?: string } {
  const id = model.apiID
  if (id.includes("muse")) return { file: "meta.txt", modelName: id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark" }
  if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return { file: "beast.txt" }
  if (id.includes("gpt")) {
    if (id.includes("gpt-6")) return { file: "gpt-astra.txt" }
    return { file: id.includes("codex") ? "codex.txt" : "gpt.txt" }
  }
  if (id.includes("gemini-")) return { file: "gemini.txt" }
  if (id.includes("claude")) return { file: "anthropic.txt" }
  if (id.toLowerCase().includes("trinity")) return { file: "trinity.txt" }
  if (id.toLowerCase().includes("kimi") || KIMI_PROVIDERS.includes(model.providerID)) return { file: "kimi.txt" }
  return { file: "default.txt" }
}

export function readMeta(session: Pick<Session, "metadata"> | undefined): WeftMeta {
  const weft = session?.metadata?.weft as WeftMeta | undefined
  return weft?.v === 1 ? weft : { v: 1 }
}

function compactMeta(meta: WeftMeta): WeftMeta {
  const filled = <T>(record: Record<string, T> | undefined) => (record && Object.keys(record).length > 0 ? record : undefined)
  const next: WeftMeta = { v: 1 }
  if (meta.system) next.system = meta.system
  const roles = filled(meta.roles)
  const order = filled(meta.order)
  const muted = filled(meta.muted)
  const thought = filled(meta.thought)
  const mends = filled(meta.mends)
  if (roles) next.roles = roles
  if (order) next.order = order
  if (muted) next.muted = muted
  if (thought) next.thought = thought
  if (mends) next.mends = mends
  if (meta.seam) next.seam = meta.seam
  return next
}

const writing = new Map<string, Promise<unknown>>()

/**
 * Read-modify-write of `metadata.weft`. PATCH /session/:id replaces the whole metadata record
 * (opencode 1.19.1 session.ts setMetadata), so the other keys are read fresh and sent back.
 * Writes to one session run one at a time; `change` edits the draft or returns a replacement.
 */
export function writeMeta(http: Http, sessionID: string, change: (meta: WeftMeta) => WeftMeta | void, directory?: string): Promise<Session> {
  const run = async () => {
    const { data: session } = await http.get<Session>(`/session/${sessionID}`, { directory })
    const before = compactMeta(readMeta(session))
    const draft = structuredClone(before)
    const after = compactMeta(change(draft) ?? draft)
    if (JSON.stringify(after) === JSON.stringify(before)) return session
    const metadata = { ...session.metadata, weft: after }
    const { data } = await http.patch<Session>(`/session/${sessionID}`, { directory, body: { metadata } })
    return data
  }
  const queued = (writing.get(sessionID) ?? Promise.resolve()).then(run, run)
  const settled = () => {
    if (writing.get(sessionID) === queued) writing.delete(sessionID)
  }
  writing.set(sessionID, queued)
  queued.then(settled, settled)
  return queued
}

/** Messages in cloth order: by `order[id]` (unordered ones after all ordered), then stored order. */
export function clothOrder<T extends { id: string }>(messages: T[], meta: WeftMeta): T[] {
  const order = meta.order ?? {}
  return messages
    .map((message, index) => ({ message, index, key: order[message.id] ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key))
    .map((item) => item.message)
}

/** Message ids in cloth order, including ordered ids the store has not received yet. */
function orderedIDs(messages: Message[], meta: WeftMeta) {
  const known = new Set(messages.map((m) => m.id))
  const pending = Object.keys(meta.order ?? {})
    .filter((id) => !known.has(id))
    .map((id) => ({ id }))
  return clothOrder([...messages, ...pending], meta).map((m) => m.id)
}

const MESSAGE_GONE = "This message is no longer in the session. Reload it and try again."

/** An error worded for the user; the ids it leaves out go to the console. */
function userError(message: string, detail: string) {
  console.warn(`[weft] ${detail}`)
  return new Error(message)
}

const sequence = (ids: string[]) => Object.fromEntries(ids.map((id, index) => [id, index]))

const byCreated = (a: Message, b: Message) => a.time.created - b.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const isProse = (part: Part): part is TextPart => part.type === "text" && !part.synthetic && !part.ignored

const proseOf = (parts: Part[]) =>
  parts
    .filter(isProse)
    .map((p) => p.text)
    .join("\n\n")

const shown = (part: Part) =>
  part.type === "text" ? !part.synthetic && !part.ignored : part.type === "reasoning" || part.type === "tool" || part.type === "file"

function pushMend(meta: WeftMeta, id: string, mend: Mend) {
  const mends = (meta.mends ??= {})
  const list = mends[id] ?? []
  const last = list[list.length - 1]
  if (last && mend.at - last.at < MEND_GESTURE_MS) return
  mends[id] = [...list, mend].slice(-MEND_LIMIT)
}

function forget(meta: WeftMeta, messageIDs: string[], partIDs: string[]) {
  for (const id of messageIDs) {
    delete meta.roles?.[id]
    delete meta.order?.[id]
    delete meta.muted?.[id]
    delete meta.mends?.[id]
  }
  for (const id of partIDs) delete meta.thought?.[id]
}

function placeholderValues(observed: Observed): Record<string, string> {
  const s = observed.segments
  const values: Record<string, string> = Object.fromEntries(Object.entries(SEGMENT_OF).map(([name, key]) => [name, s[key]]))
  const order: (keyof Segments)[] = ["prompt", "environment", "references", "instructions", "mcp", "skills", "structuredOutput", "clientSystem"]
  values.opencode = observed.rewritten
    ? order
        .map((key) => s[key])
        .filter(Boolean)
        .join("\n")
    : observed.sent
  return values
}

function warpPick(session: Session, meta: WeftMeta, seed: Seed, observed?: Observed): PickView {
  const template = meta.system?.text ?? `${seed.text}\n${SEED_TAIL}`
  const file = meta.system ? meta.system.seed : seed.file
  const info: UserMessage = {
    id: WARP_ID,
    sessionID: session.id,
    role: "user",
    time: { created: session.time.created },
    agent: session.agent ?? "",
    model: { providerID: session.model?.providerID ?? "", modelID: session.model?.id ?? "" },
  }
  return {
    id: WARP_ID,
    role: "system",
    info,
    parts: [{ id: WARP_ID, sessionID: session.id, messageID: WARP_ID, type: "text", text: template }],
    mends: meta.mends?.[WARP_ID],
    source: meta.system ? (file ? `rewritten · ${file}` : "rewritten") : `default · ${seed.file}`,
    warp: {
      template,
      rewritten: !!meta.system,
      file,
      values: observed && placeholderValues(observed),
      observedAt: observed?.at,
      exact: observed?.exact,
    },
  }
}

/**
 * The messages an undo in OpenCode left for its Redo: opencode 1.19.1 deletes them, in stored order from
 * `revert.messageID` on, before it runs any prompt (session/revert.ts `cleanup`).
 */
export function revertedIDs(messages: Message[], revert: Session["revert"]): Set<string> {
  const at = revert ? messages.findIndex((m) => m.id === revert.messageID) : -1
  if (at < 0) return new Set()
  return new Set(messages.slice(at + (revert?.partID ? 1 : 0)).map((m) => m.id))
}

/** The cloth: pick 00 (the system prompt) followed by every stored message as the model will see it. */
export function deriveCloth(input: {
  session: Session
  messages: Message[]
  parts: Record<string, Part[]>
  seed: Seed
  observed?: Observed
}): PickView[] {
  const meta = readMeta(input.session)
  const newest = input.messages[input.messages.length - 1]
  const reverted = revertedIDs(input.messages, input.session.revert)
  const seamAt = meta.seam ? input.messages.findIndex((m) => m.id === meta.seam?.keepFrom) : -1
  const seamOf = new Map(input.messages.map((m, index) => [m.id, seamAt >= 0 && index < seamAt]))
  const replies = new Map<string, number>()
  for (const m of input.messages) if (m.role === "assistant") replies.set(m.parentID, (replies.get(m.parentID) ?? 0) + 1)
  const picks = clothOrder(input.messages, meta).flatMap((info): PickView[] => {
    const stored = input.parts[info.id] ?? []
    if (info.role === "user" && stored.length === 0) return []
    const undone = reverted.has(info.id)
    const live = !undone && info.id === newest?.id && info.role === "assistant" && info.time.completed === undefined && !info.error
    const answers = info.role === "user" ? replies.get(info.id) : undefined
    return [
      {
        id: info.id,
        role: meta.roles?.[info.id] ?? info.role,
        info,
        parts: stored.filter(shown),
        ...(live && { live }),
         ...(meta.mends?.[info.id] && { mends: meta.mends[info.id] }),
         ...(meta.muted?.[info.id] && { muted: true }),
         ...(seamOf.get(info.id) && { seam: true }),
         ...(undone && { reverted: true }),
        ...(answers && { replies: answers }),
      },
    ]
  })
  return [warpPick(input.session, meta, input.seed, input.observed), ...picks]
}

/** Old → new message and part ids of a fork: opencode copies in list order with fresh ascending ids. */
export function forkIdMap(source: Entry[], fork: Entry[], fromMessageID?: string): Map<string, string> {
  const end = fromMessageID ? source.findIndex((m) => m.info.id === fromMessageID) : -1
  const copied = end < 0 ? source : source.slice(0, end)
  const ids = new Map<string, string>()
  if (copied.length !== fork.length) return ids
  const byID = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const twins = [...fork].sort((a, b) => byID(a.info, b.info))
  copied.forEach((entry, index) => {
    const twin = twins[index]
    if (twin.info.role !== entry.info.role) return
    ids.set(entry.info.id, twin.info.id)
    const twinParts = [...twin.parts].sort(byID)
    entry.parts.forEach((part, j) => {
      if (twinParts[j]) ids.set(part.id, twinParts[j].id)
    })
  })
  return ids
}

/** `metadata.weft` for a fork: entries keyed by ids that survived, renamed to their copies. */
export function copyMetaForFork(meta: WeftMeta, survivingIds: ReadonlyMap<string, string>): WeftMeta {
  const carry = <T>(record: Record<string, T> | undefined) =>
    record &&
    Object.fromEntries(
      Object.entries(record).flatMap(([id, value]) => {
        const next = id === WARP_ID ? id : survivingIds.get(id)
        return next ? [[next, value] as const] : []
      }),
    )
  const keepFrom = meta.seam && survivingIds.get(meta.seam.keepFrom)
  return compactMeta({
    v: 1,
    system: meta.system,
    roles: carry(meta.roles),
    order: carry(meta.order),
    muted: carry(meta.muted),
    thought: carry(meta.thought),
    mends: carry(meta.mends),
    ...(meta.seam && keepFrom && { seam: { ...meta.seam, keepFrom } }),
  })
}

/**
 * "Fork from here" in cloth terms. opencode forks a stored prefix, so the cut has to keep every
 * message up to the last one the cloth shows at or above the pick; the copies of the messages the
 * cloth shows below it (`drop`) are deleted from the fork afterwards.
 */
export function forkPlan(messages: Message[], meta: WeftMeta, pickID: string): { fromMessageID?: string; drop: string[] } {
  const cloth = clothOrder(messages, meta)
  const at = cloth.findIndex((m) => m.id === pickID)
  if (at < 0) return { drop: [] }
  const kept = new Set(cloth.slice(0, at + 1).map((m) => m.id))
  const last = messages.findLastIndex((m) => kept.has(m.id))
  return {
    fromMessageID: messages[last + 1]?.id,
    drop: messages
      .slice(0, last + 1)
      .filter((m) => !kept.has(m.id))
      .map((m) => m.id),
  }
}

/**
 * After `POST /session/:id/fork`: deletes the copies of the `drop` messages (see `forkPlan`) and
 * rewrites the copied `metadata.weft` onto the fork's own ids.
 */
export async function carryMetaToFork(
  http: Http,
  sourceID: string,
  fork: Session,
  fromMessageID?: string,
  directory?: string,
  drop: string[] = [],
): Promise<Session> {
  const { data: source } = await http.get<Session>(`/session/${sourceID}`, { directory })
  const meta = compactMeta(readMeta(source))
  if (Object.keys(meta).length === 1 && drop.length === 0) return fork
  const [from, to] = await Promise.all([
    http.get<Entry[]>(`/session/${sourceID}/message`, { directory }),
    http.get<Entry[]>(`/session/${fork.id}/message`, { directory }),
  ])
  const ids = forkIdMap(from.data, to.data, fromMessageID)
  for (const entry of from.data.filter((e) => drop.includes(e.info.id))) {
    const twin = ids.get(entry.info.id)
    if (!twin) continue
    await http.del(`/session/${fork.id}/message/${twin}`, { directory })
    for (const id of [entry.info.id, ...entry.parts.map((p) => p.id)]) ids.delete(id)
  }
  const carried = copyMetaForFork(meta, ids)
  return writeMeta(http, fork.id, () => carried, directory)
}

/** The session is running a turn: DELETE answers 409 SessionBusyError (offer Stop first). */
export const isBusy = (error: unknown) => (error as { status?: unknown } | null)?.status === 409

export function createLiberation(deps: {
  http: Http
  info: (sessionID: string) => Session | undefined
  content: (sessionID: string) => SessionContent | undefined
  directory: (sessionID: string) => string | undefined
  continueSession: (sessionID: string) => Promise<void>
  /** the chosen model's context window, for sizing the verbatim tail */
  limit?: (sessionID: string) => number | undefined
  /** a turn is running: a seam is only taken between turns */
  busy?: (sessionID: string) => boolean
}): LiberationActions {
  const { http } = deps
  const scope = (sessionID: string) => ({ directory: deps.directory(sessionID) })
  const remember = async (sessionID: string, change: (meta: WeftMeta) => void) => {
    await writeMeta(http, sessionID, change, deps.directory(sessionID))
  }
  const messagePath = (sessionID: string, messageID: string) => `/session/${sessionID}/message/${messageID}`
  const partPath = (sessionID: string, messageID: string, partID: string) => `${messagePath(sessionID, messageID)}/part/${partID}`

  function loaded(sessionID: string) {
    const content = deps.content(sessionID)
    if (!content) throw userError("This session is not loaded. Open it again and retry.", `session ${sessionID} is not loaded`)
    return content
  }

  function located(sessionID: string, messageID: string) {
    const content = loaded(sessionID)
    const info = content.messages.find((m) => m.id === messageID)
    if (!info) throw userError(MESSAGE_GONE, `message ${messageID} is not in session ${sessionID}`)
    return { content, info, parts: content.parts[messageID] ?? [] }
  }

  const newestUser = (content: SessionContent) =>
    content.messages.findLast((m): m is UserMessage => m.role === "user")

  function seedFile(sessionID: string) {
    const content = deps.content(sessionID)
    const model = content && newestUser(content)?.model
    if (model) return providerPromptFile({ providerID: model.providerID, apiID: model.modelID }).file
    const chosen = deps.info(sessionID)?.model
    return chosen && providerPromptFile({ providerID: chosen.providerID, apiID: chosen.id }).file
  }

  type History = Pick<SessionContent, "messages" | "parts">

  /** Every stored message: `order` written from the loaded pages alone would push the older ones to the end. */
  async function history(sessionID: string): Promise<History> {
    const content = loaded(sessionID)
    if (!content.hasOlder) return content
    const { data } = await http.get<Entry[]>(`/session/${sessionID}/message`, scope(sessionID))
    const entries = [...data].sort((a, b) => byCreated(a.info, b.info))
    return { messages: entries.map((e) => e.info), parts: Object.fromEntries(entries.map((e) => [e.info.id, e.parts])) }
  }

  async function freshSession(sessionID: string) {
    await writing.get(sessionID)?.catch(() => undefined)
    const { data } = await http.get<Session>(`/session/${sessionID}`, scope(sessionID))
    return data
  }

  /** A prompt from a reverted pick would have opencode delete that very pick first (`revertedIDs`). */
  function refuseReverted(session: Session, messages: Message[], messageID: string) {
    if (revertedIDs(messages, session.revert).has(messageID))
      throw new Error("This message was undone in OpenCode. Press Unrevert first: anything sent now deletes it.")
  }

  async function removeMessages(sessionID: string, content: History, messageIDs: string[]) {
    for (const id of messageIDs) await http.del(messagePath(sessionID, id), scope(sessionID))
    return messageIDs.flatMap((id) => (content.parts[id] ?? []).map((p) => p.id))
  }

  /** Every message from `messageID` on, in cloth order over the whole history (not just the loaded page). */
  async function clothTail(sessionID: string, messageID: string) {
    const all = await history(sessionID)
    const session = await freshSession(sessionID)
    refuseReverted(session, all.messages, messageID)
    const ids = clothOrder(all.messages, readMeta(session)).map((m) => m.id)
    const at = ids.indexOf(messageID)
    if (at < 0) throw userError(MESSAGE_GONE, `message ${messageID} is no longer in session ${sessionID}`)
    return { all, tail: ids.slice(at) }
  }

  return {
    async editPart(sessionID, messageID, partID, text) {
      const { info, parts } = located(sessionID, messageID)
      const part = parts.find((p) => p.id === partID)
      if (!part || (part.type !== "text" && part.type !== "reasoning")) throw new Error("Only text and reasoning can be edited")
      if (part.text === text) return
      const before = proseOf(parts)
      const { metadata, ...rest } = part
      const keepMetadata = part.type === "text" && info.role === "user" && metadata
      await http.patch(partPath(sessionID, messageID, partID), {
        ...scope(sessionID),
        body: { ...rest, ...(keepMetadata && { metadata }), text },
      })
      await remember(sessionID, (meta) => {
        if (part.type === "reasoning") (meta.thought ??= {})[partID] = true
        else pushMend(meta, messageID, { text: before, role: meta.roles?.[messageID] ?? info.role, at: Date.now() })
      })
    },

    async setRole(sessionID, messageID, role) {
      const { info, parts } = located(sessionID, messageID)
      await remember(sessionID, (meta) => {
        const current = meta.roles?.[messageID] ?? info.role
        if (current === role) return
        pushMend(meta, messageID, { text: proseOf(parts), role: current, at: Date.now() })
        if (role === info.role) delete meta.roles?.[messageID]
        else (meta.roles ??= {})[messageID] = role
      })
    },

    async editSystem(sessionID, template) {
      const seed = seedFile(sessionID)
      await remember(sessionID, (meta) => {
        const previous = meta.system?.text
        if (previous === template) return
        if (previous !== undefined) pushMend(meta, WARP_ID, { text: previous, role: "system", at: Date.now() })
        if (template === undefined) delete meta.system
        else meta.system = { text: template, seed: meta.system?.seed ?? seed, at: Date.now() }
      })
    },

    async removeMessage(sessionID, messageID, keepReplies) {
      const content = loaded(sessionID)
      const replies = keepReplies ? [] : content.messages.filter((m) => m.role === "assistant" && m.parentID === messageID).map((m) => m.id)
      const doomed = [...replies.reverse(), messageID]
      const partIDs = await removeMessages(sessionID, content, doomed)
      await remember(sessionID, (meta) => forget(meta, doomed, partIDs))
    },

    async removePart(sessionID, messageID, partID) {
      await http.del(partPath(sessionID, messageID, partID), scope(sessionID))
      await remember(sessionID, (meta) => forget(meta, [], [partID]))
    },

    async setMuted(sessionID, messageID, muted) {
      await remember(sessionID, (meta) => {
        if (muted) (meta.muted ??= {})[messageID] = true
        else delete meta.muted?.[messageID]
      })
    },

    async insertAfter(sessionID, afterMessageID, text, role) {
      const content = loaded(sessionID)
      if (afterMessageID !== undefined && !content.messages.some((m) => m.id === afterMessageID))
        throw userError(MESSAGE_GONE, `message ${afterMessageID} is not in session ${sessionID}`)
      if (afterMessageID !== undefined) refuseReverted(await freshSession(sessionID), (await history(sessionID)).messages, afterMessageID)
      const latest = newestUser(content)
      const { data } = await http.post<Entry>(`/session/${sessionID}/message`, {
        ...scope(sessionID),
        body: {
          noReply: true,
          ...(latest && { agent: latest.agent, model: { providerID: latest.model.providerID, modelID: latest.model.modelID } }),
          parts: [{ type: "text", text }],
        },
      })
      const inserted = data.info.id
      const others = (await history(sessionID)).messages.filter((m) => m.id !== inserted)
      await remember(sessionID, (meta) => {
        const ids = orderedIDs(others, meta).filter((id) => id !== inserted)
        ids.splice(afterMessageID === undefined ? 0 : ids.indexOf(afterMessageID) + 1, 0, inserted)
        meta.order = sequence(ids)
        if (role !== "user") (meta.roles ??= {})[inserted] = role
      })
    },

    async move(sessionID, messageID, beforeMessageID) {
      const { messages } = await history(sessionID)
      await remember(sessionID, (meta) => {
        const ids = orderedIDs(messages, meta).filter((id) => id !== messageID)
        const at = beforeMessageID === undefined ? ids.length : ids.indexOf(beforeMessageID)
        if (at < 0) throw userError(MESSAGE_GONE, `message ${beforeMessageID} is not in session ${sessionID}`)
        ids.splice(at, 0, messageID)
        meta.order = sequence(ids)
      })
    },

    async resendFrom(sessionID, userMessageID, text, partID) {
      const { info, parts } = located(sessionID, userMessageID)
      const prose = parts.filter(isProse)
      if (prose.length === 0 && parts.length === 0) throw new Error("This message has nothing to resend.")
      const { all, tail } = await clothTail(sessionID, userMessageID)
      const later = tail.slice(1)
      const laterParts = await removeMessages(sessionID, all, later)
      const before = proseOf(parts)
      const target = prose.find((p) => p.id === partID) ??
        prose[0] ?? {
          id: `${parts.reduce((max, p) => (p.id > max ? p.id : max), parts[0].id)}0`,
          sessionID,
          messageID: userMessageID,
          type: "text" as const,
          text: "",
        }
      const edited = target.text !== text
      if (edited) await http.patch(partPath(sessionID, userMessageID, target.id), { ...scope(sessionID), body: { ...target, text } })
      await remember(sessionID, (meta) => {
        forget(meta, later, laterParts)
        if (edited) pushMend(meta, userMessageID, { text: before, role: meta.roles?.[userMessageID] ?? info.role, at: Date.now() })
      })
      await deps.continueSession(sessionID)
    },

    async regenerate(sessionID, assistantID) {
      const { all, tail } = await clothTail(sessionID, assistantID)
      const doomed = [...tail].reverse()
      const doomedParts = await removeMessages(sessionID, all, doomed)
      await remember(sessionID, (meta) => forget(meta, doomed, doomedParts))
      await deps.continueSession(sessionID)
    },

    async seamPreview(sessionID, keepFrom) {
      const all = await history(sessionID)
      return buildSeam({ messages: all.messages, parts: all.parts, keepFrom, limit: deps.limit?.(sessionID) })
    },

    async seamSession(sessionID, keepFrom, card) {
      if (deps.busy?.(sessionID)) throw new Error("Wait for the turn to end: a seam is taken between turns.")
      const all = await history(sessionID)
      const session = await freshSession(sessionID)
      const seam = buildSeam({ messages: all.messages, parts: all.parts, keepFrom, card, limit: deps.limit?.(sessionID) })
      if (revertedIDs(all.messages, session.revert).has(seam.keepFrom))
        throw new Error("This message was undone in OpenCode. Press Unrevert first: the next prompt deletes it.")
      const problem = seamProblem(seam, all.messages)
      if (problem) throw new Error(problem)
      await remember(sessionID, (meta) => {
        meta.seam = seam
      })
      return seam
    },

    async unseamSession(sessionID) {
      await remember(sessionID, (meta) => {
        delete meta.seam
      })
    },
  }
}
