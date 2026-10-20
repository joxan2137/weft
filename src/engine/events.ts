import { batch } from "solid-js"
import type { Event } from "@opencode-ai/sdk/v2/types"
import type { Http } from "./contract"

const FLUSH_MS = 16
const YIELD_MS = 8
const WATCHDOG_MS = 30_000
const FIRST_RETRY_MS = 250
const LAST_RETRY_MS = 5_000

/** One engine event; `directory` is the instance it came from, or "global". */
export type EngineEvent = { directory: string; payload: Event }

export type EventSink = {
  apply(events: EngineEvent[]): void
  /** A stream (re)connected; `again` is false only for the first connection after start. */
  connected(again: boolean): void
  /** Durable event sequence per session, from the `sync` echo frames. */
  sequence(aggregateID: string, seq: number): void
}

export type EventStream = {
  start(): void
  pause(): void
  resume(): void
  restart(): void
  dispose(): void
}

type Frame = {
  directory?: string
  payload?: { type?: string; syncEvent?: { aggregateID?: string; seq?: number } }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function coalesceKey(event: EngineEvent) {
  if (event.payload.type === "lsp.updated") return `lsp:${event.directory}`
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return `part:${event.directory}:${part.messageID}:${part.id}`
  }
  return undefined
}

/** Concatenates consecutive deltas for the same part and field; nothing is dropped. */
export function mergeDeltas(events: EngineEvent[]) {
  const output: EngineEvent[] = []
  for (const event of events) {
    const previous = output[output.length - 1]
    if (
      event.payload.type === "message.part.delta" &&
      previous?.payload.type === "message.part.delta" &&
      previous.directory === event.directory
    ) {
      const before = previous.payload.properties
      const next = event.payload.properties
      if (before.messageID === next.messageID && before.partID === next.partID && before.field === next.field) {
        output[output.length - 1] = {
          directory: event.directory,
          payload: { ...event.payload, properties: { ...next, delta: before.delta + next.delta } },
        }
        continue
      }
    }
    output.push(event)
  }
  return output
}

export function parseFrame(block: string): Frame | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
    .join("\n")
  if (!data) return undefined
  try {
    return JSON.parse(data) as Frame
  } catch {
    return undefined
  }
}

/** The single `GET /global/event` loop (docs/DESIGN.md B.3). */
export function createEventStream(http: Http, sink: EventSink): EventStream {
  let queue: EngineEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFlush = 0
  let running = false
  let generation = 0
  let connections = 0
  let attempt: AbortController | undefined

  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return
    const events = mergeDeltas(queue)
    queue = []
    lastFlush = Date.now()
    batch(() => sink.apply(events))
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(flush, Math.max(0, FLUSH_MS - (Date.now() - lastFlush)))
  }

  function enqueue(event: EngineEvent) {
    const key = coalesceKey(event)
    const tail = queue[queue.length - 1]
    if (key && tail && coalesceKey(tail) === key) queue[queue.length - 1] = event
    else queue.push(event)
    schedule()
  }

  /** Returns true when the frame proves a live connection. */
  function receive(frame: Frame) {
    const payload = frame.payload
    if (!payload?.type) return false
    if (payload.type === "sync") {
      const sync = payload.syncEvent
      if (sync?.aggregateID && typeof sync.seq === "number") sink.sequence(sync.aggregateID, sync.seq)
      return false
    }
    if (payload.type === "server.heartbeat") return false
    if (payload.type === "server.connected") {
      flush()
      connections += 1
      sink.connected(connections > 1)
      return true
    }
    enqueue({ directory: frame.directory ?? "global", payload: payload as Event })
    return false
  }

  async function read(controller: AbortController, onActivity: () => void, onConnected: () => void) {
    const response = await fetch(http.url("/global/event"), {
      headers: { authorization: http.auth(), accept: "text/event-stream" },
      cache: "no-store",
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`The event stream answered ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    let yielded = Date.now()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      onActivity()
      buffer += value.replace(/\r\n/g, "\n")
      let end = buffer.indexOf("\n\n")
      while (end >= 0) {
        const frame = parseFrame(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (frame && receive(frame)) onConnected()
        end = buffer.indexOf("\n\n")
      }
      if (Date.now() - yielded >= YIELD_MS) {
        await sleep(0)
        yielded = Date.now()
      }
    }
  }

  async function loop(active: number) {
    let delay = FIRST_RETRY_MS
    while (running && generation === active) {
      const controller = new AbortController()
      attempt = controller
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS)
      }
      try {
        arm()
        await read(controller, arm, () => (delay = FIRST_RETRY_MS))
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[weft] event stream failed", error)
      } finally {
        clearTimeout(watchdog)
        if (attempt === controller) attempt = undefined
      }
      flush()
      if (!running || generation !== active) return
      await sleep(delay)
      delay = Math.min(delay * 2, LAST_RETRY_MS)
    }
  }

  const onPageHide = () => pause()
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) start()
  }
  window.addEventListener("pagehide", onPageHide)
  window.addEventListener("pageshow", onPageShow)

  function start() {
    if (running) return
    running = true
    void loop(++generation)
  }

  function pause() {
    running = false
    generation++
    attempt?.abort()
    flush()
  }

  return {
    start,
    pause,
    resume: start,
    restart() {
      pause()
      connections = 0
      start()
    },
    dispose() {
      pause()
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("pageshow", onPageShow)
    },
  }
}
