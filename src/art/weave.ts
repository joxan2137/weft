export type Dye = "system" | "user" | "assistant" | "tool"
export type Weave = "plain" | "twill" | "basket" | "satin"
export type WeftPick = { dye: Dye; weave: Weave; tokens: number }
export type Draft = { warp: "linen" | "weld"; picks: WeftPick[] }
