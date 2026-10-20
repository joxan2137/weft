import type { Dye } from "./weave"

/** Every ink the water knows: the four roles, and carmine for cutting. */
export type InkName = Dye | "cut"

/** One splat into the water, in window CSS pixels; velocity in pixels per second. */
export type Splat = { x: number; y: number; dx: number; dy: number; ink: InkName; amount: number; radius: number }

type Listener = (splat: Splat) => void
const listeners = new Set<Listener>()

function emit(splat: Splat) {
  for (const listener of listeners) listener(splat)
}

/**
 * The events that put ink into the water (docs/DESIGN.md A.5). Components call these; the water
 * subscribes. Nothing happens when no water is mounted.
 */
export const ink = {
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** A drop: ink falls in and blooms outward. */
  drop(x: number, y: number, name: InkName, amount = 1, radius = 1) {
    emit({ x, y, dx: 0, dy: 0, ink: name, amount, radius })
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.4
      emit({ x, y, dx: Math.cos(a) * 260 * radius, dy: Math.sin(a) * 260 * radius, ink: name, amount: 0, radius: radius * 0.6 })
    }
  },

  /** A drop thrown with a direction, as when a message is sent up into the conversation. */
  throw(x: number, y: number, dx: number, dy: number, name: InkName, amount = 1) {
    emit({ x, y, dx, dy, ink: name, amount, radius: 1 })
  },

  /** A stir: ink swirled around a point, as when an edited message is let back into the water. */
  stir(x: number, y: number, name: InkName, amount = 0.6) {
    const turns = 8
    for (let i = 0; i < turns; i++) {
      const a = (i / turns) * Math.PI * 2
      const r = 46
      emit({
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        dx: -Math.sin(a) * 520,
        dy: Math.cos(a) * 520,
        ink: name,
        amount: amount / turns,
        radius: 0.55,
      })
    }
  },

  /** A thread of current beside a reply that is still streaming. */
  flow(x: number, y: number, name: InkName) {
    emit({ x, y, dx: (Math.random() - 0.5) * 60, dy: 90, ink: name, amount: 0.14, radius: 0.5 })
  },
}
