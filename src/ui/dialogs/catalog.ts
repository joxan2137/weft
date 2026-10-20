import type { Model, Project, Provider } from "@opencode-ai/sdk/v2/types"
import type { WeftState } from "../../engine/contract"

export type ModelRef = { providerID: string; modelID: string; variant?: string }

export const POPULAR = ["opencode", "opencode-go", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]

export function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** opencode's global project (non-git folders) reports the worktree "/": opening it would root sessions at the drive root. */
export function openable(projects: Project[]) {
  return projects.filter((project) => project.worktree && project.worktree !== "/")
}

export function compactTokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function price(perMillion: number) {
  const exact = String(Number(perMillion.toFixed(3)))
  return exact.includes(".") && exact.split(".")[1].length > 2 ? exact : perMillion.toFixed(2)
}

export function isFree(model: Model) {
  return model.cost.input === 0 && model.cost.output === 0
}

export function since(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 14) return `${d}d`
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })
}

/** Connected providers first (in connection order), then the popular ones, then the rest by name. */
export function sortProviders(all: Provider[], connected: string[]) {
  const rank = (p: Provider) => {
    const c = connected.indexOf(p.id)
    if (c >= 0) return c
    const pop = POPULAR.indexOf(p.id)
    return pop >= 0 ? 1000 + pop : 2000
  }
  return [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function usableModels(provider: Provider) {
  return Object.values(provider.models)
    .filter((m) => m.status !== "deprecated")
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "") || a.name.localeCompare(b.name))
}

/** The model a session will use: its own choice (or, before one exists, the draft), else the config default, else the first connected default. */
export function currentModel(state: WeftState, sessionID?: string): ModelRef | undefined {
  const chosen = sessionID ? state.choice[sessionID] : state.draft
  if (chosen) return { providerID: chosen.providerID, modelID: chosen.modelID, variant: chosen.variant }
  const configured = state.config?.model
  if (configured?.includes("/")) {
    const [providerID, ...rest] = configured.split("/")
    return { providerID, modelID: rest.join("/") }
  }
  const providerID = state.providers.connected.find((id) => state.providers.default[id])
  return providerID ? { providerID, modelID: state.providers.default[providerID] } : undefined
}

export function findModel(state: WeftState, ref: ModelRef | undefined) {
  if (!ref) return undefined
  const provider = state.providers.all.find((p) => p.id === ref.providerID)
  const model = provider?.models[ref.modelID]
  return provider && model ? { provider, model } : undefined
}

const RECENT_KEY = "weft.recentModels"
const RECENT_MAX = 5

export function recentModels(): ModelRef[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(list) ? list.filter((r) => typeof r?.providerID === "string" && typeof r?.modelID === "string") : []
  } catch {
    return []
  }
}

export function rememberModel(ref: ModelRef) {
  const next = [ref, ...recentModels().filter((r) => r.providerID !== ref.providerID || r.modelID !== ref.modelID)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {}
}

export type Match = { score: number; hits: number[] }

const BOUNDARY = /[\s\-_/.:\\]/

/** Case-insensitive fuzzy match: a contiguous hit scores highest, then word-start and consecutive letters. */
export function fuzzy(query: string, text: string): Match | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, hits: [] }
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) {
    const start = at === 0 || BOUNDARY.test(t[at - 1]) ? 120 : 0
    return { score: 1000 + start - at - t.length * 0.2, hits: Array.from({ length: q.length }, (_, i) => at + i) }
  }
  const hits: number[] = []
  let score = 0
  let from = 0
  for (const ch of q) {
    if (ch === " ") continue
    const i = t.indexOf(ch, from)
    if (i < 0) return undefined
    score += hits.length && i === hits[hits.length - 1] + 1 ? 12 : 1
    if (i === 0 || BOUNDARY.test(t[i - 1])) score += 8
    hits.push(i)
    from = i + 1
  }
  return { score: score - (hits[hits.length - 1] - hits[0]) * 0.4 - t.length * 0.05, hits }
}

/** Like fuzzy, but only a contiguous hit counts. */
export function literal(query: string, text: string): Match | undefined {
  const m = fuzzy(query, text)
  return m && (m.score >= 1000 || !query.trim()) ? m : undefined
}

export function best(...matches: (Match | undefined)[]) {
  return matches.reduce<Match | undefined>((a, m) => (m && (!a || m.score > a.score) ? m : a), undefined)
}
