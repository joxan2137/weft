import { createMemo, For } from "solid-js"
import type { Dye } from "./weave"

export type Spend = { dye: Dye; tokens: number }

const ORDER: Dye[] = ["system", "user", "assistant", "tool"]
const W = 22
const H = 28
const TOP = 4
const BOTTOM = 26

/**
 * The context window as a small glass: its water level is the share in use, layered by who used
 * it, the source at the bottom (docs/DESIGN.md A.5.7).
 */
export function Vessel(props: { limit: number; spent: Spend[]; size?: number; title?: string }) {
  const layers = createMemo(() => {
    if (!(props.limit > 0)) return []
    const totals = new Map<Dye, number>()
    for (const s of props.spent) totals.set(s.dye, (totals.get(s.dye) ?? 0) + s.tokens)
    let y = BOTTOM
    const height = BOTTOM - TOP
    return ORDER.flatMap((dye) => {
      const share = Math.min(1, (totals.get(dye) ?? 0) / props.limit)
      const h = Math.min(y - TOP, share * height)
      if (h <= 0.05) return []
      y -= h
      return [{ dye, y, h }]
    })
  })
  const level = () => layers().at(-1)?.y ?? BOTTOM
  const scale = () => (props.size ?? 22) / W
  return (
    <svg class="vessel" width={W * scale()} height={H * scale()} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.title ?? "context"}>
      <title>{props.title ?? "context"}</title>
      <defs>
        <clipPath id="vessel-glass">
          <path d="M4 3 L18 3 L16.4 25.2 Q16.2 27 14.4 27 L7.6 27 Q5.8 27 5.6 25.2 Z" />
        </clipPath>
      </defs>
      <g clip-path="url(#vessel-glass)">
        <For each={layers()}>{(layer) => <rect data-role={layer.dye} class="vessel-layer" x="0" y={layer.y} width={W} height={layer.h + 0.4} />}</For>
        <path class="vessel-surface" d={`M -8 ${level()} q 3.5 -1.2 7 0 t 7 0 t 7 0 t 7 0 t 7 0 v 2 h -35 z`} />
      </g>
      <path class="vessel-glass" d="M4 3 L18 3 L16.4 25.2 Q16.2 27 14.4 27 L7.6 27 Q5.8 27 5.6 25.2 Z" />
    </svg>
  )
}
