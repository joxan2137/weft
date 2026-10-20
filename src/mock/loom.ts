import type { AssistantMessage, Part, Session, UserMessage } from "@opencode-ai/sdk/v2/types"
import anthropicPrompt from "../assets/prompts/anthropic.txt?raw"
import { SEED_TAIL } from "../engine/liberate"
import { draftOf, type LoomView, type PickView, type SessionView } from "../engine/view"
import type { WorkflowRun } from "../engine/workflow"

const SID = "ses_mock_flaky"
const T0 = Date.UTC(2026, 9, 15, 12, 2)
let partSeq = 0

function user(id: string, text: string, minutes: number, extra: Partial<UserMessage> = {}): UserMessage {
  void text
  return {
    id,
    sessionID: SID,
    role: "user",
    time: { created: T0 + minutes * 60_000 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" },
    ...extra,
  }
}

function assistant(id: string, parentID: string, minutes: number, output: number, done = true): AssistantMessage {
  return {
    id,
    sessionID: SID,
    role: "assistant",
    parentID,
    time: done ? { created: T0 + minutes * 60_000, completed: T0 + minutes * 60_000 + 41_000 } : { created: T0 + minutes * 60_000 },
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "C:\\dev\\atlas-web", root: "C:\\dev\\atlas-web" },
    cost: output * 0.000015,
    tokens: { input: 18_200, output, reasoning: 640, cache: { read: 14_800, write: 2_100 } },
  }
}

function text(messageID: string, value: string): Part {
  return { id: `prt_${++partSeq}`, sessionID: SID, messageID, type: "text", text: value }
}

function reasoning(messageID: string, value: string, seconds: number): Part {
  return { id: `prt_${++partSeq}`, sessionID: SID, messageID, type: "reasoning", text: value, time: { start: T0, end: T0 + seconds * 1000 } }
}

function tool(messageID: string, name: string, input: Record<string, unknown>, output: string, title: string, metadata: Record<string, unknown> = {}, status: "completed" | "running" | "error" = "completed"): Part {
  const base = { id: `prt_${++partSeq}`, sessionID: SID, messageID, type: "tool" as const, callID: `call_${partSeq}`, tool: name }
  if (status === "running") return { ...base, state: { status, input, title, metadata, time: { start: T0 } } }
  if (status === "error") return { ...base, state: { status, input, error: output, metadata, time: { start: T0, end: T0 + 900 } } }
  return { ...base, state: { status, input, output, title, metadata, time: { start: T0, end: T0 + 21_400 } } }
}

const editDiff = `Index: package.json
===================================================================
--- package.json
+++ package.json
@@ -6,5 +6,5 @@
   "scripts": {
-    "build": "run-p build:app build:assets",
+    "build": "run-s build:app build:assets",
-    "build:app": "vite build",
+    "build:app": "vite build --emptyOutDir",
     "lint": "eslint ."
`

const flakeHunt: WorkflowRun = {
  v: 1,
  id: "wf_3fa81c02-9d1",
  name: "flake-hunt",
  description: "Find why the build fails one run in five: survey every suspect, then verify the likely causes.",
  status: "completed",
  phases: [{ title: "Survey", detail: "one reader per suspect" }, { title: "Verify", detail: "reproduce each hypothesis" }],
  agents: [
    { n: 1, label: "build logs", phase: "Survey", status: "done", agent: "explore", session: "ses_mock_wf1", start: T0, end: T0 + 38_000, tokens: 41_200 },
    { n: 2, label: "package scripts", phase: "Survey", status: "done", agent: "explore", session: "ses_mock_wf2", start: T0, end: T0 + 22_000, tokens: 18_900 },
    { n: 3, label: "CI config", phase: "Survey", status: "cached" },
    { n: 4, label: "race on dist/", phase: "Verify", status: "done", agent: "general", session: "ses_mock_wf4", start: T0 + 40_000, end: T0 + 104_000, tokens: 96_300 },
    {
      n: 5,
      label: "file-system timing",
      phase: "Verify",
      status: "failed",
      agent: "general",
      session: "ses_mock_wf5",
      start: T0 + 40_000,
      end: T0 + 71_000,
      tokens: 58_480,
      error: "Rate limited by the provider (429): try again in 20 s.",
    },
  ],
  logs: [
    { at: T0 + 39_000, text: "3 suspects surveyed; 2 worth verifying" },
    { at: T0 + 105_000, text: "the race on dist/ reproduces 4 times in 20" },
  ],
  started: T0,
  ended: T0 + 112_000,
  resumedFrom: "wf_19c0aa7e-412",
}

export const mockPicks: PickView[] = [
  {
    id: "msg_000",
    role: "system",
    info: user("msg_000", "", 0),
    parts: [text("msg_000", `${anthropicPrompt}
${SEED_TAIL}`)],
    source: "default · anthropic.txt",
    warp: { template: `${anthropicPrompt}
${SEED_TAIL}`, rewritten: false, file: "anthropic.txt" },
  },
  {
    id: "msg_001",
    role: "user",
    info: user("msg_001", "", 1),
    parts: [text("msg_001", "Set up CI so it runs `lint` before `build`, and cache `node_modules` between runs keyed on the lockfile hash.")],
    mends: [{ text: "Set up CI so it runs lint before build.", role: "user", at: T0 + 30_000 }],
  },
  {
    id: "msg_002",
    role: "assistant",
    info: assistant("msg_002", "msg_001", 2, 412),
    parts: [
      text("msg_002", "Added a `lint → build` workflow with an npm cache keyed on `package-lock.json`. Two jobs share one cache restore step, so a cold run costs about 40 s and a warm one about 9 s."),
    ],
  },
  {
    id: "msg_003",
    role: "user",
    info: user("msg_003", "", 9),
    parts: [text("msg_003", "CI still fails on the build step about one run in five. Find the flaky part, fix it, and clean up the stale `dist` output while you're at it.")],
  },
  {
    id: "msg_004",
    role: "assistant",
    info: assistant("msg_004", "msg_003", 10, 1288),
    parts: [
      reasoning(
        "msg_004",
        "One run in five smells like a race. Both build steps write into dist/ and run-p starts them together. If vite empties the folder after copy-assets has begun, the copy dies with ENOENT. Running them in sequence removes the race; giving copy-assets its own folder makes it robust even if someone parallelises again.",
        6.2,
      ),
      tool(
        "msg_004",
        "workflow",
        { name: "flake-hunt", args: "the build fails about one run in five" },
        'Workflow "flake-hunt" finished (run wf_3fa81c02-9d1): 5 agents, 3 done, 1 cached, 1 failed, 1m 52s, 214,880 tokens.\nFailed agents:\n- file-system timing: Rate limited by the provider (429): try again in 20 s.\n<result>\n{ "cause": "run-p starts vite build and copy-assets together; both write dist/" }\n</result>',
        "flake-hunt",
        { workflow: flakeHunt },
      ),
      tool("msg_004", "bash", { command: "for i in $(seq 5); do npm run -s build && echo \"ok $i\" || echo \"FAIL $i\"; done", description: "Repeat the build five times" }, "ok 1\nok 2\nError: ENOENT: no such file or directory, copyfile 'public/fonts/inter.woff2'\nFAIL 3\nok 4\nok 5", "Repeat the build five times", { exit: 0 }),
      text(
        "msg_004",
        "The flake is a race on `dist/`. Your `build` script starts `vite build` and `copy-assets` together through `run-p`; when Vite empties the folder after the copy has begun, the copy dies with `ENOENT`.\n\nI made the steps run in sequence and let the copy script own its folder:\n\n```ts\nimport { cp, mkdir } from \"node:fs/promises\"\n\nexport async function copyAssets(outDir = \"dist\") {\n  await mkdir(`${outDir}/assets`, { recursive: true }) // own the folder\n  await cp(\"public/fonts\", `${outDir}/assets/fonts`, { recursive: true })\n}\n```",
      ),
      tool("msg_004", "edit", { filePath: "C:\\dev\\atlas-web\\package.json", oldString: "run-p", newString: "run-s" }, "Edit applied successfully.", "package.json", { diff: editDiff, filediff: { additions: 2, deletions: 2 } }),
      tool("msg_004", "todowrite", { todos: [] }, "", "4 todos", {
        todos: [
          { content: "Reproduce the flake locally", status: "completed", priority: "high" },
          { content: "Find the race between build steps", status: "completed", priority: "high" },
          { content: "Run build steps in sequence", status: "completed", priority: "medium" },
          { content: "Delete stale dist output", status: "in_progress", priority: "medium" },
          { content: "Re-run CI five times to confirm", status: "pending", priority: "low" },
        ],
      }),
      {
        ...text("msg_004", "Plan updated. Last step is deleting the stale `dist` folder so the next CI run starts clean, which needs your go-ahead before I run it."),
        time: { start: T0 + 38_000, end: T0 + 41_000 },
      } as Part,
    ],
    live: true,
  },
]

export const mockPermission = {
  id: "per_mock",
  sessionID: SID,
  permission: "bash",
  patterns: ["rm -rf dist"],
  metadata: { command: "rm -rf dist", description: "Delete the stale build output" },
  always: ["rm *"],
}

function session(id: string, title: string, minutesAgo: number, extra: Partial<Session> = {}): Session {
  const updated = Date.now() - minutesAgo * 60_000
  return {
    id,
    slug: id,
    projectID: "prj_atlas",
    directory: "C:\\dev\\atlas-web",
    title,
    version: "1.19.1",
    time: { created: updated - 3_600_000, updated },
    ...extra,
  }
}

function fakeSession(id: string, title: string, minutesAgo: number, seed: number, picks: number, rewritten = false): SessionView {
  const roles = ["user", "assistant"] as const
  const views: PickView[] = Array.from({ length: picks }, (_, i) => {
    const role = i === 0 ? "system" : roles[(i + 1) % 2]
    const n = (seed * 31 + i * 17) % 7
    const parts: Part[] =
      role === "assistant" && n % 3 === 0
        ? [tool("x", "bash", {}, "", "")]
        : [text("x", n % 4 === 0 ? "```ts\ncode\n```" : "x".repeat(200 + n * 700))]
    return { id: `${id}_${i}`, role, info: user("x", "", 0), parts }
  })
  return { session: session(id, title, minutesAgo), draft: draftOf(views, rewritten), picks }
}

const activeDraft = draftOf(mockPicks, false)

export const mockLoom: LoomView = {
  directory: "C:\\dev\\atlas-web",
  branch: "main",
  activeID: SID,
  sessions: [
    {
      session: session(SID, "Fix the flaky CI build", 2),
      draft: activeDraft,
      picks: mockPicks.length,
      children: [fakeSession("ses_child", "Scan CI logs for flaky specs", 3, 9, 6)],
    },
    fakeSession("ses_b", "Set up CI pipeline", 120, 2, 14),
    fakeSession("ses_c", "Migrate ESLint to flat config", 300, 3, 22, true),
    fakeSession("ses_d", "Explain the auth middleware", 1500, 4, 8),
    fakeSession("ses_e", "Replace moment with Temporal", 1700, 5, 31),
    fakeSession("ses_f", "Vitest snapshot cleanup", 4300, 6, 12, true),
    fakeSession("ses_g", "Dockerfile multi-stage build", 5800, 7, 9),
  ],
  picks: mockPicks,
  permission: mockPermission,
  todos: [],
  changed: [
    { path: "package.json", additions: 2, deletions: 2, status: "modified" },
    { path: "scripts/copy-assets.mjs", additions: 9, deletions: 3, status: "modified" },
    { path: ".github/workflows/ci.yml", additions: 31, deletions: 0, status: "added" },
  ],
  context: {
    limit: 200_000,
    spent: [
      { dye: "system", tokens: 9_800 },
      { dye: "user", tokens: 2_100 },
      { dye: "assistant", tokens: 18_400 },
      { dye: "tool", tokens: 46_100 },
      { dye: "user", tokens: 600 },
      { dye: "assistant", tokens: 1_900 },
    ],
    input: 98_100,
    output: 4_300,
    reasoning: 2_100,
    cacheRead: 19_800,
    cacheWrite: 2_100,
    cost: 0.42,
  },
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high", name: "Claude Sonnet 4.5" },
  agent: "build",
  engine: { version: "1.19.1", url: "http://127.0.0.1:4096", state: "ready" },
}
