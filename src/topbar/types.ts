export type RowKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "update"
  | "test"
  | "bash"
  | "task"
  | "todo"
  | "think"
  | "terminal"

export type TopbarRow = {
  label: string
  seconds?: number
  kind: RowKind
  active?: boolean
}

export type TopbarStatus = "running" | "approval" | "done" | "error"

export type TopbarSource = "weft" | "claude"

export type TopbarSnapshot = {
  source: TopbarSource
  sessionId: string
  title: string
  titleMeta?: string
  model?: string
  stepsDone: number
  stepsTotal: number
  startedAt: number
  status: TopbarStatus
  action: RowKind
  rows: TopbarRow[]
  elapsedMs?: number
  approval?: { requestId: string; command: string }
  filesChanged?: number
  note?: string
}

export type TopbarActionKind = "approve" | "deny" | "stop" | "open"

export type TopbarAction = {
  kind: TopbarActionKind
  source: TopbarSource
  sessionId: string
  requestId?: string
}
