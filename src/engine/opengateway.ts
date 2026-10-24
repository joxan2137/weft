import type { Model, Provider } from "@opencode-ai/sdk/v2/types"
import catalog from "./opengateway.json"

export const OPEN_GATEWAY_ID = "opengateway"
export const OPEN_GATEWAY_NAME = "OpenGateway"
export const OPEN_GATEWAY_URL = "https://opengateway.ai"
export const OPEN_GATEWAY_BASE_URL = "https://apis.opengateway.ai/v1"

type Entry = (typeof catalog)[number]
type Modality = keyof Model["capabilities"]["input"]

const modalities = (names: string[]) => {
  const set = new Set(names)
  const known = (modality: Modality) => set.has(modality)
  return { text: known("text"), audio: known("audio"), image: known("image"), video: known("video"), pdf: known("pdf") }
}

function model(entry: Entry): Model {
  const input = modalities(entry.input)
  return {
    id: entry.id,
    providerID: OPEN_GATEWAY_ID,
    name: entry.id,
    api: { id: entry.id, url: "", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: input.image || input.pdf,
      toolcall: true,
      input,
      output: modalities(entry.output),
      interleaved: false,
    },
    cost: { input: entry.cost.input, output: entry.cost.output, cache: { read: entry.cost.cacheRead, write: 0 } },
    limit: { context: entry.context, output: entry.maxOutput },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  }
}

/** Shown before the provider is connected: the engine lists a config provider only once it has a key. */
export const OPEN_GATEWAY_PROVIDER: Provider = {
  id: OPEN_GATEWAY_ID,
  name: OPEN_GATEWAY_NAME,
  source: "custom",
  env: [],
  options: {},
  models: Object.fromEntries(catalog.map((entry) => [entry.id, model(entry)])),
}

export function withOpenGateway(providers: Provider[]): Provider[] {
  return providers.some((provider) => provider.id === OPEN_GATEWAY_ID) ? providers : [...providers, OPEN_GATEWAY_PROVIDER]
}
