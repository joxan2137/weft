import type { Config, FilePartInput, Part } from "@opencode-ai/sdk/v2/types"
import { createEffect, createRoot } from "solid-js"
import { inTauri } from "../ui/platform"
import { ascendingID, type Api, type ModelRef, type PromptPartInput } from "./api"
import type { Connection } from "./connection"
import type { Actions, Http, Mention } from "./contract"
import { carryMetaToFork, createLiberation } from "./liberate"
import type { Choice, WeftStore } from "./store"

const FILE_RESULTS = 50
/** The legacy /command and /shell routes answer when the turn ends; a refusal comes back well within this. */
const ACCEPT_MS = 400

/** Asks the user before `PATCH /global/config`, the config file OpenCode Desktop shares. */
export type ConfirmConfig = (patch: Partial<Config>) => Promise<boolean>

const modelOf = (choice: Choice | undefined): ModelRef | undefined =>
  choice?.providerID && choice.modelID ? { providerID: choice.providerID, modelID: choice.modelID } : undefined

function absolutePath(directory: string, path: string) {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(path)) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

function fileURL(path: string) {
  const normalized = path.replace(/\\/g, "/")
  const rooted = /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized
  const encoded = rooted
    .split("/")
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")
  return `file://${encoded}`
}

function mentionPart(directory: string, mention: Mention): FilePartInput {
  const path = absolutePath(directory, mention.path)
  return {
    id: ascendingID("part"),
    type: "file",
    mime: "text/plain",
    filename: mention.path.split(/[\\/]/).pop() || mention.path,
    url: fileURL(path),
    source: { type: "file", path, text: { value: `@${mention.path}`, start: mention.start ?? 0, end: mention.end ?? 0 } },
  }
}

export function createActions(deps: {
  api: Api
  http: Http
  store: WeftStore
  connection: Connection
  confirmConfig?: ConfirmConfig
}): Actions {
  const { api, http, store, connection } = deps
  const { state } = store

  const directoryOf = (sessionID: string) => state.info[sessionID]?.directory ?? state.directory
  const activeDirectory = () => {
    if (!state.directory) throw new Error("Open a project first")
    return state.directory
  }

  async function continueSession(sessionID: string) {
    const choice = store.choiceFor(sessionID)
    store.clearError(sessionID)
    await api.session.promptAsync(sessionID, {
      agent: choice?.agent,
      model: modelOf(choice),
      variant: choice?.variant,
      parts: [],
    })
  }

  /**
   * Settles once the engine has had time to refuse the request, so the caller is not held for the
   * whole turn; a later failure lands in `state.errors` like any other session error.
   */
  function dispatched(sessionID: string, request: Promise<unknown>) {
    let settled = false
    request.catch((error) => {
      if (settled) store.fail(sessionID, error)
    })
    return Promise.race([request.then(() => undefined), new Promise<void>((done) => setTimeout(done, ACCEPT_MS))]).finally(
      () => (settled = true),
    )
  }

  const running = () => Object.values(state.status).some((status) => status.type !== "idle")
  /** Engine reloads asked for while replies were running; they run together once every session is idle. */
  const deferredReloads: (() => Promise<unknown>)[] = []

  function whenIdle(reload: () => Promise<unknown>) {
    deferredReloads.push(reload)
    if (deferredReloads.length > 1) return
    createRoot((dispose) =>
      createEffect(() => {
        if (running()) return
        dispose()
        const reloads = deferredReloads.splice(0)
        void Promise.allSettled(reloads.map((run) => run()))
          .then(() => store.refreshProviders())
          .catch((error) => console.warn("[weft] deferred engine reload:", error))
      }),
    )
  }

  /**
   * New credentials reach the engine only when its instances reload, which stops running replies:
   * while any session is busy the reload waits until they finish.
   */
  async function reloadForCredentials(reload: () => Promise<unknown>) {
    if (running()) whenIdle(reload)
    else await reload()
    await store.refreshProviders()
  }

  const afterCredentials = () =>
    reloadForCredentials(() => Promise.allSettled([api.instance.dispose(state.directory), api.instance.dispose()]))

  const liberation = createLiberation({
    http,
    info: (sessionID) => state.info[sessionID],
    content: (sessionID) => state.content[sessionID],
    directory: directoryOf,
    continueSession,
  })

  return {
    restartEngine: () => connection.restart(),

    openProject: (directory) => store.openDirectory(directory),
    async pickProjectFolder() {
      const start = state.directory ?? (state.home || undefined)
      if (inTauri) {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const picked = await open({ directory: true, multiple: false, defaultPath: start })
        return typeof picked === "string" ? picked : undefined
      }
      return window.prompt("Project folder", start)?.trim() || undefined
    },

    openSession: (id) => store.open(id),
    closeSession: () => store.close(),
    async createSession(directory) {
      const session = await api.session.create(directory ?? activeDirectory())
      store.remember(session)
      store.ensureContent(session.id, true)
      const draft = store.takeDraft()
      if (draft) store.setChoice(session.id, { ...draft, agent: store.defaultAgent() })
      return state.info[session.id] ?? session
    },
    async renameSession(id, title) {
      store.remember(await api.session.update(id, { title }))
    },
    async removeSession(id) {
      await api.session.remove(id)
      store.forget(id)
    },
    async archiveSession(id, archived) {
      store.remember(await api.session.update(id, { time: { archived: archived ? Date.now() : 0 } }))
    },
    async shareSession(id, shared) {
      const session = shared ? await api.session.share(id) : await api.session.unshare(id)
      store.remember(session)
      return session.share?.url
    },
    async forkSession(id, fromMessageID, drop) {
      const fork = await api.session.fork(id, fromMessageID)
      store.remember(fork)
      const carried = await carryMetaToFork(http, id, fork, fromMessageID, directoryOf(id), drop)
      store.remember(carried)
      return state.info[carried.id] ?? carried
    },
    async summarize(id) {
      const model = modelOf(store.choiceFor(id))
      if (!model) throw new Error("Choose a model first")
      await api.session.summarize(id, model)
    },
    async abort(id) {
      await api.session.abort(id)
      store.clearTodos(id)
    },
    async revert(id, messageID) {
      store.remember(await api.session.revert(id, messageID))
    },
    async unrevert(id) {
      store.remember(await api.session.unrevert(id))
    },
    async exportSession(id) {
      const [info, page] = await Promise.all([api.session.get(id), api.session.messages(id)])
      return JSON.stringify({ info, messages: page.items }, null, 2)
    },
    loadOlder: (id) => store.loadOlder(id),

    async send(sessionID, text, attachments = [], mentions = []) {
      const session = state.info[sessionID] ?? (await store.resolve(sessionID))
      if (!session) throw new Error("This session no longer exists")
      const choice = store.choiceFor(sessionID)
      const messageID = ascendingID("message")
      const parts: PromptPartInput[] = []
      if (text.trim()) parts.push({ id: ascendingID("part"), type: "text", text })
      for (const attachment of attachments)
        parts.push({ id: ascendingID("part"), type: "file", mime: attachment.mime, filename: attachment.name, url: attachment.url })
      for (const mention of mentions) parts.push(mentionPart(session.directory, mention))
      if (parts.length === 0) return

      store.clearError(sessionID)
      store.addPending(
        {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: choice?.agent ?? store.defaultAgent(),
          model: { providerID: choice?.providerID ?? "", modelID: choice?.modelID ?? "", variant: choice?.variant },
        },
        parts.map((part) => ({ ...part, sessionID, messageID }) as Part),
      )
      try {
        await api.session.promptAsync(sessionID, {
          messageID,
          agent: choice?.agent,
          model: modelOf(choice),
          variant: choice?.variant,
          parts,
        })
      } catch (error) {
        store.dropPending(sessionID, messageID)
        throw error
      }
    },
    async command(sessionID, name, args) {
      const choice = store.choiceFor(sessionID)
      const model = modelOf(choice)
      store.clearError(sessionID)
      await dispatched(
        sessionID,
        api.session.command(sessionID, {
          messageID: ascendingID("message"),
          command: name,
          arguments: args,
          agent: choice?.agent,
          model: model && `${model.providerID}/${model.modelID}`,
          variant: choice?.variant,
        }),
      )
    },
    async shell(sessionID, command) {
      const choice = store.choiceFor(sessionID)
      store.clearError(sessionID)
      await dispatched(
        sessionID,
        api.session.shell(sessionID, { agent: choice?.agent ?? store.defaultAgent(), model: modelOf(choice), command }),
      )
    },
    continueSession,
    setModel(sessionID, providerID, modelID, variant) {
      const agent = store.choiceFor(sessionID)?.agent ?? store.defaultAgent()
      store.setChoice(sessionID, { providerID, modelID, variant, agent })
    },
    setDraftModel(providerID, modelID, variant) {
      store.setDraft({ providerID, modelID, variant })
    },
    setAgent(sessionID, agent) {
      const current = store.choiceFor(sessionID)
      const own = store.agentChoice(agent)
      if (own) store.setChoice(sessionID, own)
      else if (current?.providerID) store.setChoice(sessionID, { ...current, agent })
      else store.setChoice(sessionID, { providerID: "", modelID: "", agent })
    },

    async replyPermission(sessionID, requestID, reply, message) {
      await api.permission.reply(directoryOf(sessionID), requestID, reply, message)
      store.removeRequest("permissions", sessionID, requestID)
    },
    async answerQuestion(sessionID, requestID, answers) {
      await api.question.reply(directoryOf(sessionID), requestID, answers)
      store.removeRequest("questions", sessionID, requestID)
    },
    async rejectQuestion(sessionID, requestID) {
      await api.question.reject(directoryOf(sessionID), requestID)
      store.removeRequest("questions", sessionID, requestID)
    },

    async connectKey(providerID, key, metadata) {
      await api.auth.setKey(providerID, key, metadata)
      await afterCredentials()
    },
    async oauthStart(providerID, method, inputs) {
      const authorization = await api.provider.authorize(state.directory, providerID, method, inputs)
      if (!authorization) return undefined
      return { url: authorization.url, method: authorization.method, instructions: authorization.instructions }
    },
    async oauthFinish(providerID, method, code) {
      await api.provider.callback(state.directory, providerID, method, code)
      await afterCredentials()
    },
    async disconnect(providerID) {
      await api.auth.remove(providerID)
      await reloadForCredentials(() => api.global.dispose())
    },

    findFiles: (query) => api.find.files(activeDirectory(), query, { limit: FILE_RESULTS }),
    async mcpConnect(name, connect) {
      const directory = activeDirectory()
      await (connect ? api.mcp.connect(directory, name) : api.mcp.disconnect(directory, name))
      await store.refreshMcp()
    },
    async mcpAuthenticate(name) {
      await api.mcp.authenticate(activeDirectory(), name)
      await store.refreshMcp()
    },
    async updateConfig(patch) {
      if (!(await deps.confirmConfig?.(patch))) throw new Error("The global opencode config was left unchanged")
      await api.global.updateConfig(patch)
      await store.refreshConfig()
    },

    ...liberation,
  }
}
