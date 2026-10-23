type ProxyOption = { url: string; headers?: Record<string, string> }

const BASE = process.env.WEFT_PROXY_URL?.trim()
const CONTROL = process.env.WEFT_PROXY_CONTROL?.trim()
const SESSION_HEADER = "x-weft-session"
const SESSION = /^[A-Za-z0-9_-]{1,120}$/
const ZEN_PROVIDERS = new Set(["opencode", "opencode-go"])

const QUOTA = /rate.?limit|exceeded|quota|free.?tier|too many|already/i
const GEO = /not available in (your )?country|unsupported (country|region)|geo.?blocked|blocked.*country|unavailable.*(country|region)/i
const RETRYABLE = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500
const TRANSPORT_ATTEMPTS = 3
const QUOTA_ATTEMPTS = 25

async function buffered(response: Response) {
  let body = ""
  try {
    body = await response.clone().text()
  } catch {}
  try {
    await response.body?.cancel()
  } catch {}
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

function isZen(input: unknown) {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url)
    const host = url.hostname.toLowerCase()
    if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return false
    return url.pathname === "/zen" || url.pathname.startsWith("/zen/")
  } catch {
    return false
  }
}

async function sessionOf(template: Request) {
  const raw = template.headers.get(SESSION_HEADER)
  if (raw === null) return { token: undefined, template }
  const headers = new Headers(template.headers)
  headers.delete(SESSION_HEADER)
  const body = template.body ? await template.arrayBuffer() : undefined
  return { token: SESSION.test(raw) ? raw : undefined, template: new Request(template, { headers, body }) }
}

if (BASE && CONTROL) {
  const original = globalThis.fetch
  const report = async (token: string, reason: string) => {
    try {
      await original(`${BASE}/__weft/report`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-weft-control": CONTROL },
        body: JSON.stringify({ token, reason }),
      })
    } catch {}
  }

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isZen(input)) return original(input, init)
    if (init?.signal?.aborted) return original(input, init)

    let template: Request
    try {
      template = input instanceof Request ? input.clone() : new Request(input, init)
    } catch {
      return original(input, init)
    }
    let session: Awaited<ReturnType<typeof sessionOf>>
    try {
      session = await sessionOf(template)
    } catch {
      return original(input, init)
    }
    template = session.template

    let last: Response | undefined
    let lastError: unknown
    let transport = 0
    let quota = 0
    while (transport < TRANSPORT_ATTEMPTS && quota < QUOTA_ATTEMPTS) {
      const token = session.token ?? `weft-${crypto.randomUUID()}`
      const proxy: ProxyOption = {
        url: BASE,
        headers: { "Proxy-Authorization": `Basic ${btoa(`${token}:x`)}` },
      }
      let response: Response
      try {
        response = await original(template.clone(), { proxy } as RequestInit)
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        lastError = error
        transport += 1
        await report(token, "transport")
        continue
      }

      if (response.status < 400) return response
      if (RETRYABLE(response.status)) {
        last = await buffered(response)
        quota += 1
        await report(token, `HTTP ${response.status}`)
        if (response.status === 502) await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }

      let body = ""
      try {
        body = await response.clone().text()
      } catch {
        return response
      }
      if (QUOTA.test(body) || GEO.test(body)) {
        last = await buffered(response)
        quota += 1
        await report(token, QUOTA.test(body) ? "quota" : "geo")
        continue
      }
      return response
    }
    if (last) return last
    throw lastError ?? new Error("Weft's proxy pool is exhausted")
  }) as typeof fetch
}

export default {
  id: "weft-proxy",
  server: async () => ({
    "chat.headers": async (
      input: { sessionID?: string; model?: { providerID?: string } },
      output: { headers: Record<string, string> },
    ) => {
      if (!BASE || !CONTROL || !input.sessionID || !SESSION.test(input.sessionID)) return
      if (!input.model?.providerID || !ZEN_PROVIDERS.has(input.model.providerID)) return
      output.headers[SESSION_HEADER] = input.sessionID
    },
  }),
}
