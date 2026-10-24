// Refreshes the OpenGateway model catalog Weft builds into its engine config and shows in the
// Providers dialog. usage: node tools/sync-opengateway-models.mjs
import { writeFile } from "node:fs/promises"

const ENDPOINT = "https://apis.opengateway.ai/v1/models"
const OUT = new URL("../src/engine/opengateway.json", import.meta.url)

const perMillion = (value) => {
  const price = Number(value)
  return Number.isFinite(price) ? Number((price * 1_000_000).toFixed(6)) : 0
}

const response = await fetch(ENDPOINT)
if (!response.ok) throw new Error(`${ENDPOINT} answered ${response.status}`)
const { data } = await response.json()
if (!Array.isArray(data)) throw new Error(`${ENDPOINT} returned no model list`)

const models = data
  .filter(
    (model) =>
      (!model.status || model.status === "active") &&
      model.endpoints?.includes("chat_completions") &&
      model.modalities?.output?.includes("text"),
  )
  .map((model) => ({
    id: model.id,
    context: model.context_window ?? 0,
    maxOutput: model.max_output_tokens ?? 0,
    input: model.modalities?.input ?? ["text"],
    output: model.modalities?.output ?? ["text"],
    cost: {
      input: perMillion(model.pricing?.prompt),
      output: perMillion(model.pricing?.completion),
      cacheRead: perMillion(model.pricing?.input_cache_read),
    },
  }))
  .sort((a, b) => a.id.localeCompare(b.id))

if (!models.length) throw new Error(`${ENDPOINT} listed no chat models`)

await writeFile(OUT, `${JSON.stringify(models, null, 2)}\n`)
console.log(`wrote ${models.length} models to src/engine/opengateway.json`)
