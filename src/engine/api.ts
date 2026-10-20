import type {
  Agent,
  AgentPartInput,
  Command,
  Config,
  FilePartInput,
  LspStatus,
  McpStatus,
  Message,
  OutputFormat,
  Part,
  Path,
  PermissionRequest,
  PermissionRuleset,
  Project,
  Provider,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  Pty,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  SubtaskPartInput,
  TextPartInput,
  Todo,
  VcsFileDiff,
  VcsFileStatus,
  VcsInfo,
} from "@opencode-ai/sdk/v2/types"
import { HttpError, type Http, type HttpOptions, type HttpResponse, type PermissionReply, type Query } from "./contract"

// ───────── transport ─────────

export type Credentials = { url: string; username: string; password: string }

export function basicAuth(username: string, password: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function describe(status: number, body: unknown) {
  if (typeof body === "string" && body.trim() && !body.trimStart().startsWith("<")) return body.trim()
  if (body && typeof body === "object") {
    const record = body as { name?: string; message?: string; _tag?: string; data?: { message?: string } }
    if (record.data?.message) return record.data.message
    if (record.message) return record.message
    if (record._tag === "BadRequest") return "The engine rejected the request"
    if (record._tag) return record._tag
    if (record.name) return record.name
  }
  if (status === 401) return "The engine refused the credentials"
  if (status === 404) return "Not found"
  if (status === 409) return "The session is busy"
  return `The engine answered ${status}`
}

export function createHttp(credentials: () => Credentials | undefined): Http {
  const current = () => {
    const value = credentials()
    if (!value) throw new HttpError(0, undefined, "The engine is not running")
    return value
  }

  const url = (path: string, query?: Query) => {
    const target = new URL(path.startsWith("/") ? path : `/${path}`, current().url)
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) target.searchParams.set(key, String(value))
    return target.toString()
  }

  const auth = () => {
    const { username, password } = current()
    return basicAuth(username, password)
  }

  async function request<T>(method: string, path: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { accept: "application/json", authorization: auth(), ...opts.headers }
    if (opts.directory) headers["x-opencode-directory"] = encodeURIComponent(opts.directory)
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    if (body !== undefined) headers["content-type"] = "application/json"

    let response: Response
    try {
      response = await fetch(url(path, opts.query), { method, headers, body, signal: opts.signal })
    } catch (error) {
      if (opts.signal?.aborted) throw error
      console.warn(`[weft] ${method} ${path} failed:`, error)
      throw new HttpError(0, undefined, "Weft lost the connection to the engine. It may be restarting; try again in a moment.")
    }

    const data = await readBody(response)
    if (!response.ok) throw new HttpError(response.status, data, describe(response.status, data))
    if (response.headers.get("content-type")?.includes("text/html")) {
      console.warn(`[weft] ${method} ${path} is not served by this engine`)
      throw new HttpError(response.status, undefined, "This engine version does not support that action.")
    }
    return { data: data as T, status: response.status, headers: response.headers }
  }

  return {
    get: <T>(path: string, opts?: HttpOptions) => request<T>("GET", path, opts),
    post: <T>(path: string, opts?: HttpOptions) => request<T>("POST", path, opts),
    put: <T>(path: string, opts?: HttpOptions) => request<T>("PUT", path, opts),
    patch: <T>(path: string, opts?: HttpOptions) => request<T>("PATCH", path, opts),
    del: <T>(path: string, opts?: HttpOptions) => request<T>("DELETE", path, opts),
    url,
    auth,
  }
}

export const isBusy = (error: unknown) => error instanceof HttpError && error.status === 409
export const isNotFound = (error: unknown) => error instanceof HttpError && error.status === 404

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

// ───────── ids (opencode's ascending identifier: prefix_ + 12 hex of ms*4096+n + 14 base62) ─────────

const ID_PREFIX = { session: "ses", message: "msg", part: "prt" } as const
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastStamp = 0
let stampCounter = 0

export function ascendingID(kind: keyof typeof ID_PREFIX) {
  const stamp = Date.now()
  if (stamp !== lastStamp) {
    lastStamp = stamp
    stampCounter = 0
  }
  stampCounter += 1
  const value = BigInt(stamp) * 0x1000n + BigInt(stampCounter)
  let hex = ""
  for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")
  const random = crypto.getRandomValues(new Uint8Array(14))
  let tail = ""
  for (const byte of random) tail += BASE62[byte % 62]
  return `${ID_PREFIX[kind]}_${hex}${tail}`
}

// ───────── routes (legacy surface only; never /api/session/*/prompt) ─────────

export type MessageWithParts = { info: Message; parts: Part[] }
export type MessagePage = { items: MessageWithParts[]; cursor: string | undefined }
export type PromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
export type ModelRef = { providerID: string; modelID: string }

export type PromptBody = {
  messageID?: string
  model?: ModelRef
  agent?: string
  noReply?: boolean
  format?: OutputFormat
  system?: string
  variant?: string
  parts: PromptPartInput[]
}

export type CommandBody = {
  messageID?: string
  agent?: string
  /** "providerID/modelID" */
  model?: string
  variant?: string
  command: string
  arguments: string
  parts?: FilePartInput[]
}

export type ShellBody = { messageID?: string; agent: string; model?: ModelRef; command: string }

export type SessionCreate = {
  parentID?: string
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
  permission?: PermissionRuleset
}

export type SessionPatch = {
  title?: string
  metadata?: Record<string, unknown>
  permission?: PermissionRuleset
  time?: { archived?: number }
}

export type SessionListQuery = { roots?: boolean; limit?: number; search?: string; start?: number; scope?: "project"; path?: string }
export type ProviderList = { all: Provider[]; default: Record<string, string>; connected: string[] }
export type Health = { healthy: true; version: string }

export type Api = ReturnType<typeof createApi>

export function createApi(http: Http) {
  const data = async <T>(response: Promise<HttpResponse<T>>) => (await response).data
  const at = (directory: string | undefined): HttpOptions => (directory ? { directory } : {})
  const sessionPath = (id: string) => `/session/${encodeURIComponent(id)}`
  const messagePath = (id: string, messageID: string) => `${sessionPath(id)}/message/${encodeURIComponent(messageID)}`

  return {
    health: () => data(http.get<Health>("/global/health")),
    path: (directory?: string) => data(http.get<Path>("/path", at(directory))),

    global: {
      config: () => data(http.get<Config>("/global/config")),
      updateConfig: (patch: Partial<Config>) => data(http.patch<Config>("/global/config", { body: patch })),
      dispose: () => data(http.post<boolean>("/global/dispose")),
    },

    instance: {
      dispose: (directory?: string) => data(http.post<boolean>("/instance/dispose", at(directory))),
    },

    config: {
      get: (directory: string) => data(http.get<Config>("/config", at(directory))),
      update: (directory: string, patch: Partial<Config>) =>
        data(http.patch<Config>("/config", { ...at(directory), body: patch })),
    },

    project: {
      list: () => data(http.get<Project[]>("/project")),
      current: (directory: string) => data(http.get<Project>("/project/current", at(directory))),
    },

    session: {
      list: (directory: string, query: SessionListQuery = {}) =>
        data(http.get<Session[]>("/session", { ...at(directory), query })),
      status: (directory: string) => data(http.get<Record<string, SessionStatus>>("/session/status", at(directory))),
      get: (id: string) => data(http.get<Session>(sessionPath(id))),
      create: (directory: string, body: SessionCreate = {}) =>
        data(http.post<Session>("/session", { ...at(directory), body })),
      update: (id: string, patch: SessionPatch) => data(http.patch<Session>(sessionPath(id), { body: patch })),
      remove: (id: string) => data(http.del<boolean>(sessionPath(id))),
      children: (id: string) => data(http.get<Session[]>(`${sessionPath(id)}/children`)),
      todo: (id: string) => data(http.get<Todo[]>(`${sessionPath(id)}/todo`)),
      diff: (id: string, messageID?: string) =>
        data(http.get<SnapshotFileDiff[]>(`${sessionPath(id)}/diff`, { query: { messageID } })),

      /** Newest `limit` messages before `before`, oldest first; `cursor` continues further back. */
      messages: async (id: string, page: { limit?: number; before?: string } = {}): Promise<MessagePage> => {
        const response = await http.get<MessageWithParts[]>(`${sessionPath(id)}/message`, {
          query: { limit: page.limit, before: page.before },
        })
        return { items: response.data ?? [], cursor: response.headers.get("x-next-cursor") ?? undefined }
      },
      message: (id: string, messageID: string) => data(http.get<MessageWithParts>(messagePath(id, messageID))),
      removeMessage: (id: string, messageID: string) => data(http.del<boolean>(messagePath(id, messageID))),
      updatePart: (part: Part) =>
        data(http.patch<Part>(`${messagePath(part.sessionID, part.messageID)}/part/${encodeURIComponent(part.id)}`, { body: part })),
      removePart: (id: string, messageID: string, partID: string) =>
        data(http.del<boolean>(`${messagePath(id, messageID)}/part/${encodeURIComponent(partID)}`)),

      /** Blocks until the turn ends; with `noReply` it only stores the user message. */
      prompt: (id: string, body: PromptBody) => data(http.post<MessageWithParts>(`${sessionPath(id)}/message`, { body })),
      promptAsync: (id: string, body: PromptBody) => data(http.post<void>(`${sessionPath(id)}/prompt_async`, { body })),
      command: (id: string, body: CommandBody) => data(http.post<MessageWithParts>(`${sessionPath(id)}/command`, { body })),
      shell: (id: string, body: ShellBody) => data(http.post<MessageWithParts>(`${sessionPath(id)}/shell`, { body })),

      fork: (id: string, messageID?: string) =>
        data(http.post<Session>(`${sessionPath(id)}/fork`, { body: messageID ? { messageID } : {} })),
      summarize: (id: string, model: ModelRef) =>
        data(http.post<boolean>(`${sessionPath(id)}/summarize`, { body: model })),
      abort: (id: string) => data(http.post<boolean>(`${sessionPath(id)}/abort`)),
      revert: (id: string, messageID: string, partID?: string) =>
        data(http.post<Session>(`${sessionPath(id)}/revert`, { body: { messageID, partID } })),
      unrevert: (id: string) => data(http.post<Session>(`${sessionPath(id)}/unrevert`)),
      share: (id: string) => data(http.post<Session>(`${sessionPath(id)}/share`)),
      unshare: (id: string) => data(http.del<Session>(`${sessionPath(id)}/share`)),
    },

    permission: {
      list: (directory: string) => data(http.get<PermissionRequest[]>("/permission", at(directory))),
      reply: (directory: string | undefined, requestID: string, reply: PermissionReply, message?: string) =>
        data(http.post<boolean>(`/permission/${encodeURIComponent(requestID)}/reply`, { ...at(directory), body: { reply, message } })),
    },

    question: {
      list: (directory: string) => data(http.get<QuestionRequest[]>("/question", at(directory))),
      reply: (directory: string | undefined, requestID: string, answers: QuestionAnswer[]) =>
        data(http.post<boolean>(`/question/${encodeURIComponent(requestID)}/reply`, { ...at(directory), body: { answers } })),
      reject: (directory: string | undefined, requestID: string) =>
        data(http.post<boolean>(`/question/${encodeURIComponent(requestID)}/reject`, at(directory))),
    },

    provider: {
      list: (directory?: string) => data(http.get<ProviderList>("/provider", at(directory))),
      auth: (directory?: string) => data(http.get<Record<string, ProviderAuthMethod[]>>("/provider/auth", at(directory))),
      authorize: (directory: string | undefined, providerID: string, method: number, inputs?: Record<string, string>) =>
        data(
          http.post<ProviderAuthAuthorization | undefined>(`/provider/${encodeURIComponent(providerID)}/oauth/authorize`, {
            ...at(directory),
            body: { method, inputs },
          }),
        ),
      callback: (directory: string | undefined, providerID: string, method: number, code?: string) =>
        data(
          http.post<boolean>(`/provider/${encodeURIComponent(providerID)}/oauth/callback`, {
            ...at(directory),
            body: { method, code },
          }),
        ),
    },

    auth: {
      setKey: (providerID: string, key: string, metadata?: Record<string, string>) =>
        data(http.put<boolean>(`/auth/${encodeURIComponent(providerID)}`, { body: { type: "api", key, ...(metadata && { metadata }) } })),
      remove: (providerID: string) => data(http.del<boolean>(`/auth/${encodeURIComponent(providerID)}`)),
    },

    vcs: {
      get: (directory: string) => data(http.get<VcsInfo>("/vcs", at(directory))),
      status: (directory: string) => data(http.get<VcsFileStatus[]>("/vcs/status", at(directory))),
      diff: (directory: string, mode: "git" | "branch", context?: number) =>
        data(http.get<VcsFileDiff[]>("/vcs/diff", { ...at(directory), query: { mode, context } })),
    },

    find: {
      files: (directory: string, query: string, options: { dirs?: boolean; limit?: number } = {}) =>
        data(
          http.get<string[]>("/find/file", {
            ...at(directory),
            query: { query, dirs: options.dirs === undefined ? undefined : String(options.dirs), limit: options.limit },
          }),
        ),
    },

    mcp: {
      status: (directory: string) => data(http.get<Record<string, McpStatus>>("/mcp", at(directory))),
      connect: (directory: string, name: string) =>
        data(http.post<boolean>(`/mcp/${encodeURIComponent(name)}/connect`, at(directory))),
      disconnect: (directory: string, name: string) =>
        data(http.post<boolean>(`/mcp/${encodeURIComponent(name)}/disconnect`, at(directory))),
      authenticate: (directory: string, name: string) =>
        data(http.post<McpStatus>(`/mcp/${encodeURIComponent(name)}/auth/authenticate`, at(directory))),
    },

    lsp: { status: (directory: string) => data(http.get<LspStatus[]>("/lsp", at(directory))) },
    agents: (directory: string) => data(http.get<Agent[]>("/agent", at(directory))),
    commands: (directory: string) => data(http.get<Command[]>("/command", at(directory))),
    toolIDs: (directory: string) => data(http.get<string[]>("/experimental/tool/ids", at(directory))),

    pty: {
      shells: (directory: string) =>
        data(http.get<{ path: string; name: string; acceptable: boolean }[]>("/pty/shells", at(directory))),
      create: (directory: string, body: { command?: string; args?: string[]; cwd?: string; title?: string } = {}) =>
        data(http.post<Pty>("/pty", { ...at(directory), body })),
      resize: (directory: string, id: string, size: { rows: number; cols: number }) =>
        data(http.put<Pty>(`/pty/${encodeURIComponent(id)}`, { ...at(directory), body: { size } })),
      remove: (directory: string, id: string) => data(http.del<boolean>(`/pty/${encodeURIComponent(id)}`, at(directory))),
      /** Single-use ticket for `ws …/pty/:id/connect?ticket=` (valid 60 s). */
      ticket: (directory: string, id: string) =>
        data(
          http.post<{ ticket: string; expires_in: number }>(`/pty/${encodeURIComponent(id)}/connect-token`, {
            ...at(directory),
            headers: { "x-opencode-ticket": "1" },
          }),
        ),
    },
  }
}
