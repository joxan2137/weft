/** One agent() call of a workflow run. */
export type WorkflowAgent = {
  n: number
  label: string
  phase?: string
  /** cached: reused from the run it resumed */
  status: "queued" | "running" | "done" | "failed" | "stopped" | "cached"
  agent?: string
  model?: string
  /** the agent's child session */
  session?: string
  start?: number
  end?: number
  tokens?: number
  cost?: number
  error?: string
}

/** `metadata.workflow` on a `workflow` tool part, kept current by plugin/weft-workflow.ts while the run goes on. */
export type WorkflowRun = {
  v: 1
  id: string
  name: string
  description?: string
  status: "running" | "completed" | "failed" | "stopped"
  phases: { title: string; detail?: string }[]
  agents: WorkflowAgent[]
  logs: { at: number; text: string }[]
  started: number
  ended?: number
  resumedFrom?: string
  error?: string
}

export type WorkflowPhase = { title: string; detail?: string; agents: WorkflowAgent[] }

/**
 * The run in a tool part's metadata. A part that ended while the run still read "running" was
 * stopped before the plugin could say so (Stop, or the engine went away).
 */
export function readRun(metadata: unknown, partStatus: string): WorkflowRun | undefined {
  const run = (metadata as { workflow?: WorkflowRun } | undefined)?.workflow
  if (run?.v !== 1 || !Array.isArray(run.agents) || !Array.isArray(run.phases)) return undefined
  if (partStatus === "running" || partStatus === "pending" || run.status !== "running") return run
  return {
    ...run,
    status: "stopped",
    agents: run.agents.map((a) => (a.status === "running" || a.status === "queued" ? { ...a, status: "stopped" } : a)),
  }
}

/** Agents grouped by phase: those started before any phase first, then the phases in the order they were declared or met. */
export function phasesOf(run: WorkflowRun): WorkflowPhase[] {
  const groups = new Map<string, WorkflowPhase>([["", { title: "", agents: [] }]])
  for (const phase of run.phases) groups.set(phase.title, { title: phase.title, detail: phase.detail, agents: [] })
  for (const agent of run.agents) {
    const title = agent.phase ?? ""
    if (!groups.has(title)) groups.set(title, { title, agents: [] })
    groups.get(title)!.agents.push(agent)
  }
  return [...groups.values()].filter((g) => g.title || g.agents.length)
}

export const settled = (agent: WorkflowAgent) => agent.status !== "queued" && agent.status !== "running"
