import type { TopbarSnapshot } from "./types"

export type DemoName = "running" | "approval" | "done" | "compact"

export type DemoSnapshot = {
  snapshot: TopbarSnapshot
  compact: boolean
  seconds: number
}

export function isDemoName(value: string | null | undefined): value is DemoName {
  return value === "running" || value === "approval" || value === "done" || value === "compact"
}

export function demoSnapshot(name: DemoName, now = Date.now()): DemoSnapshot {
  const base = {
    source: "claude" as const,
    sessionId: "demo-session",
    model: "Claude Sonnet 5.5",
  }

  if (name === "approval") {
    return {
      compact: false,
      seconds: 12,
      snapshot: {
        ...base,
        title: "Needs your approval to run git push",
        stepsDone: 5,
        stepsTotal: 6,
        startedAt: now - 12_000,
        status: "approval",
        action: "terminal",
        rows: [
          { label: "Found 4 call sites", seconds: 1.5, kind: "search" },
          { label: "Edited src/billing/invoice.ts", seconds: 2.5, kind: "edit" },
          { label: "Updated 5 test files", seconds: 1.9, kind: "update" },
          { label: "Passed 12 of 12 tests", seconds: 3.3, kind: "test" },
          { label: "Waiting for approval to run git push", seconds: 1, kind: "terminal", active: true },
        ],
        approval: { requestId: "demo-approval", command: "git push" },
      },
    }
  }

  if (name === "done") {
    return {
      compact: false,
      seconds: 13,
      snapshot: {
        ...base,
        title: "Done in 13s",
        titleMeta: "· 6 files changed",
        stepsDone: 6,
        stepsTotal: 6,
        startedAt: now - 13_000,
        elapsedMs: 13_000,
        status: "done",
        action: "test",
        filesChanged: 6,
        rows: [
          { label: "Found 4 call sites", seconds: 1.5, kind: "search" },
          { label: "Edited src/billing/invoice.ts", seconds: 2.5, kind: "edit" },
          { label: "Updated 5 test files", seconds: 1.9, kind: "update" },
          { label: "Passed 12 of 12 tests", seconds: 3.3, kind: "test" },
          { label: "Pushed fix/proration-rounding", seconds: 1.4, kind: "terminal" },
        ],
      },
    }
  }

  if (name === "compact") {
    return {
      compact: true,
      seconds: 0,
      snapshot: {
        ...base,
        title: "Reading 12 files",
        stepsDone: 0,
        stepsTotal: 0,
        startedAt: now,
        status: "running",
        action: "read",
        rows: [],
      },
    }
  }

  return {
    compact: false,
    seconds: 11,
    snapshot: {
      ...base,
      title: "Running tests",
      titleMeta: "12 of 12",
      stepsDone: 5,
      stepsTotal: 6,
      startedAt: now - 11_000,
      status: "running",
      action: "test",
      rows: [
        { label: "Read 12 files", seconds: 1.9, kind: "read" },
        { label: "Found 4 call sites", seconds: 1.5, kind: "search" },
        { label: "Edited src/billing/invoice.ts", seconds: 2.5, kind: "edit" },
        { label: "Updated 5 test files", seconds: 1.9, kind: "update" },
        { label: "Running tests 12 of 12", seconds: 3, kind: "test", active: true },
      ],
    },
  }
}
