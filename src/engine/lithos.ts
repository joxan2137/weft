import type { Model, Provider } from "@opencode-ai/sdk/v2/types"
import catalog from "./lithos.json"

export const LITHOS_ID = "lithosai"
export const LITHOS_NAME = "LithosAI"
export const LITHOS_URL = "https://console.lithosai.cloud"
export const LITHOS_BASE_URL = "https://api.lithosai.cloud/v1"

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
    providerID: LITHOS_ID,
    name: entry.name,
    api: { id: entry.id, url: "", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: entry.reasoning,
      attachment: input.image || input.pdf,
      toolcall: true,
      input,
      output: modalities(entry.output),
      interleaved: false,
    },
    cost: { input: entry.cost.input, output: entry.cost.output, cache: { read: entry.cost.cacheRead, write: 0 } },
    limit: { context: entry.context, output: entry.maxOutput },
    status: "active",
    options: entry.variants.length ? { reasoningEffort: "high" } : {},
    variants: Object.fromEntries(entry.variants.map((variant) => [variant, { reasoningEffort: variant }])),
    headers: {},
    release_date: "",
  }
}

/** Shown before the provider is connected: the engine lists a config provider only once it has a key. */
export const LITHOS_PROVIDER: Provider = {
  id: LITHOS_ID,
  name: LITHOS_NAME,
  source: "custom",
  env: [],
  options: {},
  models: Object.fromEntries(catalog.map((entry) => [entry.id, model(entry)])),
}

export function withLithos(providers: Provider[]): Provider[] {
  return providers.some((provider) => provider.id === LITHOS_ID) ? providers : [...providers, LITHOS_PROVIDER]
}
