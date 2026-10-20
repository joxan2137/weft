import { createMemo, For, Match, Show, Switch } from "solid-js"
import { phasesOf, settled, type WorkflowAgent, type WorkflowRun } from "../../engine/workflow"
import { IconCheck, IconCross } from "../icons"

const STATUS: Record<WorkflowAgent["status"], string> = {
  queued: "waiting for a free slot",
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  cached: "reused from the earlier run",
}

function compact(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)
}

function duration(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function detail(agent: WorkflowAgent) {
  if (agent.status === "cached") return "reused"
  if (agent.status === "queued") return "waiting"
  return [agent.tokens ? `${compact(agent.tokens)} tokens` : "", agent.start && agent.end ? duration(agent.end - agent.start) : ""].filter(Boolean).join(" · ")
}

function Agent(props: { agent: WorkflowAgent; onOpenSession?: (id: string) => void }) {
  const agent = () => props.agent
  return (
    <li class={`wf-agent ${agent().status}`}>
      <div class="wf-agent-row" title={`${agent().label}: ${STATUS[agent().status]}${agent().model ? ` · ${agent().model}` : ""}`}>
        <span class="wf-mark" aria-label={STATUS[agent().status]}>
          <Switch>
            <Match when={agent().status === "running"}>
              <span class="spinner" />
            </Match>
            <Match when={agent().status === "done" || agent().status === "cached"}>
              <IconCheck size={12} />
            </Match>
            <Match when={agent().status === "failed"}>
              <IconCross size={12} />
            </Match>
          </Switch>
        </span>
        <span class="wf-label">{agent().label}</span>
        <Show when={agent().agent && agent().agent !== "general"}>
          <span class="wf-kind">{agent().agent}</span>
        </Show>
        <span class="wf-detail num">{detail(agent())}</span>
        <Show when={agent().session}>
          {(id) => (
            <button class="link" onClick={() => props.onOpenSession?.(id())}>
              open
            </button>
          )}
        </Show>
      </div>
      <Show when={agent().error}>
        <div class="wf-error selectable">{agent().error}</div>
      </Show>
    </li>
  )
}

/** A workflow run: its agents by phase, its log lines and what it returned. */
export function WorkflowView(props: { run: WorkflowRun; output?: string; error?: string; onOpenSession?: (id: string) => void }) {
  const phases = createMemo(() => phasesOf(props.run))
  const logs = () => props.run.logs.slice(-4)
  // The model's copy opens with a summary the agents above already show.
  const result = () => (props.output ? (/<result>\n([\s\S]*)\n<\/result>/.exec(props.output)?.[1] ?? props.output) : undefined)
  return (
    <div class="workflow">
      <Show when={props.run.description}>
        <p class="wf-about">{props.run.description}</p>
      </Show>
      <Show when={logs().length}>
        <ul class="wf-log">
          <For each={logs()}>{(line) => <li>{line.text}</li>}</For>
        </ul>
      </Show>
      <For each={phases()}>
        {(phase) => (
          <section class="wf-phase" classList={{ waiting: phase.agents.length === 0 }}>
            <Show when={phase.title}>
              <header class="wf-phase-head" title={phase.detail}>
                <span class="wf-phase-title">{phase.title}</span>
                <span class="wf-phase-count num">
                  {phase.agents.length ? `${phase.agents.filter(settled).length} of ${phase.agents.length}` : "not started"}
                </span>
              </header>
            </Show>
            <ul class="wf-agents">
              <For each={phase.agents}>{(agent) => <Agent agent={agent} onOpenSession={props.onOpenSession} />}</For>
            </ul>
          </section>
        )}
      </For>
      <Show when={props.error || props.run.error}>
        <pre class="brocade-out bad selectable">{props.error || props.run.error}</pre>
      </Show>
      <Show when={result()}>
        {(value) => (
          <section class="wf-result">
            <span class="label">Result</span>
            <pre class="brocade-out selectable">{value().slice(0, 4000)}</pre>
          </section>
        )}
      </Show>
    </div>
  )
}
