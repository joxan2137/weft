import { Marked, type Tokens } from "marked"
import type { HighlighterCore, ThemeRegistration } from "shiki/core"

const escapeMap: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHTML = (s: string) => s.replace(/[&<>"']/g, (c) => escapeMap[c])

const LANGS: Record<string, () => Promise<unknown>> = {
  ts: () => import("shiki/langs/typescript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  js: () => import("shiki/langs/javascript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  rs: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  py: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  sh: () => import("shiki/langs/bash.mjs"),
  shell: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  ps1: () => import("shiki/langs/powershell.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  md: () => import("shiki/langs/markdown.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  yml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  luau: () => import("shiki/langs/luau.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
}

const LANG_ALIAS: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  rs: "rust",
  py: "python",
  sh: "bash",
  shell: "bash",
  ps1: "powershell",
  md: "markdown",
  yml: "yaml",
}

const weftTheme: ThemeRegistration = {
  name: "weft",
  type: "light",
  colors: { "editor.background": "#00000000", "editor.foreground": "var(--syn-text)" },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syn-comment)", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "keyword.control", "storage.type", "storage.modifier"], settings: { foreground: "var(--syn-keyword)" } },
    { scope: ["string", "string.template", "markup.inline.raw"], settings: { foreground: "var(--syn-string)" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant"], settings: { foreground: "var(--syn-constant)" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "var(--syn-function)" } },
    { scope: ["entity.name.type", "support.type", "support.class", "entity.name.class"], settings: { foreground: "var(--syn-type)" } },
    { scope: ["variable.parameter", "variable.other.property", "meta.object-literal.key"], settings: { foreground: "var(--syn-property)" } },
    { scope: ["entity.name.tag", "markup.heading"], settings: { foreground: "var(--syn-constant)" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--syn-type)" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "var(--syn-punctuation)" } },
    { scope: ["markup.inserted"], settings: { foreground: "var(--syn-string)" } },
    { scope: ["markup.deleted"], settings: { foreground: "var(--carmine)" } },
  ],
}

let highlighter: Promise<HighlighterCore> | undefined
const loaded = new Set<string>()

function getHighlighter() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({ themes: [weftTheme], langs: [], engine: createJavaScriptRegexEngine() }),
  )
  return highlighter
}

const CACHE_CHARS = 4_000_000
/** Least recently used first, bounded by the size of what it holds rather than by the number of blocks. */
const highlightCache = new Map<string, string>()
let cachedChars = 0

function cache(key: string, html: string) {
  const old = highlightCache.get(key)
  if (old !== undefined) cachedChars -= key.length + old.length
  highlightCache.delete(key)
  highlightCache.set(key, html)
  cachedChars += key.length + html.length
  for (const [oldest, value] of highlightCache) {
    if (cachedChars <= CACHE_CHARS || oldest === key) break
    highlightCache.delete(oldest)
    cachedChars -= oldest.length + value.length
  }
}

export function highlightCached(code: string, lang: string) {
  const key = `${lang}\u0000${code}`
  const hit = highlightCache.get(key)
  if (hit !== undefined) {
    highlightCache.delete(key)
    highlightCache.set(key, hit)
  }
  return hit
}

/** Resolves highlighted HTML for a code block, or undefined for unknown languages. */
export async function highlight(code: string, lang: string): Promise<string | undefined> {
  const key = `${lang}\u0000${code}`
  const hit = highlightCached(code, lang)
  if (hit) return hit
  const load = LANGS[lang]
  if (!load) return undefined
  const h = await getHighlighter()
  const name = LANG_ALIAS[lang] ?? lang
  if (!loaded.has(name)) {
    const mod = (await load()) as { default: Parameters<HighlighterCore["loadLanguage"]>[0] }
    await h.loadLanguage(mod.default)
    loaded.add(name)
  }
  const html = h.codeToHtml(code, { lang: name, theme: "weft" })
  cache(key, html)
  return html
}

/** Set while rendering a reply that is still streaming. */
let streaming = false
const CLOSING_FENCE = /\n[ \t]*(`{3,}|~{3,})[ \t]*\n*$/

/** A fence still being written runs to the end of the text and changes every frame: it is highlighted once it closes. */
const growing = (token: Tokens.Code) => streaming && token.codeBlockStyle !== "indented" && !CLOSING_FENCE.test(token.raw)

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHTML(token.text)
    },
    code(token: Tokens.Code) {
      const lang = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase()
      const open = growing(token)
      const cached = open ? undefined : highlightCached(token.text, lang)
      const body = cached ?? `<pre class="shiki"><code>${escapeHTML(token.text)}</code></pre>`
      return (
        `<figure class="code" data-lang="${escapeHTML(lang)}" data-pending="${cached || open || !LANGS[lang] ? "" : "1"}">` +
        `<figcaption><span class="label">${escapeHTML(lang || "text")}</span><button class="copy label" data-copy>copy</button></figcaption>` +
        body +
        `</figure>`
      )
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens)
      return `<a href="${escapeHTML(token.href)}" data-external title="${escapeHTML(token.href)}">${text}</a>`
    },
    image(token: Tokens.Image) {
      return `<span class="image-ref">[image: ${escapeHTML(token.text || token.href)}]</span>`
    },
  },
})

/** `live`: the text is still streaming, so a code fence it ends inside is left unhighlighted until it closes. */
export function renderMarkdown(text: string, live = false) {
  streaming = live
  try {
    return marked.parse(text, { async: false }) as string
  } finally {
    streaming = false
  }
}

/** Upgrades plain code blocks inside `root` to highlighted ones once their grammar loads. */
export function upgradeCodeBlocks(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("figure.code[data-pending='1']").forEach((figure) => {
    const code = figure.querySelector("code")?.textContent ?? ""
    const lang = figure.dataset.lang ?? ""
    figure.dataset.pending = ""
    highlight(code, lang).then((html) => {
      if (!html || !figure.isConnected) return
      const pre = figure.querySelector("pre")
      if (pre) pre.outerHTML = html
    })
  })
}
