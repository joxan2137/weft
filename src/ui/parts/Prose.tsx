import { createEffect, onCleanup } from "solid-js"
import { renderMarkdown, upgradeCodeBlocks } from "../markdown"
import { openExternal, copyText } from "../platform"
import { ink } from "../../art/ink"
import { motionReduced } from "../dialogs/motion"
import { toastError } from "../dialogs/Toast"

const CURSOR = '<span class="cursor stream-cursor" role="presentation"></span>'
const SETTLE_MS = 650
const FLOW_MS = 160
const MAX_GLOWS = 8

/** The node the text ends on, skipping trailing whitespace. */
function lastNode(el: Element) {
  let node = el.lastChild
  while (node && node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) node = node.previousSibling
  return node
}

/** The caret sits right after the last character, never inside inline code or a block. */
function appendCursor(root: HTMLElement) {
  let target: Element = root
  for (let last = lastNode(target); last instanceof Element && !last.matches("pre, figure, table, hr, code"); last = lastNode(target)) {
    target = last
  }
  if (target === root) root.insertAdjacentHTML("beforeend", `<p class="cursor-line">${CURSOR}</p>`)
  else target.insertAdjacentHTML("beforeend", CURSOR)
}

/** Text nodes from the end backwards, skipping the cursor. */
function* tailTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  for (let i = nodes.length - 1; i >= 0; i--) yield nodes[i]
}

/**
 * Ink settling: the words of each recent chunk arrive soft and in the role's ink, then settle into
 * sharp text. Every repaint rewraps them with a negative delay equal to their age, so the settling
 * runs on across repaints.
 */
function glow(root: HTMLElement, chunks: { at: number; size: number }[], now: number) {
  const nodes = tailTextNodes(root)
  let node = nodes.next().value as Text | undefined
  for (const chunk of [...chunks].reverse()) {
    let left = chunk.size
    while (node && left > 0) {
      const length = node.data.length
      if (length === 0) {
        node = nodes.next().value as Text | undefined
        continue
      }
      const take = Math.min(left, length)
      const lit = node.splitText(length - take)
      const span = document.createElement("span")
      span.className = "settle"
      span.style.animationDelay = `${chunk.at - now}ms`
      lit.replaceWith(span)
      span.append(lit)
      left -= take
      if (take === length) node = nodes.next().value as Text | undefined
    }
  }
}

/** Markdown body of a text part. While `live`, a caret rides the end of the text and ink flows beside it. */
export function Prose(props: { text: string; live?: boolean; class?: string }) {
  let root!: HTMLDivElement
  let frame = 0
  let rendered = ""
  let text = ""
  let live = false
  let seen = 0
  let chunks: { at: number; size: number }[] = []
  let flowed = 0

  // Runs in a frame callback, outside any owner: it paints what the effect last read, never props.
  const paint = () => {
    frame = 0
    const key = `${live ? 1 : 0}${text}`
    if (key === rendered) return
    rendered = key
    const now = performance.now()
    if (live && seen > 0 && text.length > seen) chunks.push({ at: now, size: text.length - seen })
    seen = text.length
    chunks = chunks.filter((c) => now - c.at < SETTLE_MS).slice(-MAX_GLOWS)
    root.innerHTML = renderMarkdown(text, live)
    upgradeCodeBlocks(root)
    if (!live) return
    if (!motionReduced() && chunks.length) glow(root, chunks, now)
    appendCursor(root)
    if (now - flowed > FLOW_MS) {
      flowed = now
      const caret = root.querySelector(".stream-cursor")?.getBoundingClientRect()
      const column = root.getBoundingClientRect()
      if (caret) ink.flow(column.left - 34, caret.top + caret.height / 2, "assistant")
    }
  }

  createEffect(() => {
    text = props.text
    live = !!props.live
    if (!live) chunks = []
    if (seen === 0) seen = text.length
    if (!frame) frame = requestAnimationFrame(paint)
  })
  onCleanup(() => cancelAnimationFrame(frame))

  function onClick(event: MouseEvent) {
    const el = event.target as HTMLElement
    const copy = el.closest<HTMLElement>("[data-copy]")
    if (copy) {
      const code = copy.closest("figure")?.querySelector("code, pre")?.textContent ?? ""
      copyText(code).then(() => {
        copy.textContent = "copied"
        setTimeout(() => (copy.textContent = "copy"), 1200)
      }, toastError)
      return
    }
    const link = el.closest<HTMLAnchorElement>("a[data-external]")
    if (link) {
      event.preventDefault()
      openExternal(link.getAttribute("href") ?? "").catch(toastError)
    }
  }

  return <div ref={root} class={`prose selectable ${props.class ?? ""}`} onClick={onClick} />
}
