import type { Message, Part } from "@opencode-ai/sdk/v2/types"
import type { PickView } from "./view"

/** The same estimate the cloth weighs unsent words with (view.ts). */
export const CHARS_PER_TOKEN = 4

/** A reply that arrived in one or two chunks was too quick to time. */
const MIN_SECONDS = 0.25

/** Characters of text and reasoning a reply has streamed so far. */
export function streamedChars(parts: Part[]) {
  let chars = 0
  for (const part of parts) if (part.type === "text" || part.type === "reasoning") chars += part.text.length
  return chars
}

/**
 * Output tokens a second of a finished reply: the engine's own count over the time the model spent
 * writing, from its first streamed word to its last word or tool call. The wait for the first token
 * and the tools' own run time are left out.
 */
export function measuredRate(info: Message, parts: Part[]) {
  if (info.role !== "assistant" || !info.time.completed) return undefined
  const tokens = info.tokens.output + info.tokens.reasoning
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.time?.start) start = Math.min(start, part.time.start)
      if (part.time?.end) end = Math.max(end, part.time.end)
    } else if (part.type === "tool" && "time" in part.state) end = Math.max(end, part.state.time.start)
  }
  const seconds = (end - start) / 1000
  return tokens > 0 && seconds >= MIN_SECONDS ? tokens / seconds : undefined
}

/** The reply the counter follows: the one streaming now, else the newest one that can be timed. */
export function latestReply(picks: PickView[]) {
  let newest: PickView | undefined
  for (const pick of picks) {
    if (pick.info.role !== "assistant" || pick.reverted) continue
    if (pick.live) return pick
    if (measuredRate(pick.info, pick.parts) === undefined) continue
    if (!newest || pick.info.time.created >= newest.info.time.created) newest = pick
  }
  return newest
}

export function rateLabel(rate: number) {
  return rate < 10 ? rate.toFixed(1) : String(Math.round(rate))
}
