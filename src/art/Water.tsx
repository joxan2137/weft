import { createEffect, on, onCleanup, onMount } from "solid-js"
import { theme } from "../theme/theme"
import { motionReduced } from "../ui/dialogs/motion"
import { ink, type InkName, type Splat } from "./ink"
import { densityOf, glowOf, rgbOf, Water as Sim } from "./fluid"

const TOKEN: Record<InkName, string> = {
  system: "--ochre-bright",
  user: "--vermilion-bright",
  assistant: "--indigo-bright",
  tool: "--teal-bright",
  cut: "--carmine-bright",
}

const FPS = 30
/**
 * At night inks are light: full strength would outshine the words beside them. Less of each ink goes
 * in, but at its full colour: a dimmed colour screened thin over dark water reads as brown smoke.
 */
const GLOW = 0.52
/** The water keeps moving this long after the last ink went in, then the loop stops. */
const SETTLE_MS = 9000
/** Development screenshots run in a headless browser that never has focus. */
const alwaysAwake = import.meta.env.DEV && /[?&](mock|water)/.test(location.search)

function cssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#808080"
}

/**
 * The living water behind the window (docs/DESIGN.md A.5.1). It simulates only while ink moves,
 * and never while the window is hidden or out of focus. By day ink stains the paper; at night it
 * glows in dark water (A.8). With reduced motion the ink lands as still stains.
 */
export function Water(props: { column?: () => HTMLElement | undefined }) {
  let canvas!: HTMLCanvasElement

  onMount(() => {
    let sim = Sim.create(canvas, rgbOf(cssColor("--paper")))
    if (!sim) {
      canvas.classList.add("still")
      return
    }
    let densities = {} as Record<InkName, [number, number, number]>
    const mix = () => {
      const night = theme() === "dark"
      sim?.setPaper(rgbOf(cssColor("--paper")), night)
      densities = Object.fromEntries(
        (Object.keys(TOKEN) as InkName[]).map((name) => {
          const rgb = rgbOf(cssColor(TOKEN[name]))
          return [name, night ? glowOf(rgb).map((d) => d * GLOW) : densityOf(rgb)]
        }),
      ) as Record<InkName, [number, number, number]>
    }
    mix()
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)")
    const queue: Splat[] = []
    let lastInk = 0
    let frame = 0
    let last = 0
    let veiled = { left: NaN, right: NaN }
    let staleVeil = false

    const resize = () => {
      if (!sim) return
      const scale = Math.min(1, window.devicePixelRatio || 1) * 0.75
      canvas.width = Math.max(1, Math.round(window.innerWidth * scale))
      canvas.height = Math.max(1, Math.round(window.innerHeight * scale))
      sim.allocate()
      veil()
      sim.render()
    }

    const veil = () => {
      const rect = props.column?.()?.getBoundingClientRect()
      if (rect && rect.width > 0) {
        veiled = { left: rect.left, right: rect.right }
        sim?.setVeil(rect.left / window.innerWidth, rect.right / window.innerWidth)
      } else {
        veiled = { left: NaN, right: NaN }
        sim?.setVeil(0.5, 0.5)
      }
      staleVeil = false
    }

    const present = () => alwaysAwake || (!document.hidden && document.hasFocus())
    const awake = () => present() && !motionReduced() && performance.now() - lastInk < SETTLE_MS

    const stop = () => {
      cancelAnimationFrame(frame)
      frame = 0
    }

    const tick = (now: number) => {
      frame = 0
      if (!sim || !awake()) return
      frame = requestAnimationFrame(tick)
      if (now - last < 1000 / FPS) return
      const dt = Math.min(0.033, (now - (last || now)) / 1000) || 1 / FPS
      last = now
      for (const s of queue.splice(0)) {
        const amount = s.amount * 0.9
        const density = densities[s.ink].map((d) => d * amount) as [number, number, number]
        sim.splat(s.x / window.innerWidth, s.y / window.innerHeight, s.dx / window.innerWidth, s.dy / window.innerHeight, density, s.radius)
      }
      sim.step(dt)
      sim.render()
    }

    /** One still frame: the queued ink lands where it fell, and nothing moves. */
    const stain = () => {
      if (!sim) return
      for (const s of queue.splice(0)) {
        const density = densities[s.ink].map((d) => d * s.amount * 0.9) as [number, number, number]
        sim.splat(s.x / window.innerWidth, s.y / window.innerHeight, 0, 0, density, s.radius)
      }
      if (staleVeil) veil()
      sim.render()
    }

    const wake = () => {
      if (!sim) return
      if (motionReduced()) {
        stop()
        return stain()
      }
      if (staleVeil && present()) {
        veil()
        if (!frame) sim.render()
      }
      if (!frame && awake()) {
        last = 0
        frame = requestAnimationFrame(tick)
      }
    }

    // Ink that falls while the window is away is let go: a backlog would land all at once on return.
    const unsubscribe = ink.subscribe((splat) => {
      lastInk = performance.now()
      if (!present()) return
      queue.push(splat)
      wake()
    })

    const onResize = () => resize()
    const observer = new ResizeObserver(() => {
      const rect = props.column?.()?.getBoundingClientRect()
      if (rect && rect.left === veiled.left && rect.right === veiled.right) return
      if (!present()) {
        staleVeil = true
        return
      }
      veil()
      if (!frame) sim?.render()
    })
    createEffect(() => {
      const column = props.column?.()
      observer.disconnect()
      if (column) observer.observe(column)
    })
    createEffect(
      on(
        theme,
        () => {
          mix()
          sim?.render()
        },
        { defer: true },
      ),
    )
    createEffect(on(motionReduced, wake, { defer: true }))

    // A GPU reset (a driver update, a game switching devices) takes the context; rebuild once it is back.
    const onContextLost = (event: Event) => {
      event.preventDefault()
      stop()
      queue.length = 0
      sim = undefined
      canvas.classList.add("still")
    }
    const onContextRestored = () => {
      sim = Sim.create(canvas, rgbOf(cssColor("--paper")))
      if (!sim) return
      canvas.classList.remove("still")
      mix()
      resize()
    }

    window.addEventListener("resize", onResize)
    window.addEventListener("focus", wake)
    document.addEventListener("visibilitychange", wake)
    calm.addEventListener("change", wake)
    canvas.addEventListener("webglcontextlost", onContextLost)
    canvas.addEventListener("webglcontextrestored", onContextRestored)
    resize()

    onCleanup(() => {
      unsubscribe()
      stop()
      observer.disconnect()
      window.removeEventListener("resize", onResize)
      window.removeEventListener("focus", wake)
      document.removeEventListener("visibilitychange", wake)
      calm.removeEventListener("change", wake)
      canvas.removeEventListener("webglcontextlost", onContextLost)
      canvas.removeEventListener("webglcontextrestored", onContextRestored)
      sim?.dispose()
    })
  })

  return <canvas ref={canvas} class="water" aria-hidden="true" />
}
