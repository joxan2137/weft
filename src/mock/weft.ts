import type {
  Agent,
  Command,
  Model,
  Project,
  Provider,
  ProviderAuthMethod,
  QuestionRequest,
  Session,
  UserMessage,
} from "@opencode-ai/sdk/v2/types"
import { createComponent, type JSX } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { HttpError, type Actions, type Http, type OAuthStart, type WeftState } from "../engine/contract"
import { WeftContext } from "../engine/context"

const HOME = "C:\\Users\\weaver"
const ATLAS = "C:\\dev\\atlas-web"
const WEFT = "C:\\dev\\weft"
const NOTES = "D:\\notes\\term-notes"
const NOW = Date.now()
const MIN = 60_000

type ModelSpec = Partial<{
  reasoning: boolean
  attachment: boolean
  image: boolean
  pdf: boolean
  tools: boolean
  context: number
  output: number
  input: number
  out: number
  cacheRead: number
  variants: string[]
  status: Model["status"]
  released: string
}>

function model(providerID: string, id: string, name: string, o: ModelSpec = {}): Model {
  return {
    id,
    providerID,
    name,
    api: { id, url: "", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: !!o.reasoning,
      attachment: !!o.attachment,
      toolcall: o.tools ?? true,
      input: { text: true, audio: false, image: !!o.image, video: false, pdf: !!o.pdf },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: o.input ?? 0, output: o.out ?? 0, cache: { read: o.cacheRead ?? 0, write: 0 } },
    limit: { context: o.context ?? 128_000, output: o.output ?? 32_000 },
    status: o.status ?? "active",
    options: {},
    headers: {},
    release_date: o.released ?? "2026-01-15",
    variants: o.variants ? Object.fromEntries(o.variants.map((v) => [v, {}])) : undefined,
  }
}

function provider(id: string, name: string, source: Provider["source"], env: string[], models: Model[]): Provider {
  return { id, name, source, env, options: {}, models: Object.fromEntries(models.map((m) => [m.id, m])) }
}

const VISION = { image: true, pdf: true, attachment: true }

export const mockProviders: Provider[] = [
  provider("opencode", "OpenCode Zen", "custom", ["OPENCODE_API_KEY"], [
    model("opencode", "big-pickle", "Big Pickle", { reasoning: true, context: 200_000, output: 128_000, released: "2026-05-02" }),
    model("opencode", "deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash (free)", { reasoning: true, context: 128_000, released: "2026-08-20" }),
    model("opencode", "grok-code-free", "Grok Code (free)", { context: 256_000, output: 64_000, released: "2026-03-11" }),
  ]),
  provider("anthropic", "Anthropic", "api", ["ANTHROPIC_API_KEY"], [
    model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5", { ...VISION, reasoning: true, context: 200_000, output: 64_000, input: 3, out: 15, cacheRead: 0.3, variants: ["high", "max"], released: "2025-09-29" }),
    model("anthropic", "claude-opus-4-1", "Claude Opus 4.1", { ...VISION, reasoning: true, context: 200_000, output: 32_000, input: 15, out: 75, cacheRead: 1.5, variants: ["high", "max"], released: "2025-08-05" }),
    model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", { ...VISION, reasoning: true, context: 200_000, output: 64_000, input: 1, out: 5, cacheRead: 0.1, variants: ["high", "max"], released: "2025-10-15" }),
    model("anthropic", "claude-3-5-sonnet-20240620", "Claude 3.5 Sonnet", { ...VISION, status: "deprecated", released: "2024-06-20" }),
  ]),
  provider("mockoai", "Local mock", "config", [], [
    model("mockoai", "mock-1", "Mock 1", { context: 32_000, output: 4_000, tools: true, released: "2026-10-01" }),
  ]),
  provider("opencode-go", "OpenCode Go", "custom", ["OPENCODE_API_KEY"], [
    model("opencode-go", "kimi-k2.5", "Kimi K2.5", { reasoning: true, context: 256_000, input: 0.6, out: 2.5, released: "2026-07-30" }),
    model("opencode-go", "glm-5", "GLM-5", { reasoning: true, context: 200_000, input: 0.8, out: 2.6, released: "2026-06-12" }),
  ]),
  provider("openai", "OpenAI", "custom", ["OPENAI_API_KEY"], [
    model("openai", "gpt-5", "GPT-5", { ...VISION, reasoning: true, context: 400_000, output: 128_000, input: 1.25, out: 10, cacheRead: 0.125, variants: ["minimal", "low", "medium", "high"], released: "2025-08-07" }),
    model("openai", "gpt-5-codex", "GPT-5 Codex", { ...VISION, reasoning: true, context: 400_000, output: 128_000, input: 1.25, out: 10, variants: ["low", "medium", "high"], released: "2025-09-15" }),
    model("openai", "gpt-5-mini", "GPT-5 mini", { ...VISION, reasoning: true, context: 400_000, input: 0.25, out: 2, variants: ["minimal", "low", "medium", "high"], released: "2025-08-07" }),
  ]),
  provider("github-copilot", "GitHub Copilot", "custom", [], [
    model("github-copilot", "gpt-5", "GPT-5", { reasoning: true, context: 128_000, released: "2025-08-07" }),
    model("github-copilot", "claude-sonnet-4.5", "Claude Sonnet 4.5", { ...VISION, context: 128_000, released: "2025-09-29", status: "beta" }),
  ]),
  provider("google", "Google", "custom", ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"], [
    model("google", "gemini-2.5-pro", "Gemini 2.5 Pro", { ...VISION, reasoning: true, context: 1_048_576, output: 65_536, input: 1.25, out: 10, released: "2025-06-17" }),
    model("google", "gemini-2.5-flash", "Gemini 2.5 Flash", { ...VISION, reasoning: true, context: 1_048_576, output: 65_536, input: 0.3, out: 2.5, released: "2025-06-17" }),
  ]),
  provider("openrouter", "OpenRouter", "custom", ["OPENROUTER_API_KEY"], [
    model("openrouter", "qwen/qwen3-coder", "Qwen3 Coder", { context: 262_144, input: 0.2, out: 0.8, released: "2025-07-23" }),
  ]),
  provider("xai", "xAI", "custom", ["XAI_API_KEY"], [
    model("xai", "grok-4", "Grok 4", { reasoning: true, image: true, context: 256_000, input: 3, out: 15, released: "2025-07-09" }),
  ]),
  provider("cloudflare-workers-ai", "Cloudflare Workers AI", "custom", ["CLOUDFLARE_API_KEY"], [
    model("cloudflare-workers-ai", "llama-4-scout", "Llama 4 Scout", { context: 131_000, input: 0.27, out: 0.85, released: "2025-04-05" }),
  ]),
  provider("deepseek", "DeepSeek", "custom", ["DEEPSEEK_API_KEY"], [
    model("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", { reasoning: true, context: 128_000, input: 0.28, out: 0.42, released: "2025-09-29" }),
  ]),
  provider("mistral", "Mistral", "custom", ["MISTRAL_API_KEY"], [
    model("mistral", "devstral-medium", "Devstral Medium", { context: 128_000, input: 0.4, out: 2, released: "2025-07-10" }),
  ]),
]

export const mockAuth: Record<string, ProviderAuthMethod[]> = {
  openai: [
    { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
    { type: "api", label: "Manually enter API Key" },
  ],
  "github-copilot": [
    {
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Deployment",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            { label: "Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
          ],
        },
        {
          type: "text",
          key: "enterpriseUrl",
          message: "Enterprise URL or domain",
          placeholder: "company.ghe.com",
          when: { key: "deploymentType", op: "eq", value: "enterprise" },
        },
      ],
    },
  ],
  xai: [
    { type: "oauth", label: "SuperGrok Subscription" },
    { type: "api", label: "Manually enter API Key" },
  ],
  "cloudflare-workers-ai": [{ type: "api", label: "API key", prompts: [{ type: "text", key: "accountId", message: "Account ID" }] }],
}

function project(id: string, worktree: string, minutesAgo: number, name?: string): Project {
  const updated = NOW - minutesAgo * MIN
  return { id, worktree, vcs: "git", name, time: { created: updated - 30 * 86_400_000, updated }, sandboxes: [] }
}

export const mockProjects: Project[] = [
  project("prj_atlas", ATLAS, 2),
  project("prj_weft", WEFT, 95, "weft"),
  project("prj_notes", NOTES, 4 * 1440),
]

function session(id: string, directory: string, title: string, minutesAgo: number, extra: Partial<Session> = {}): Session {
  const updated = NOW - minutesAgo * MIN
  return {
    id,
    slug: id,
    projectID: directory === ATLAS ? "prj_atlas" : directory === WEFT ? "prj_weft" : "prj_notes",
    directory,
    title,
    version: "1.19.1",
    time: { created: updated - 3_600_000, updated },
    ...extra,
  }
}

export const MOCK_SESSION = "ses_mock_flaky"

const sessionList: Session[] = [
  session(MOCK_SESSION, ATLAS, "Fix the flaky CI build", 2),
  session("ses_child", ATLAS, "Scan CI logs for flaky specs", 3, { parentID: MOCK_SESSION }),
  session("ses_b", ATLAS, "Set up CI pipeline", 120),
  session("ses_c", ATLAS, "Migrate ESLint to flat config", 300),
  session("ses_d", ATLAS, "Explain the auth middleware", 1500),
  session("ses_w1", WEFT, "Draw the water", 95),
  session("ses_w2", WEFT, "Palette fuzzy search", 260),
  session("ses_n1", NOTES, "Outline the VT100 essay", 4 * 1440),
]

export const mockQuestion: QuestionRequest = {
  id: "que_mock_1",
  sessionID: MOCK_SESSION,
  questions: [
    {
      header: "Flaky specs",
      question: "Two specs fail about one run in five because they share a temp directory. How should I handle them?",
      options: [
        { label: "Fix the shared state (Recommended)", description: "Give each spec its own temp dir; no retries needed." },
        { label: "Quarantine them", description: "Move both to a separate job that may fail without blocking." },
        { label: "Retry up to 3 times", description: "Keep them as they are and let CI retry." },
      ],
    },
    {
      header: "Clean up",
      question: "Which build outputs should I delete before the five confirmation runs?",
      multiple: true,
      options: [
        { label: "dist/", description: "Stale bundle from the old build step." },
        { label: ".turbo/", description: "Task cache; rebuilt on the next run." },
        { label: "coverage/", description: "Old coverage reports." },
      ],
    },
  ],
  tool: { messageID: "msg_07", callID: "call_q1" },
}

const commands: Command[] = [
  { name: "init", description: "create or update AGENTS.md", template: "", hints: [], source: "command" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted", template: "", hints: ["$ARGUMENTS"], source: "command" },
  { name: "release-notes", description: "draft release notes from the last tag", template: "", hints: [], source: "command" },
  { name: "playwright:snapshot", description: "capture an accessibility snapshot of a page", template: "", hints: [], source: "mcp" },
  { name: "frontend-design", description: "build distinctive UI from a brief", template: "", hints: [], source: "skill" },
]

const agents = [
  { name: "build", mode: "primary", permission: [], options: {} },
  { name: "plan", mode: "primary", permission: [], options: {} },
  { name: "general", mode: "subagent", permission: [], options: {} },
  { name: "explore", mode: "subagent", permission: [], options: {} },
] as unknown as Agent[]

function userMessage(id: string, minutes: number): UserMessage {
  return {
    id,
    sessionID: MOCK_SESSION,
    role: "user",
    time: { created: NOW - minutes * MIN },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  }
}

export function mockWeftState(): WeftState {
  const byDirectory: Record<string, Session[]> = {}
  for (const s of sessionList) if (!s.parentID) (byDirectory[s.directory] ??= []).push(s)
  return {
    engine: { state: "ready", version: "1.19.1", url: "http://127.0.0.1:4096", username: "weft", password: "mock" },
    liberated: true,
    projects: mockProjects,
    home: HOME,
    directory: ATLAS,
    sessions: byDirectory,
    info: Object.fromEntries(sessionList.map((s) => [s.id, s])),
    content: {
      [MOCK_SESSION]: {
        messages: Array.from({ length: 9 }, (_, i) => userMessage(`msg_0${i}`, 40 - i * 4)),
        parts: {},
        loaded: true,
        hasOlder: false,
        loadingOlder: false,
      },
    },
    status: { [MOCK_SESSION]: { type: "idle" } },
    permissions: {},
    questions: { [MOCK_SESSION]: [mockQuestion] },
    todos: {},
    diffs: {},
    providers: {
      all: mockProviders,
      connected: ["opencode", "anthropic", "mockoai"],
      default: { opencode: "big-pickle", anthropic: "claude-sonnet-4-5", openai: "gpt-5", mockoai: "mock-1" },
      auth: mockAuth,
    },
    agents,
    commands,
    config: { model: "anthropic/claude-sonnet-4-5" },
    mcp: {},
    lsp: [],
    vcs: { branch: "main", default_branch: "main" },
    choice: { [MOCK_SESSION]: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high", agent: "build" } },
  }
}

const later = <T>(value: T, ms = 450) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

function mockActions(state: WeftState, set: SetStoreFunction<WeftState>): Actions {
  const connect = (providerID: string) =>
    set("providers", "connected", (ids) => (ids.includes(providerID) ? ids : [...ids, providerID]))
  const touch = (id: string, patch: Partial<Session>) => {
    const s = state.info[id]
    if (!s) return
    const next = { ...s, ...patch }
    set("info", id, next)
    set("sessions", s.directory, (list) => (list ?? []).map((x) => (x.id === id ? next : x)))
  }
  const newSession = (directory: string, title: string, parentID?: string) => {
    const s: Session = { ...session(`ses_${Math.random().toString(36).slice(2, 8)}`, directory, title, 0), parentID }
    set("info", s.id, s)
    if (!parentID) set("sessions", directory, (list) => [s, ...(list ?? [])])
    return s
  }
  const nothing = async () => {}

  return {
    restartEngine: async () => {
      set("engine", { state: "starting", version: "1.19.1" })
      await later(undefined, 900)
      set("engine", { state: "ready", version: "1.19.1", url: "http://127.0.0.1:4096", username: "weft", password: "mock" })
    },
    openProject: async (directory) => {
      if (!state.projects.some((p) => p.worktree === directory))
        set("projects", (list) => [...list, project(`prj_${list.length}`, directory, 0)])
      set("directory", directory)
    },
    pickProjectFolder: () => later("C:\\dev\\new-project"),
    openSession: nothing,
    closeSession: () => {},
    createSession: async (directory) => {
      const created = newSession(directory ?? state.directory ?? HOME, "New session")
      if (state.draft) set("choice", created.id, { ...state.draft, agent: "build" })
      set("draft", undefined)
      return created
    },
    renameSession: async (id, title) => {
      await later(undefined, 200)
      touch(id, { title })
    },
    removeSession: async (id) => {
      await later(undefined, 300)
      const s = state.info[id]
      if (!s) return
      set("sessions", s.directory, (list) => (list ?? []).filter((x) => x.id !== id))
      set("info", produce((info) => void delete info[id]))
    },
    archiveSession: async (id, archived) => touch(id, { time: { ...state.info[id].time, archived: archived ? Date.now() : undefined } }),
    shareSession: async (id, shared) => {
      touch(id, { share: shared ? { url: `https://opncd.ai/s/${id}` } : undefined })
      return shared ? `https://opncd.ai/s/${id}` : undefined
    },
    forkSession: async (id) => newSession(state.info[id]?.directory ?? HOME, `${state.info[id]?.title ?? "Session"} (fork)`),
    summarize: nothing,
    abort: nothing,
    revert: nothing,
    unrevert: nothing,
    exportSession: async (id) => JSON.stringify({ info: state.info[id] }, null, 2),
    loadOlder: nothing,
    send: nothing,
    command: nothing,
    shell: nothing,
    continueSession: nothing,
    regenerate: nothing,
    setModel: (sessionID, providerID, modelID, variant) =>
      set("choice", sessionID, (c) => ({ agent: c?.agent ?? "build", providerID, modelID, variant })),
    setDraftModel: (providerID, modelID, variant) => set("draft", { providerID, modelID, variant }),
    setAgent: (sessionID, agent) => set("choice", sessionID, "agent", agent),
    replyPermission: nothing,
    answerQuestion: async (sessionID, requestID) => {
      await later(undefined, 300)
      set("questions", sessionID, (list) => (list ?? []).filter((q) => q.id !== requestID))
    },
    rejectQuestion: async (sessionID, requestID) => {
      await later(undefined, 200)
      set("questions", sessionID, (list) => (list ?? []).filter((q) => q.id !== requestID))
    },
    connectKey: async (providerID, key) => {
      await later(undefined)
      if (key.length < 8) throw new HttpError(400, undefined, "That key looks too short.")
      connect(providerID)
    },
    oauthStart: async (providerID, method): Promise<OAuthStart | undefined> => {
      await later(undefined, 300)
      const chosen = state.providers.auth[providerID]?.[method]
      if (chosen?.type !== "oauth") return undefined
      const headless = /headless/i.test(chosen.label) || providerID === "github-copilot"
      return {
        url: `https://example.invalid/${providerID}/authorize?client=weft-mock&state=${method}`,
        method: headless ? "code" : "auto",
        instructions: headless
          ? "Sign in, then paste the code the page shows."
          : "Complete authorization in your browser. This window will close automatically.",
      }
    },
    oauthFinish: async (providerID, _method, code) => {
      await later(undefined, code === undefined ? 4000 : 600)
      connect(providerID)
    },
    disconnect: async (providerID) => {
      await later(undefined, 250)
      set("providers", "connected", (ids) => ids.filter((id) => id !== providerID))
    },
    findFiles: async () => [],
    mcpConnect: nothing,
    mcpAuthenticate: nothing,
    updateConfig: nothing,
    editPart: nothing,
    setRole: nothing,
    editSystem: nothing,
    removeMessage: nothing,
    removePart: nothing,
    setMuted: nothing,
    insertAfter: nothing,
    move: nothing,
    resendFrom: nothing,
  }
}

const offline = (): Promise<never> => Promise.reject(new HttpError(503, undefined, "mock engine: no HTTP"))

const mockHttp: Http = {
  get: offline,
  post: offline,
  put: offline,
  patch: offline,
  del: offline,
  url: (path) => `http://127.0.0.1:4096${path}`,
  auth: () => `Basic ${btoa("weft:mock")}`,
}

export type MockWeft = { state: WeftState; setState: SetStoreFunction<WeftState>; actions: Actions; http: Http }

/** A live, in-memory WeftState with Actions that mutate it, for demos and screenshots without an engine. */
export function createMockWeft(): MockWeft {
  const [state, setState] = createStore(mockWeftState())
  return { state, setState, actions: mockActions(state, setState), http: mockHttp }
}

/** Provides the same context as the real engine provider, backed by createMockWeft(). */
export function MockWeftProvider(props: { weft?: MockWeft; children: JSX.Element }) {
  const weft = props.weft ?? createMockWeft()
  return createComponent(WeftContext.Provider, {
    value: { state: weft.state, actions: weft.actions, http: weft.http },
    get children() {
      return props.children
    },
  })
}
