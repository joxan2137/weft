import type { Message, Part, PermissionRequest, Session, Todo } from "@opencode-ai/sdk/v2/types"
import type { Draft, Dye, Weave, WeftPick } from "../art/weave"

export type Role = "system" | "user" | "assistant"

export type Mend = { text: string; role: Role; at: number }

/** Pick 00: the system prompt as an editable template whose {{placeholders}} the plugin expands. */
export type WarpView = {
  template: string
  rewritten: boolean
  /** vendored provider prompt the seed (or the rewrite) started from */
  file?: string
  /** placeholder name → the value the plugin last observed on a real call */
  values?: Record<string, string>
  observedAt?: number
  /** false when the last observed system prompt could not be split exactly */
  exact?: boolean
}

/** One message as the cloth shows it: its effective (liberated) role and its visible parts. */
export type PickView = {
  id: string
  role: Role
  info: Message
  parts: Part[]
  live?: boolean
  mends?: Mend[]
  source?: string
  /** kept in the cloth but left out of the model's context */
  muted?: boolean
  /** undone in OpenCode (`session.revert`): kept for its Redo, deleted for good by the next prompt */
  reverted?: boolean
  /** user picks: the stored replies answering it (assistant messages whose `parentID` is this pick) */
  replies?: number
  /** only on pick 00 */
  warp?: WarpView
}

export type SessionView = {
  session: Session
  draft: Draft
  /** pick count; unknown until the session's messages are loaded */
  picks?: number
  children?: SessionView[]
}

export type ContextView = {
  /** the model's context window in tokens; 0 when the model is unknown */
  limit: number
  spent: { dye: Dye; tokens: number }[]
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export type ChangedFile = { path: string; additions: number; deletions: number; status?: "added" | "modified" | "deleted" }

export type LoomView = {
  directory: string
  branch?: string
  sessions: SessionView[]
  activeID?: string
  picks: PickView[]
  permission?: PermissionRequest
  todos: Todo[]
  changed: ChangedFile[]
  context: ContextView
  model: { providerID: string; modelID: string; variant?: string; name?: string }
  agent: string
  engine: { version: string; url: string; state: "starting" | "ready" | "error" | "stopped" }
}

export function partText(parts: Part[]) {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n\n")
}

function weaveOf(pick: PickView): Weave {
  if (pick.parts.some((p) => p.type === "tool")) return "basket"
  if (pick.parts.some((p) => p.type === "reasoning")) return "satin"
  if (/```/.test(partText(pick.parts))) return "twill"
  return "plain"
}

function tokensOf(pick: PickView) {
  if (pick.info.role === "assistant") return pick.info.tokens.output + pick.info.tokens.reasoning
  return Math.ceil(partText(pick.parts).length / 4)
}

export function weftOf(pick: PickView): WeftPick {
  return {
    dye: pick.parts.length > 0 && pick.parts.every((x) => x.type === "tool") ? "tool" : pick.role,
    weave: weaveOf(pick),
    tokens: tokensOf(pick),
  }
}

export function draftOf(picks: PickView[], warpRewritten: boolean): Draft {
  return { warp: warpRewritten ? "weld" : "linen", picks: picks.map(weftOf) }
}
