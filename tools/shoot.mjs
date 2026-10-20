// Full-resolution screenshot of a URL with headless Edge.
// usage: node tools/shoot.mjs <url> <out.png> [width] [height] [budgetMs]
import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const [url, out, width = "1440", height = "900", budget = "3000"] = process.argv.slice(2)
const candidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
]
const edge = candidates.find(existsSync)
if (!edge) throw new Error("msedge.exe not found")
const profile = join(process.env.LOCALAPPDATA ?? "C:/Temp", "Temp", `es-weft-${process.pid}`)
try {
  execFileSync(edge, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${budget}`,
    `--screenshot=${out}`,
    url,
  ], { stdio: "ignore", timeout: 60000 })
} finally {
  rmSync(profile, { recursive: true, force: true })
}
console.log(out)
