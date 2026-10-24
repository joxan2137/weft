// Seam: a hand-off taken between turns. Everything stored before `keepFrom` is left out of the
// request and a small, deterministic card is pinned at the end of the system prompt instead. The
// card is rebuilt from the raw trace every time, so repeated seams never stack summaries; files and
// tool receipts stay re-readable on disk, and the fields that exist only in the conversation
// (objective, constraints, failed paths, next step) are carried verbatim. Type-only imports keep
// this module loadable by plain Node for tools/e2e-seam.mjs.
import type { Message, Part } from "@opencode-ai/sdk/v2/types"

export type SeamFile = { path: string; state: "edited" | "read" | "failed" }

export type SeamCard = {
  objective: string
  /** quoted from the user's own words, newest first */
  constraints: string[]
  /** what the tools reported, newest last */
  verified: string[]
  /** do-not-retry: failed tools and non-zero commands, newest last */
  failed: string[]
  files: SeamFile[]
  next: string
  notes: string[]
}

export type Seam = {
  v: 1
  at: number
  /** the first message the model still sees verbatim; every message stored before it is elided */
  keepFrom: string
  /** messages left out of the request */
  elided: number
  /** estimated tokens freed (elided messages minus the card) */
  saved: number
  card: SeamCard
  /** exactly what the plugin pins at the end of the system prompt */
  text: string
}

/** The tail kept verbatim, in tokens: a quarter of the usable window, clamped like opencode's. */
export const TAIL_MIN = 2_000
export const TAIL_MAX = 15_000
export const RESERVE = 20_000
const TOOL_CAP = 20_000
const CARD_CHARS = 6_000

export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

const CONTINUATION = /^\s*(?:continue|go on|keep going|proceed|ok(?:ay)?|yes|sure|thanks?|do it)\s*[.!]*\s*$/i
const CONSTRAINT =
  /\b(?:must|never|always|only|don'?t|do not|avoid|ensure|make sure|required?|unless|without|before (?:you|editing|running|sending)|after (?:you|editing|running)|instead|keep|prefer|wait|ask (?:me )?first|confirm|leave|stop|revert|no changes)\b/i
const VERIFY =
  /(?:\b(?:npm|pnpm|yarn|bun|npx|tsc|pytest|vitest|jest|cargo|go|dotnet|make|cmake|mvn|gradle|python3?|ruff|eslint|biome)\b)|(?:\b(?:test|tests|build|typecheck|lint|check)\b)/i

const EDITS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
const READS = new Set(["read"])
const SHELLS = new Set(["bash", "shell"])

type Tool = Extract<Part, { type: "tool" }>

const isProse = (part: Part): part is Extract<Part, { type: "text" }> =>
  part.type === "text" && !part.synthetic && !part.ignored

const proseOf = (parts: Part[]) => parts.filter(isProse).map((p) => p.text).join("\n\n")

export function partTokens(part: Part): number {
  if (part.type === "text" || part.type === "reasoning") return estimateTokens(part.text)
  if (part.type === "tool") {
    if (part.state.status === "completed")
      return estimateTokens(JSON.stringify(part.state.input)) + estimateTokens(part.state.output.slice(0, TOOL_CAP))
    if (part.state.status === "error") return estimateTokens(JSON.stringify(part.state.input)) + estimateTokens(part.state.error)
    return estimateTokens(JSON.stringify(part.state.input ?? {}))
  }
  if (part.type === "file") return 400
  return 0
}

export function messageTokens(parts: Part[]): number {
  return parts.reduce((total, part) => total + partTokens(part), 8)
}

function sortMessages(messages: Message[]) {
  return [...messages].sort((a, b) => a.time.created - b.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Like clip, but keeps the line structure the card is read by. */
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function toolPath(input: Record<string, unknown>) {
  for (const key of ["filePath", "path", "file", "filename"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function toolCommand(input: Record<string, unknown>) {
  const value = input.command ?? input.cmd
  return typeof value === "string" ? value : undefined
}

function firstLine(part: Tool) {
  const text = part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : ""
  return clip(text.split("\n").find((line) => line.trim()) ?? "", 160)
}

function outcome(part: Tool): "ok" | "failed" {
  if (part.state.status === "error") return "failed"
  if (part.state.status !== "completed") return "ok"
  const code = /\bexit code\s+(-?\d+)\b/i.exec(part.state.output)
  return code && Number(code[1]) !== 0 ? "failed" : "ok"
}

/** The newest completed run of a check-like command, for the "compact at a milestone" hint. */
export function lastCheck(messages: Message[], parts: Record<string, Part[]>): { command: string; ok: boolean } | undefined {
  let found: { command: string; ok: boolean } | undefined
  for (const message of messages) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "tool" || !SHELLS.has(part.tool)) continue
      const command = toolCommand(part.state.input)
      if (!command || !VERIFY.test(command) || part.state.status !== "completed") continue
      found = { command: clip(command, 120), ok: outcome(part) === "ok" }
    }
  }
  return found
}

function constraintsOf(messages: Message[], parts: Record<string, Part[]>): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  for (let i = messages.length - 1; i >= 0 && found.length < 12; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    for (const sentence of proseOf(parts[message.id] ?? []).split(/(?<=[.!?])\s+|\n+/)) {
      const text = clip(sentence.replace(/^[-*•]\s*/, ""), 240)
      if (text.length < 8 || text.length > 240 || !CONSTRAINT.test(text)) continue
      const key = text.toLowerCase().replace(/\s+/g, " ")
      if (seen.has(key)) continue
      seen.add(key)
      found.push(text)
    }
  }
  return found
}

function objectiveOf(messages: Message[], parts: Record<string, Part[]>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const text = proseOf(parts[message.id] ?? []).trim()
    if (text.length >= 16 && !CONTINUATION.test(text)) return clip(text, 500)
  }
  const first = messages.find((message) => message.role === "user")
  return first ? clip(proseOf(parts[first.id] ?? []), 500) : ""
}

function cardOf(messages: Message[], parts: Record<string, Part[]>): SeamCard {
  const verified = new Map<string, string>()
  const failed = new Map<string, string>()
  const files = new Map<string, SeamFile["state"]>()

  for (const message of messages) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "tool") continue
      const input = part.state.input ?? {}
      const path = toolPath(input)
      const command = toolCommand(input)
      const target = path ?? command ?? part.tool
      const key = `${part.tool}:${target}`
      const ok = outcome(part) === "ok"

      if (!ok) {
        failed.set(key, `${part.tool} ${clip(target, 160)} — ${firstLine(part) || "failed"}`)
        verified.delete(key)
        if (path) files.set(path, "failed")
        continue
      }
      failed.delete(key)
      if (path && EDITS.has(part.tool)) files.set(path, "edited")
      else if (path && READS.has(part.tool) && files.get(path) !== "edited") files.set(path, "read")
      if (SHELLS.has(part.tool) && command && VERIFY.test(command)) verified.set(key, `${clip(command, 160)} — ok`)
    }
  }

  const objective = objectiveOf(messages, parts)
  const constraints = constraintsOf(messages, parts)
  const lastFailure = [...failed.values()].at(-1)
  const lastVerified = [...verified.values()].at(-1)
  const next = lastFailure
    ? "Resolve the failure above, then re-run its command. Do not repeat a failed path unchanged."
    : lastVerified
      ? "The last check passed. Continue the remaining work from the objective, then re-run that check."
      : "Continue the objective. Read the listed files before editing, and verify with a command before claiming done."

  return {
    objective,
    constraints,
    verified: [...verified.values()].slice(-10),
    failed: [...failed.values()].slice(-8),
    files: [...files.entries()]
      .sort((a, b) => (a[1] === "edited" ? -1 : 0) - (b[1] === "edited" ? -1 : 0))
      .slice(0, 20)
      .map(([path, state]) => ({ path, state })),
    next,
    notes: [],
  }
}

const HEAD = "<weft-seam>\nEarlier turns are elided to fit the window. This card is the hand-off; the workspace on disk is the source of truth."

export function seamText(card: SeamCard): string {
  const lines = [HEAD, `Objective: ${card.objective}`]
  if (card.constraints.length) lines.push("", "Constraints (verbatim from the user; keep applying them):", ...card.constraints.map((x) => `- ${x}`))
  if (card.verified.length) lines.push("", "Verified (what the tools reported):", ...card.verified.map((x) => `- ${x}`))
  if (card.failed.length) lines.push("", "Failed (do not retry unless the cause changed):", ...card.failed.map((x) => `- ${x}`))
  if (card.files.length)
    lines.push("", "Files:", ...card.files.map((file) => `- ${file.path} (${file.state})`))
  lines.push("", `Next: ${card.next}`)
  if (card.notes.length) lines.push("", "Notes:", ...card.notes.map((x) => `- ${x}`))
  lines.push("</weft-seam>")
  return cut(lines.join("\n"), CARD_CHARS)
}

export function tailBudget(limit?: number) {
  const usable = limit && limit > 0 ? Math.max(0, limit - RESERVE) : 0
  if (!usable) return 8_000
  return Math.min(TAIL_MAX, Math.max(TAIL_MIN, Math.floor(usable * 0.25)))
}

function boundaryFor(messages: Message[], parts: Record<string, Part[]>, limit?: number, keepFrom?: string) {
  if (keepFrom) {
    const at = messages.findIndex((message) => message.id === keepFrom)
    if (at < 0) throw new Error("That message is no longer in the session. Reload it and try again.")
    if (messages[at].role === "user") return at
    const parentID = messages[at].role === "assistant" ? messages[at].parentID : undefined
    const parent = parentID ? messages.findIndex((message) => message.id === parentID) : -1
    if (parent >= 0 && messages[parent].role === "user") return parent
    for (let i = at; i >= 0; i--) if (messages[i].role === "user") return i
    throw new Error("A seam starts at one of your messages.")
  }
  const budget = tailBudget(limit)
  const users = messages.flatMap((message, index) => (message.role === "user" ? [index] : []))
  if (users.length < 2) throw new Error("This session has no earlier turn to seam off yet.")
  let first = users[users.length - 1]
  let kept = messages.slice(first).reduce((total, message) => total + messageTokens(parts[message.id] ?? []), 0)
  for (let i = users.length - 2; i >= 0; i--) {
    const start = users[i]
    const add = messages.slice(start, first).reduce((total, message) => total + messageTokens(parts[message.id] ?? []), 0)
    if (kept + add > budget) break
    first = start
    kept += add
  }
  if (first === 0) throw new Error("This session has no earlier turn to seam off yet.")
  return first
}

/** Builds a seam, optionally with the user's edited card, without storing anything. */
export function buildSeam(input: {
  messages: Message[]
  parts: Record<string, Part[]>
  keepFrom?: string
  card?: SeamCard
  limit?: number
  at?: number
}): Seam {
  const messages = sortMessages(input.messages)
  if (messages.length === 0) throw new Error("This session has no messages yet.")
  const at = boundaryFor(messages, input.parts, input.limit, input.keepFrom)
  const card = input.card ?? cardOf(messages, input.parts)
  if (!card.objective.trim()) throw new Error("The seam needs an objective.")
  const text = seamText(card)
  const elided = messages.slice(0, at)
  const before = elided.reduce((total, message) => total + messageTokens(input.parts[message.id] ?? []), 0)
  const saved = before - estimateTokens(text)
  if (saved <= 0) throw new Error("This seam would not free any room: the card is larger than the messages it replaces.")
  return { v: 1, at: input.at ?? Date.now(), keepFrom: messages[at].id, elided: elided.length, saved, card, text }
}

export function seamProblem(seam: Seam, messages: Message[]): string | undefined {
  if (seam.v !== 1) return "This seam was written by another version of Weft."
  if (!seam.card.objective.trim()) return "The seam needs an objective."
  if (!seam.text.trim()) return "The seam has no card."
  if (!messages.some((message) => message.id === seam.keepFrom)) return "The message this seam keeps from is gone. Take the seam again."
  if (seam.saved <= 0) return "This seam frees no tokens."
  return undefined
}
