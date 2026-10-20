// Mock data for the workbench views in MockApp (?mock&workbench=review|terminal|suggest): no engine, no sockets.
import type { Pty, VcsFileDiff } from "@opencode-ai/sdk/v2/types"
import { HttpError, type Http, type HttpResponse } from "../engine/contract"
import { createMockWeft, type MockWeft } from "./weft"

export type Bench = "review" | "terminal" | "suggest"

const ATLAS = "C:\\dev\\atlas-web"

const DIFFS: VcsFileDiff[] = [
  {
    file: "package.json",
    status: "modified",
    additions: 2,
    deletions: 2,
    patch: `--- a/package.json
+++ b/package.json
@@ -4,8 +4,8 @@
   "type": "module",
   "scripts": {
     "dev": "vite",
-    "build": "run-p build:app build:assets",
-    "build:app": "vite build",
+    "build": "run-s build:app build:assets",
+    "build:app": "vite build --emptyOutDir",
     "build:assets": "node scripts/copy-assets.mjs",
     "lint": "eslint ."
   },
`,
  },
  {
    file: "scripts/copy-assets.mjs",
    status: "modified",
    additions: 4,
    deletions: 2,
    patch: `--- a/scripts/copy-assets.mjs
+++ b/scripts/copy-assets.mjs
@@ -1,7 +1,9 @@
-import { cp } from "node:fs/promises"
+import { cp, mkdir, rm } from "node:fs/promises"

 export async function copyAssets(outDir = "dist") {
+  await rm(\`\${outDir}/assets\`, { recursive: true, force: true })
+  await mkdir(\`\${outDir}/assets\`, { recursive: true })
   await cp("public/fonts", \`\${outDir}/assets/fonts\`, { recursive: true })
 }

-copyAssets()
+await copyAssets(process.argv[2])
`,
  },
  {
    file: ".github/workflows/ci.yml",
    status: "added",
    additions: 12,
    deletions: 0,
    patch: `--- /dev/null
+++ b/.github/workflows/ci.yml
@@ -0,0 +1,12 @@
+name: ci
+on: [push, pull_request]
+jobs:
+  build:
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@v4
+      - uses: actions/setup-node@v4
+        with: { node-version: 22, cache: npm }
+      - run: npm ci
+      - run: npm run lint
+      - run: npm run build
`,
  },
  {
    file: "src/legacy/copy-fonts.js",
    status: "deleted",
    additions: 0,
    deletions: 8,
    patch: `--- a/src/legacy/copy-fonts.js
+++ /dev/null
@@ -1,8 +0,0 @@
-const fs = require("fs")
-const path = require("path")
-
-module.exports = function copyFonts(out) {
-  for (const file of fs.readdirSync("public/fonts")) {
-    fs.copyFileSync(path.join("public/fonts", file), path.join(out, "fonts", file))
-  }
-}
`,
  },
  { file: "public/fonts/inter.woff2", status: "modified", additions: 0, deletions: 0 },
]

const FILES = [
  "scripts/copy-assets.mjs",
  "scripts/copy/",
  "src/legacy/copy-fonts.js",
  "src/build/copy.ts",
  "docs/COPYING.md",
  "package.json",
  ".github/workflows/ci.yml",
  "public/fonts/",
]

const PTYS: Pty[] = [
  { id: "pty_pwsh", title: "Terminal 1", command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [], cwd: ATLAS, status: "running", pid: 4120 },
  { id: "pty_bash", title: "Terminal 2", command: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login"], cwd: ATLAS, status: "running", pid: 4188 },
]

const E = "\x1b["
const PS = `PS ${ATLAS}> `
const BASH = `${E}32mdev@atlas${E}35mMINGW64 ${E}33m~/dev/atlas-web ${E}36m(main)${E}0m\r\n$ `

const TRANSCRIPTS: Record<string, string> = {
  pty_pwsh: [
    "PowerShell 7.5.2",
    "",
    `${PS}${E}93mnpm${E}0m run build`,
    "",
    "> atlas-web@0.4.0 build",
    "> run-s build:app build:assets",
    "",
    "> atlas-web@0.4.0 build:app",
    "> vite build --emptyOutDir",
    "",
    `${E}36mvite v6.3.5 ${E}32mbuilding for production...${E}0m`,
    `${E}32m✓${E}0m 412 modules transformed.`,
    `${E}90mdist/${E}0m${E}32mindex.html                ${E}0m${E}1;90m  0.46 kB${E}0m${E}90m │ gzip:  0.30 kB${E}0m`,
    `${E}90mdist/${E}0m${E}35massets/index-4f2a9c1e.css ${E}0m${E}1;90m 18.21 kB${E}0m${E}90m │ gzip:  4.02 kB${E}0m`,
    `${E}90mdist/${E}0m${E}36massets/index-b81d0a73.js  ${E}0m${E}1;90m146.88 kB${E}0m${E}90m │ gzip: 47.15 kB${E}0m`,
    `${E}32m✓ built in 2.41s${E}0m`,
    "",
    "> atlas-web@0.4.0 build:assets",
    "> node scripts/copy-assets.mjs",
    "",
    `${PS}${E}93mgit${E}0m status -s`,
    ` ${E}31mM${E}0m package.json`,
    ` ${E}31mM${E}0m scripts/copy-assets.mjs`,
    ` ${E}31mD${E}0m src/legacy/copy-fonts.js`,
    `${E}31m??${E}0m .github/`,
    PS,
  ].join("\r\n"),
  pty_bash: [
    `${BASH}for i in 1 2 3 4 5; do npm run -s build >/dev/null && echo "ok $i" || echo "FAIL $i"; done`,
    "ok 1",
    "ok 2",
    "ok 3",
    "ok 4",
    "ok 5",
    "",
    BASH,
  ].join("\r\n"),
}

/** Stands in for the engine's PTY websocket: replays a transcript, echoes keystrokes. */
class TranscriptSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  binaryType = "arraybuffer"
  readyState = TranscriptSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    const id = Object.keys(TRANSCRIPTS).find((key) => url.includes(key))
    window.setTimeout(() => {
      this.readyState = TranscriptSocket.OPEN
      this.onopen?.(new Event("open"))
      if (id) this.onmessage?.(new MessageEvent("message", { data: TRANSCRIPTS[id] }))
    }, 30)
  }

  send(data: string) {
    this.onmessage?.(new MessageEvent("message", { data: data.replace(/\r/g, "\r\n") }))
  }

  close() {
    this.readyState = TranscriptSocket.CLOSED
  }
}

const ok = <T>(data: unknown): Promise<HttpResponse<T>> => Promise.resolve({ data: data as T, status: 200, headers: new Headers() })
const offline = (): Promise<never> => Promise.reject(new HttpError(503, undefined, "mock engine: no HTTP"))

const benchHttp: Http = {
  get: <T>(path: string) => {
    if (path === "/vcs/diff") return ok<T>(DIFFS)
    if (path === "/pty") return ok<T>(PTYS)
    const pty = PTYS.find((p) => path === `/pty/${p.id}`)
    return pty ? ok<T>(pty) : offline()
  },
  post: <T>(path: string) => {
    if (path.endsWith("/connect-token")) return ok<T>({ ticket: "mock", expires_in: 60 })
    if (path === "/pty") return ok<T>({ ...PTYS[0], id: `pty_${Date.now()}`, title: "Terminal 3" })
    return offline()
  },
  put: <T>() => ok<T>(true),
  patch: offline,
  del: <T>() => ok<T>(true),
  url: (path) => `http://127.0.0.1:4096${path}`,
  auth: () => `Basic ${btoa("weft:mock")}`,
}

/** A mock engine whose HTTP answers what the review, terminal and suggestion views ask for. */
export function benchWeft(bench: Bench): MockWeft {
  const weft = createMockWeft()
  if (bench === "terminal") window.WebSocket = TranscriptSocket as unknown as typeof WebSocket
  const findFiles = async (query: string) => FILES.filter((f) => f.toLowerCase().includes(query.toLowerCase()))
  return { ...weft, http: benchHttp, actions: { ...weft.actions, findFiles } }
}

/** Types into the prompt as a user would, so the suggestion list opens through the real path. */
export function typeIntoPrompt(text: string) {
  const area = document.querySelector<HTMLTextAreaElement>(".fell-input")
  if (!area) return
  area.focus()
  area.value = text
  area.setSelectionRange(text.length, text.length)
  area.dispatchEvent(new InputEvent("input", { bubbles: true }))
}
