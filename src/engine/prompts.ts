// The vendored opencode 1.19.1 provider prompts (src/assets/prompts, MIT, see NOTICE.md) that seed
// pick 00. The only module that imports prompt files with Vite's ?raw.
import anthropic from "../assets/prompts/anthropic.txt?raw"
import beast from "../assets/prompts/beast.txt?raw"
import codex from "../assets/prompts/codex.txt?raw"
import defaultPrompt from "../assets/prompts/default.txt?raw"
import gemini from "../assets/prompts/gemini.txt?raw"
import gptAstra from "../assets/prompts/gpt-astra.txt?raw"
import gpt from "../assets/prompts/gpt.txt?raw"
import kimi from "../assets/prompts/kimi.txt?raw"
import meta from "../assets/prompts/meta.txt?raw"
import trinity from "../assets/prompts/trinity.txt?raw"
import { providerPromptFile, SEED_TAIL, type Seed } from "./liberate"

export { SEED_TAIL }

// opencode embeds these with LF endings; a checkout with core.autocrlf would hand ?raw CRLF.
const lf = (text: string) => text.replace(/\r\n/g, "\n")

const PROVIDER_PROMPTS: Record<string, string> = {
  "anthropic.txt": lf(anthropic),
  "beast.txt": lf(beast),
  "codex.txt": lf(codex),
  "default.txt": lf(defaultPrompt),
  "gemini.txt": lf(gemini),
  "gpt-astra.txt": lf(gptAstra),
  "gpt.txt": lf(gpt),
  "kimi.txt": lf(kimi),
  "meta.txt": lf(meta),
  "trinity.txt": lf(trinity),
}

export type PromptModel = { providerID: string; apiID: string }

/** The provider prompt opencode 1.19.1 sends a model when its agent has no prompt of its own. */
export function seedFor(model: PromptModel): Seed {
  const { file, modelName } = providerPromptFile(model)
  const text = PROVIDER_PROMPTS[file]
  return { file, text: modelName ? text.replaceAll("{{MODEL_NAME}}", modelName) : text }
}

/** Pick 00 before it is rewritten: the provider prompt as text, then opencode's other segments as placeholders. */
export function seedTemplate(model: PromptModel) {
  return `${seedFor(model).text}\n${SEED_TAIL}`
}
