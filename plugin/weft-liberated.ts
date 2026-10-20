// Weft liberation plugin for the opencode engine (loaded only by the engine Weft starts, through the
// OPENCODE_CONFIG_CONTENT Weft passes it). It applies the session's `metadata.weft` to every model call:
//   system  -> replaces the system prompt; {{prompt}}, {{environment}}, {{references}},
//              {{instructions}}, {{mcp}}, {{skills}}, {{structured_output}}, {{client_system}}
//              expand to the segments opencode itself built, {{opencode}} to all of it
//   roles   -> per-message role override (user <-> assistant, or system as a <system-reminder>)
//   order   -> per-message sort key (inserted and reordered messages)
//   muted   -> messages kept in the session but left out of the model's context
//   thought -> reasoning parts that were edited; they are sent as plain text, because the
//              provider's signature no longer matches the text
// Storage is never touched: the hooks only change what the model sees.
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Transform = NonNullable<Hooks["experimental.chat.messages.transform"]>
type WithParts = Parameters<Transform>[1]["messages"][number]
type AnyPart = WithParts["parts"][number]
type Role = "system" | "user" | "assistant"

export type WeftMeta = {
  v: 1
  system?: { text: string; seed?: string; at?: number }
  roles?: Record<string, Role>
  order?: Record<string, number>
  muted?: Record<string, true>
  thought?: Record<string, true>
}

const VERSION = "weft-liberated/1"

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

const ORDER: (keyof Segments)[] = ["prompt", "environment", "references", "instructions", "mcp", "skills", "structuredOutput", "clientSystem"]

const ENV_RE =
  /(?:^|\n)(You are powered by the model named (?<apiID>[^\n]*)\. The exact model ID is (?<providerID>[^\n]*?)\/\k<apiID>\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: [^\n]*\n  Workspace root folder: [^\n]*\n  Is directory a git repo: (?:yes|no)\n  Platform: [^\n]*\n  Today's date: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} -?\d{4,6}\n<\/env>)/g
const REFERENCES_RE =
  /^\n(Project references provide additional directories that can be accessed when relevant\.\n<available_references>\n(?:  <reference>\n    <name>[^\n]*<\/name>\n    <path>[^\n]*<\/path>\n(?:    <description>[\s\S]*?<\/description>\n)?  <\/reference>\n)*<\/available_references>)/
const MCP_HEAD = "\n<mcp_instructions>\n"
const MCP_RE = /^\n(<mcp_instructions>\n(?:  <server name="[^\n]*">\n(?:    [^\n]*\n)*  <\/server>\n)+<\/mcp_instructions>)/
const SKILLS_HEAD = "\nSkills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description.\n"
const SKILLS_RE =
  /^\n(Skills provide specialized instructions and workflows for specific tasks\.\nUse the skill tool to load a skill when a task matches its description\.\n(?:No skills are currently available\.|<available_skills>\n(?:  <skill>\n    <name>[^\n]*<\/name>\n    <description>[\s\S]*?<\/description>\n    <location>[^\n]*<\/location>\n  <\/skill>\n)*<\/available_skills>))/
const STRUCTURED =
  "IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema."

type Model = { providerID: string; api: { id: string } }

function findEnv(joined: string, model: Model) {
  for (const m of joined.matchAll(ENV_RE)) {
    if (m.groups?.apiID !== model.api.id || m.groups?.providerID !== model.providerID) continue
    const start = m.index! + (m[0].startsWith("\n") ? 1 : 0)
    return { start, end: start + m[1].length, text: m[1] }
  }
}

/** Finds the last block whose header appears in `rest` and whose regex validates from there. */
function lastBlock(rest: string, head: string, re: RegExp, mustEnd: boolean) {
  for (let at = rest.lastIndexOf(head); at >= 0; at = rest.lastIndexOf(head, at - 1)) {
    const m = re.exec(rest.slice(at))
    if (m && (!mustEnd || m[0].length === rest.length - at)) return { at, len: m[0].length, text: m[1] }
    if (at === 0) break
  }
}

/**
 * Splits opencode's joined system string into the segments its builder concatenated
 * (opencode 1.19.1 src/session/system.ts and instruction.ts). Undefined when the call is not
 * a main-loop call for `model`; `exact` is false when the split does not rejoin byte for byte.
 */
export function parseSystem(joined: string, model: Model, clientSystem?: string) {
  const env = findEnv(joined, model)
  if (!env) return undefined
  const seg: Segments = { prompt: "", environment: env.text, references: "", instructions: "", mcp: "", skills: "", structuredOutput: "", clientSystem: "" }
  seg.prompt = env.start > 0 ? joined.slice(0, env.start - 1) : ""
  let rest = joined.slice(env.end)
  const refs = REFERENCES_RE.exec(rest)
  if (refs) {
    seg.references = refs[1]
    rest = rest.slice(refs[0].length)
  }
  if (clientSystem && rest.endsWith(`\n${clientSystem}`)) {
    seg.clientSystem = clientSystem
    rest = rest.slice(0, rest.length - clientSystem.length - 1)
  }
  let region = rest
  let tail: string | undefined
  const skills = lastBlock(region, SKILLS_HEAD, SKILLS_RE, false)
  if (skills) {
    seg.skills = skills.text
    tail = region.slice(skills.at + skills.len)
    region = region.slice(0, skills.at)
  }
  const mcp = lastBlock(region, MCP_HEAD, MCP_RE, !!skills)
  if (mcp) {
    seg.mcp = mcp.text
    tail ??= region.slice(mcp.at + mcp.len)
    region = region.slice(0, mcp.at)
  }
  if (tail === undefined) {
    if (region.endsWith(`\n${STRUCTURED}`)) {
      seg.structuredOutput = STRUCTURED
      region = region.slice(0, region.length - STRUCTURED.length - 1)
    }
    tail = ""
  }
  if (tail.startsWith(`\n${STRUCTURED}`)) {
    seg.structuredOutput = STRUCTURED
    tail = tail.slice(STRUCTURED.length + 1)
  }
  if (tail.startsWith("\n") && !seg.clientSystem) {
    seg.clientSystem = tail.slice(1)
    tail = ""
  }
  let leftover = tail
  if (region.startsWith("\nInstructions from: ")) seg.instructions = region.slice(1)
  else leftover += region
  const exact = leftover === "" && ORDER.map((k) => seg[k]).filter(Boolean).join("\n") === joined
  return { segments: seg, exact }
}

const PLACEHOLDERS: Record<string, keyof Segments | "opencode"> = {
  prompt: "prompt",
  environment: "environment",
  references: "references",
  instructions: "instructions",
  mcp: "mcp",
  skills: "skills",
  structured_output: "structuredOutput",
  client_system: "clientSystem",
  opencode: "opencode",
}

/** Expands {{placeholders}} the way opencode joins its own segments: empty lines vanish. */
export function expand(template: string, segments: Segments, original: string) {
  const known = (name: string) => Object.hasOwn(PLACEHOLDERS, name)
  const value = (name: string) => {
    const key = PLACEHOLDERS[name]
    return key === "opencode" ? original : segments[key]
  }
  const lines = template.split("\n").flatMap((line) => {
    const only = /^\{\{([a-z_]+)\}\}$/.exec(line)
    return only && known(only[1]) && !value(only[1]) ? [] : [line]
  })
  return lines.join("\n").replace(/\{\{([a-z_]+)\}\}/g, (token, name: string) => (known(name) ? value(name) : token))
}

const toolAsText = (part: Extract<AnyPart, { type: "tool" }>, wrap = (text: string) => text): AnyPart => {
  const output = part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : ""
  return {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: "text",
    text: wrap(`[${part.tool}] ${JSON.stringify(part.state.input)}\n${output}`),
  }
}

const reasoningAsText = (part: Extract<AnyPart, { type: "reasoning" }>): AnyPart => ({
  id: part.id,
  sessionID: part.sessionID,
  messageID: part.messageID,
  type: "text",
  text: `<thinking>\n${part.text}\n</thinking>`,
})

function asAssistant(msg: WithParts, path: { cwd: string; root: string }): WithParts {
  const info = msg.info
  return {
    info: {
      id: info.id,
      sessionID: info.sessionID,
      role: "assistant",
      time: { created: info.time.created, completed: info.time.created },
      parentID: info.id,
      // A provider/model that never matches the live model keeps part metadata from being
      // forwarded as provider metadata (signatures, ids) for text the provider never produced.
      providerID: "weft",
      modelID: "rewoven",
      mode: info.agent,
      agent: info.agent,
      path,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: msg.parts.filter((part) => !(part.type === "text" && (part.ignored || part.text === ""))),
  }
}

function asUser(msg: WithParts, wrap?: (text: string) => string): WithParts {
  const info = msg.info
  const model = info.role === "user" ? info.model : { providerID: info.providerID, modelID: info.modelID }
  const parts = msg.parts.flatMap((part): AnyPart[] => {
    if (part.type === "tool") return [toolAsText(part, wrap)]
    if (part.type === "reasoning") return []
    if (part.type === "text" && wrap && !part.ignored && part.text !== "") return [{ ...part, text: wrap(part.text) }]
    return [part]
  })
  return {
    info: { id: info.id, sessionID: info.sessionID, role: "user", time: { created: info.time.created }, agent: info.agent, model },
    parts,
  }
}

const systemReminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`

/** filterCompacted leads with the compaction request and its summary, ahead of any retained tail. */
function compactionHead(list: WithParts[]) {
  const [request, summary] = list
  if (request?.info.role !== "user" || !request.parts.some((p) => p.type === "compaction")) return 0
  return summary?.info.role === "assistant" && summary.info.summary && summary.info.parentID === request.info.id ? 2 : 1
}

function rewoven(msg: WithParts, meta: WeftMeta, path: { cwd: string; root: string }): WithParts | undefined {
  const id = msg.info.id
  if (meta.muted?.[id]) return undefined
  let next: WithParts = msg
  const thought = meta.thought
  if (thought && msg.parts.some((p) => p.type === "reasoning" && thought[p.id]))
    next = { info: msg.info, parts: msg.parts.map((p) => (p.type === "reasoning" && thought[p.id] ? reasoningAsText(p) : p)) }
  const role = meta.roles?.[id]
  if (role === "assistant" && next.info.role === "user") return asAssistant(next, path)
  if (role === "user" && next.info.role === "assistant") return asUser(next)
  if (role === "system") return asUser(next, systemReminder)
  return next
}

const FRESH_MS = 30_000

/** opencode only checks the "ses" prefix and imported sessions keep their ids: one must never name a path (src-tauri observed.rs). */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/

function metaFrom(info: unknown): WeftMeta | undefined {
  const meta = (info as { metadata?: Record<string, unknown> } | undefined)?.metadata?.weft as WeftMeta | undefined
  return meta?.v === 1 ? meta : undefined
}

/** A hook that throws aborts the user's turn, so every hook degrades to "do nothing" instead. */
function guarded<A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (error) {
      console.error(`[weft-liberated] ${name}`, error)
    }
  }
}

export default {
  id: "weft-liberated",
  server: (async ({ client, directory, worktree }) => {
    const metas = new Map<string, { meta: WeftMeta | undefined; at: number }>()
    const clientSystems = new Map<string, string | undefined>()
    const observedDir = process.env.WEFT_OBSERVED_DIR

    const remember = (sessionID: string, meta: WeftMeta | undefined) => metas.set(sessionID, { meta, at: Date.now() })

    const fetchMeta = async (sessionID: string) => {
      const res = await client.session.get({ path: { id: sessionID } }).catch(() => undefined)
      // A failed read keeps the last known edits rather than sending the stored conversation.
      if (!res?.data) return metas.get(sessionID)?.meta
      remember(sessionID, metaFrom(res.data))
      return metas.get(sessionID)!.meta
    }

    /** Cached metadata when fresh, so the transforms can run without awaiting (title calls fork early). */
    const cachedMeta = (sessionID: string) => {
      const hit = metas.get(sessionID)
      return hit && Date.now() - hit.at < FRESH_MS ? hit : undefined
    }

    const observe = (sessionID: string, record: Record<string, unknown>) => {
      if (!observedDir || !SESSION_ID.test(sessionID)) return
      try {
        mkdirSync(observedDir, { recursive: true })
        writeFileSync(join(observedDir, `${sessionID}.json`), JSON.stringify({ at: Date.now(), version: VERSION, ...record }))
      } catch {}
    }

    const unobserve = (sessionID: string) => {
      if (!observedDir || !SESSION_ID.test(sessionID)) return
      try {
        rmSync(join(observedDir, `${sessionID}.json`), { force: true })
      } catch {}
    }

    const reweave = (list: WithParts[], meta: WeftMeta) => {
      const path = { cwd: directory, root: worktree }
      const pinned = compactionHead(list)
      const keyOf = (msg: WithParts, index: number) =>
        index < pinned ? Number.NEGATIVE_INFINITY : (meta.order?.[msg.info.id] ?? Number.POSITIVE_INFINITY)
      const keyed = list
        .map((msg, index) => ({ msg: rewoven(msg, meta, path), key: keyOf(msg, index), index }))
        .filter((item): item is { msg: WithParts; key: number; index: number } => !!item.msg && item.msg.parts.length > 0)
      keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key))
      // The caller holds its own reference to this array, so it must be mutated in place.
      list.splice(0, list.length, ...keyed.map((item) => item.msg))
    }

    const hooks: Hooks = {
      // The canary only proves the plugin loaded (GET /experimental/tool/ids); denying it keeps it
      // out of the tool list every model call would otherwise carry.
      config: guarded("config", async (cfg) => {
        const permission = cfg.permission
        cfg.permission = typeof permission === "string" ? { "*": permission, weft_canary: "deny" } : { ...permission, weft_canary: "deny" }
      }),
      tool: {
        weft_canary: {
          description: "Weft liberation canary. Never call this tool.",
          args: {},
          execute: async () => VERSION,
        },
      },
      event: guarded("event", async ({ event }) => {
        if (event.type !== "session.updated" && event.type !== "session.created" && event.type !== "session.deleted") return
        const info = (event.properties as { info?: { id?: string } }).info
        if (!info?.id) return
        if (event.type === "session.deleted") {
          metas.delete(info.id)
          clientSystems.delete(info.id)
          unobserve(info.id)
          return
        }
        remember(info.id, metaFrom(info))
      }),
      // Runs before the loop starts, so the transforms below find the metadata already cached.
      "chat.message": guarded("chat.message", async (input) => {
        if (input.sessionID && !cachedMeta(input.sessionID)) await fetchMeta(input.sessionID)
      }),
      "experimental.chat.messages.transform": guarded("messages.transform", async (_input, output) => {
        const list = output.messages
        const sessionID = list[0]?.info.sessionID
        if (!sessionID) return
        const newestUser = [...list].reverse().find((m) => m.info.role === "user")
        clientSystems.set(sessionID, newestUser?.info.role === "user" ? newestUser.info.system : undefined)
        const cached = cachedMeta(sessionID)
        const meta = cached ? cached.meta : await fetchMeta(sessionID)
        if (meta) reweave(list, meta)
      }),
      "experimental.chat.system.transform": guarded("system.transform", async (input, output) => {
        if (!input.sessionID) return
        const joined = output.system.join("\n")
        // Only main-loop calls carry an environment block for the live model; title and
        // compaction calls are left exactly as opencode built them.
        const parsed = parseSystem(joined, input.model, clientSystems.get(input.sessionID))
        if (!parsed) return
        const cached = cachedMeta(input.sessionID)
        const meta = cached ? cached.meta : await fetchMeta(input.sessionID)
        const template = meta?.system?.text
        const sent = template === undefined ? joined : expand(template, parsed.segments, joined)
        observe(input.sessionID, { model: `${input.model.providerID}/${input.model.api.id}`, exact: parsed.exact, segments: parsed.segments, rewritten: template !== undefined, sent })
        if (template === undefined) return
        output.system.splice(0, output.system.length, sent)
      }),
    }
    return hooks
  }) satisfies Plugin,
}
