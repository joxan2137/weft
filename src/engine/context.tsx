import { createContext, createEffect, createMemo, on, onCleanup, useContext, type ParentProps } from "solid-js"
import { createActions, type ConfirmConfig } from "./actions"
import { createApi, createHttp } from "./api"
import { createConnection, credentialsOf } from "./connection"
import type { Actions, EngineState, Http, WeftState } from "./contract"
import { createEventStream } from "./events"
import { createWeftStore } from "./store"

export type Weft = { state: WeftState; actions: Actions; http: Http }

/** Exported so mock providers can stand in for the engine. */
export const WeftContext = createContext<Weft>()

const endpointOf = (engine: EngineState) =>
  engine.state === "ready" ? `${engine.url}\n${engine.username}\n${engine.password}` : undefined

/** `confirmConfig` must ask the user before `actions.updateConfig` writes the shared global config; without it the write is refused. */
export function WeftProvider(props: ParentProps<{ confirmConfig?: ConfirmConfig }>) {
  const connection = createConnection()
  const http = createHttp(() => credentialsOf(connection.state()))
  const api = createApi(http)
  const store = createWeftStore(api)
  const events = createEventStream(http, {
    apply: store.apply,
    connected: (again) => {
      if (again) void store.resync()
    },
    sequence: store.sequence,
  })
  const actions = createActions({ api, http, store, connection, confirmConfig: (patch) => props.confirmConfig?.(patch) ?? Promise.resolve(false) })

  const endpoint = createMemo(() => endpointOf(connection.state()))

  createEffect(() => store.setEngine(connection.state()))
  createEffect(
    on(
      endpoint,
      (ready) => {
        if (!ready) return events.pause()
        events.restart()
        void store.bootstrap()
      },
    ),
  )

  onCleanup(() => {
    events.dispose()
    store.dispose()
    connection.dispose()
  })

  return <WeftContext.Provider value={{ state: store.state, actions, http }}>{props.children}</WeftContext.Provider>
}

export function useWeft(): Weft {
  const weft = useContext(WeftContext)
  if (!weft) throw new Error("useWeft() needs a <WeftProvider> above it")
  return weft
}
