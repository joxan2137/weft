#!/usr/bin/env node
// OpenAI-compatible mock model for engine tests (no paid calls). Every request body is appended to
// the --log JSONL file. Replies to main-loop calls come from a script queue, "ok" when it is empty;
// title and compaction calls (recognised by opencode's own prompts) get fixed replies.
//
//   node tools/mock-provider.mjs --port 48621 --log mock.jsonl
//   POST   /mock/script   [{ text?, reasoning?, tool?: { name, arguments }, echo?, delayMs? }, …]  queue replies
//                         (echo: true answers "echo: <the last user message>", for calls racing each other)
//   DELETE /mock/script   clear the queue
//   GET    /mock/requests every recorded request
//   POST   /v1/chat/completions  (stream: true → SSE chunks, else one JSON completion)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    host: { type: "string", default: "127.0.0.1" },
    log: { type: "string" },
  },
})

const TITLE = "You are a title generator."
const COMPACTION = "You are a context summarization agent."
const logFile = args.log && resolve(args.log)
if (logFile) {
  mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(logFile, "")
}

const queue = []
const requests = []

const contentText = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : ""

function kindOf(body) {
  const system = contentText((body.messages ?? []).find((m) => m.role === "system")?.content)
  if (system.startsWith(TITLE)) return "title"
  if (system.startsWith(COMPACTION)) return "compaction"
  return "main"
}

function replyFor(kind) {
  if (kind === "title") return { text: "Mock title" }
  if (kind === "compaction") return { text: "## Objective\n- mock summary" }
  return queue.shift() ?? { text: "ok" }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const lastUserText = (body) => contentText((body.messages ?? []).findLast((m) => m.role === "user")?.content)

async function complete(res, body, queued, seq) {
  const reply = queued.echo ? { ...queued, text: `echo: ${lastUserText(body)}` } : queued
  const id = `chatcmpl-mock-${seq}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
  const toolCall = reply.tool && {
    index: 0,
    id: `call_mock_${seq}`,
    type: "function",
    function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments ?? {}) },
  }
  const finish = toolCall ? "tool_calls" : "stop"

  if (!body.stream) {
    if (reply.delayMs) await sleep(reply.delayMs)
    const message = { role: "assistant", content: reply.text ?? null }
    if (reply.reasoning) message.reasoning_content = reply.reasoning
    if (toolCall) message.tool_calls = [{ id: toolCall.id, type: "function", function: toolCall.function }]
    return json(res, 200, { id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: finish }], usage })
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  // A caller that aborts mid-reply (Stop) closes the stream while a delayed reply still sleeps.
  res.on("error", () => {})
  const chunk = (delta, finishReason = null) =>
    res.destroyed ||
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
  chunk({ role: "assistant", content: "" })
  if (reply.reasoning) chunk({ reasoning_content: reply.reasoning })
  if (reply.text) {
    const half = Math.ceil(reply.text.length / 2)
    chunk({ content: reply.text.slice(0, half) })
    if (reply.delayMs) await sleep(reply.delayMs)
    chunk({ content: reply.text.slice(half) })
  } else if (reply.delayMs) await sleep(reply.delayMs)
  if (toolCall) chunk({ tool_calls: [toolCall] })
  chunk({}, finish)
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8")
    const path = (req.url ?? "/").split("?")[0]
    try {
      if (path === "/mock/script" && req.method === "POST") {
        const replies = JSON.parse(raw || "[]")
        queue.push(...(Array.isArray(replies) ? replies : [replies]))
        return json(res, 200, { queued: queue.length })
      }
      if (path === "/mock/script" && req.method === "DELETE") {
        queue.length = 0
        return json(res, 200, { queued: 0 })
      }
      if (path === "/mock/requests" && req.method === "GET") return json(res, 200, requests)
      if (path.endsWith("/models") && req.method === "GET") return json(res, 200, { object: "list", data: [] })
      if (!path.endsWith("/chat/completions") || req.method !== "POST") return json(res, 404, { error: { message: `no route ${req.method} ${path}` } })

      const body = JSON.parse(raw)
      const kind = kindOf(body)
      const record = { seq: requests.length + 1, at: Date.now(), path, kind, body }
      requests.push(record)
      if (logFile) appendFileSync(logFile, `${JSON.stringify(record)}\n`)
      await complete(res, body, replyFor(kind), record.seq)
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: { message: String(error) } })
      else res.end()
    }
  })
})

server.listen(Number(args.port), args.host, () => {
  console.log(JSON.stringify({ port: server.address().port, log: logFile ?? null }))
})

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)))
