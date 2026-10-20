// Paper marbling (ebru), after Lu, Jaffer et al., "Mathematical Marbling" (2012). Each ink drop
// pushes every earlier ink outward: p' = c + (p − c)·√(1 + r²/|p − c|²). A tine pulled through the
// bath shifts ink along its line by z = α·λ / (d + λ). A pixel is coloured by running the
// operations backwards from the finished print until it lands inside a drop.
import { theme } from "../theme/theme"
import type { Draft, Dye } from "./weave"

type Drop = { kind: "drop"; x: number; y: number; r: number; color: [number, number, number] }
type Tine = { kind: "tine"; px: number; py: number; mx: number; my: number; alpha: number; lambda: number }
type Op = Drop | Tine

const INK: Record<Dye, string> = {
  system: "--ochre-bright",
  user: "--vermilion-bright",
  assistant: "--indigo-bright",
  tool: "--teal-bright",
}

const colors = new Map<string, [number, number, number]>()
function color(token: string): [number, number, number] {
  const key = `${theme()}:${token}`
  const hit = colors.get(key)
  if (hit) return hit
  const hex = getComputedStyle(document.documentElement).getPropertyValue(token).trim().replace("#", "") || "808080"
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  colors.set(key, rgb)
  return rgb
}

/** A small deterministic generator, so a session always gets the same print. */
function random(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

/** The bath for a session: one drop per message in its role's ink, dropped at a few centres, then combed. */
export function bath(draft: Draft, seed: string): Op[] {
  const next = random(seed)
  const picks = draft.picks.slice(-28)
  const centres = Array.from({ length: 1 + Math.floor(next() * 2.2) }, () => ({ x: 0.3 + next() * 0.4, y: 0.3 + next() * 0.4 }))
  const ops: Op[] = []
  picks.forEach((pick, i) => {
    const centre = centres[i % centres.length]
    const r = 0.05 + Math.min(0.11, Math.sqrt(Math.log2(1 + pick.tokens / 80)) * 0.035)
    ops.push({ kind: "drop", x: centre.x + (next() - 0.5) * 0.04, y: centre.y + (next() - 0.5) * 0.04, r, color: color(INK[pick.dye]) })
  })
  const combs = 1 + Math.floor(next() * 2)
  for (let c = 0; c < combs; c++) {
    const angle = next() * Math.PI
    const mx = Math.cos(angle)
    const my = Math.sin(angle)
    const tines = 3 + Math.floor(next() * 4)
    for (let t = 0; t < tines; t++) {
      const offset = (t + 0.5) / tines - 0.5
      const sign = t % 2 === 0 ? 1 : -1
      ops.push({ kind: "tine", px: 0.5 - my * offset, py: 0.5 + mx * offset, mx: mx * sign, my: my * sign, alpha: 0.16 + next() * 0.08, lambda: 0.035 })
    }
  }
  return ops
}

/** The colour at (x, y) of the finished print, or undefined for bare paper. */
function sample(ops: Op[], x: number, y: number) {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.kind === "drop") {
      const dx = x - op.x
      const dy = y - op.y
      const d2 = dx * dx + dy * dy
      if (d2 < op.r * op.r) return op.color
      const k = Math.sqrt(1 - (op.r * op.r) / d2)
      x = op.x + dx * k
      y = op.y + dy * k
    } else {
      const d = Math.abs((x - op.px) * -op.my + (y - op.py) * op.mx)
      const z = (op.alpha * op.lambda) / (d + op.lambda)
      x -= z * op.mx
      y -= z * op.my
    }
  }
  return undefined
}

const cache = new Map<string, string>()

export function marbleKey(draft: Draft, seed: string, size: number) {
  return `${theme()}:${seed}:${size}:${draft.picks.map((p) => `${p.dye[0]}${Math.round(Math.log2(1 + p.tokens))}`).join("")}`
}

export function marbleCached(draft: Draft, seed: string, size: number) {
  return cache.get(marbleKey(draft, seed, size))
}

/** Renders the print once (2×2 supersampled) and caches it as a data URL. */
export function marbleURL(draft: Draft, seed: string, size: number) {
  const key = marbleKey(draft, seed, size)
  const hit = cache.get(key)
  if (hit) return hit
  const scale = Math.min(2, window.devicePixelRatio || 1)
  const px = Math.round(size * scale)
  const canvas = document.createElement("canvas")
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext("2d")!
  const image = ctx.createImageData(px, px)
  const paper = color("--paper-2")
  const ops = bath(draft, seed)
  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      let r = 0
      let g = 0
      let b = 0
      for (let s = 0; s < 4; s++) {
        const c = sample(ops, (i + (s & 1 ? 0.75 : 0.25)) / px, (j + (s & 2 ? 0.75 : 0.25)) / px) ?? paper
        r += c[0]
        g += c[1]
        b += c[2]
      }
      const o = (j * px + i) * 4
      image.data[o] = r / 4
      image.data[o + 1] = g / 4
      image.data[o + 2] = b / 4
      image.data[o + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const url = canvas.toDataURL("image/png")
  cache.set(key, url)
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  return url
}
