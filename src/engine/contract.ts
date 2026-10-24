// The seams between the engine layer and the UI. Engine modules implement these; UI modules
// consume them. Changing a signature here means changing both sides (docs/DESIGN.md Part B).
import type {
  Agent,
  Command,
  Config,
  FileDiff,
  LspStatus,
  McpStatus,
  Message,
  Part,
  PermissionRequest,
  Project,
  Provider,
  ProviderAuthMethod,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/types"
import type { Seam, SeamCard } from "./seam"
import type { Role } from "./view"

// ───────── transport ─────────

export type Query = Record<string, string | number | boolean | undefined>

export type HttpOptions = {
  /** Instance directory; sent as the URI-encoded `x-opencode-directory` header. */
  directory?: string
  query?: Query
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type HttpResponse<T> = { data: T; status: number; headers: Headers }

export interface Http {
  get<T>(path: string, opts?: HttpOptions): Promise<HttpResponse<T>>
  post<T>(path: string, opts?: HttpOptions): Promise<HttpResponse<T>>
  put<T>(path: string, opts?: HttpOptions): Promise<HttpResponse<T>>
  patch<T>(path: string, opts?: HttpOptions): Promise<HttpResponse<T>>
  del<T>(path: string, opts?: HttpOptions): Promise<HttpResponse<T>>
  /** Absolute URL for a path, for EventSource-like consumers and PTY websockets. */
  url(path: string, query?: Query): string
  /** `Authorization` header value. */
  auth(): string
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message)
  }
}

// ───────── engine ─────────

export type EngineState =
  | { state: "idle" }
  | { state: "resolving" }
  /** `progress` stays 0 while the download size is unknown (`total` missing); `received` counts bytes. */
  | { state: "installing"; version: string; progress: number; received?: number; total?: number }
  | { state: "starting"; version: string }
  | { state: "ready"; version: string; url: string; username: string; password: string; notice?: string }
  | { state: "error"; kind: string; message: string }

// ───────── store (read-only to the UI) ─────────

export type ProviderCatalog = {
  all: Provider[]
  connected: string[]
  default: Record<string, string>
  auth: Record<string, ProviderAuthMethod[]>
}

export type SessionContent = {
  /** sorted by (time.created, id) */
  messages: Message[]
  /** by message id, sorted by part id */
  parts: Record<string, Part[]>
  loaded: boolean
  hasOlder: boolean
  loadingOlder: boolean
}

export type WeftState = {
  engine: EngineState
  /** set once the plugin canary tool is confirmed (undefined while unknown) */
  liberated: boolean | undefined
  projects: Project[]
  home: string
  /** active project directory */
  directory: string | undefined
  /** root sessions per directory, newest first */
  sessions: Record<string, Session[]>
  /** archived root sessions per directory, newest first (kept out of `sessions`) */
  archived?: Record<string, Session[]>
  /** every known session by id (roots and children) */
  info: Record<string, Session>
  content: Record<string, SessionContent>
  status: Record<string, SessionStatus>
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  todos: Record<string, Todo[]>
  diffs: Record<string, FileDiff[]>
  providers: ProviderCatalog
  agents: Agent[]
  commands: Command[]
  config: Config | undefined
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  /** last user-chosen model and agent, per session (falls back to config defaults) */
  choice: Record<string, { providerID: string; modelID: string; variant?: string; agent: string }>
  /** model chosen before any session exists; the next `createSession` starts with it */
  draft?: { providerID: string; modelID: string; variant?: string }
  /**
   * Last `session.error` per session, cleared when the next prompt starts. `prompt_async` failures
   * (unknown agent or model, unreadable mention) arrive only this way, with no assistant message.
   */
  errors?: Record<string, SessionError>
}

/** `unsent`: the text of a prompt the engine refused before storing it, for the composer to give back. */
export type SessionError = { name: string; message: string; at: number; unsent?: string }

// ───────── actions ─────────

export type Attachment = { name: string; mime: string; url: string }
export type Mention = { path: string; start?: number; end?: number }

export type PermissionReply = "once" | "always" | "reject"

export type OAuthStart = { url: string; method: "auto" | "code"; instructions: string }

export interface Actions {
  // engine
  restartEngine(): Promise<void>

  // projects
  openProject(directory: string): Promise<void>
  pickProjectFolder(): Promise<string | undefined>

  // sessions
  openSession(id: string): Promise<void>
  /** The loom shows no session: stop refetching the one opened last. */
  closeSession(): void
  createSession(directory?: string): Promise<Session>
  renameSession(id: string, title: string): Promise<void>
  removeSession(id: string): Promise<void>
  archiveSession(id: string, archived: boolean): Promise<void>
  shareSession(id: string, shared: boolean): Promise<string | undefined>
  /** `drop`: source message ids whose copies are deleted from the fork (liberate.ts `forkPlan`) */
  forkSession(id: string, fromMessageID?: string, drop?: string[]): Promise<Session>
  summarize(id: string): Promise<void>
  abort(id: string): Promise<void>
  revert(id: string, messageID: string): Promise<void>
  unrevert(id: string): Promise<void>
  exportSession(id: string): Promise<string>
  loadOlder(id: string): Promise<void>

  // prompting
  send(sessionID: string, text: string, attachments?: Attachment[], mentions?: Mention[]): Promise<void>
  command(sessionID: string, name: string, args: string): Promise<void>
  shell(sessionID: string, command: string): Promise<void>
  continueSession(sessionID: string): Promise<void>
  regenerate(sessionID: string, assistantID: string): Promise<void>
  setModel(sessionID: string, providerID: string, modelID: string, variant?: string): void
  setAgent(sessionID: string, agent: string): void
  /** The model the next new session starts with (`WeftState.draft`), for a choice made before any session exists. */
  setDraftModel?(providerID: string, modelID: string, variant?: string): void

  // requests
  replyPermission(sessionID: string, requestID: string, reply: PermissionReply, message?: string): Promise<void>
  answerQuestion(sessionID: string, requestID: string, answers: QuestionAnswer[]): Promise<void>
  rejectQuestion(sessionID: string, requestID: string): Promise<void>

  // providers
  /** `metadata`: the answers to the API method's prompts (an account id, a resource name), stored with the key */
  connectKey(providerID: string, key: string, metadata?: Record<string, string>): Promise<void>
  oauthStart(providerID: string, method: number, inputs?: Record<string, string>): Promise<OAuthStart | undefined>
  oauthFinish(providerID: string, method: number, code?: string): Promise<void>
  disconnect(providerID: string): Promise<void>

  // project tools
  findFiles(query: string): Promise<string[]>
  mcpConnect(name: string, connect: boolean): Promise<void>
  mcpAuthenticate(name: string): Promise<void>
  updateConfig(patch: Partial<Config>): Promise<void>

  // liberation (docs/DESIGN.md B.5)
  editPart(sessionID: string, messageID: string, partID: string, text: string): Promise<void>
  setRole(sessionID: string, messageID: string, role: Role): Promise<void>
  editSystem(sessionID: string, template: string | undefined): Promise<void>
  /** A user message goes with its replies (the turn Desktop's timeline shows) unless `keepReplies`. */
  removeMessage(sessionID: string, messageID: string, keepReplies?: boolean): Promise<void>
  removePart(sessionID: string, messageID: string, partID: string): Promise<void>
  setMuted(sessionID: string, messageID: string, muted: boolean): Promise<void>
  insertAfter(sessionID: string, afterMessageID: string | undefined, text: string, role: Role): Promise<void>
  move(sessionID: string, messageID: string, beforeMessageID: string | undefined): Promise<void>
  /** `partID`: the prose part the editor changed; the message's other parts are kept as they are. */
  resendFrom(sessionID: string, userMessageID: string, text: string, partID?: string): Promise<void>

  // seam: a hand-off taken between turns (seam.ts)
  /** Builds the card without storing it, for the review dialog. */
  seamPreview(sessionID: string, keepFrom?: string): Promise<Seam>
  /** Elides every message before `keepFrom` (or a quarter of the window when omitted) and pins the card. */
  seamSession(sessionID: string, keepFrom?: string, card?: SeamCard): Promise<Seam>
  unseamSession(sessionID: string): Promise<void>
}
