// Renders the NSIS wizard bitmaps from the mark in assets/icon.svg (drop, ripples, wash) on Flow paper.
// usage: node src-tauri/nsis/render-images.mjs   (writes header.bmp 150x57 and sidebar.bmp 164x314 next to itself)
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SUBSAMPLES = 4

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16))
const PAPER = hex("#f2efe7")
const PAPER_2 = hex("#f9f7f2")
const PAPER_3 = hex("#e9e5da")
const INDIGO = hex("#2c4a92")
const INDIGO_BRIGHT = hex("#3d63c4")
const INDIGO_WASH = hex("#dfe5f3")

const mix = (a, b, t) => a.map((channel, i) => channel + (b[i] - channel) * t)
const over = (base, color, alpha) => mix(base, color, Math.max(0, Math.min(1, alpha)))

/** The drop from icon.svg: two cubic curves meeting at the tip and a half circle below. */
const DROP = (() => {
  const points = []
  const cubic = (p0, p1, p2, p3) => {
    for (let i = 1; i <= 64; i++) {
      const t = i / 64
      const u = 1 - t
      points.push([0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]))
    }
  }
  points.push([512, 176])
  cubic([512, 176], [480, 246], [316, 400], [316, 548])
  for (let i = 1; i <= 96; i++) {
    const angle = Math.PI - (Math.PI * i) / 96
    points.push([512 + 196 * Math.cos(angle), 548 + 196 * Math.sin(angle)])
  }
  cubic([708, 548], [708, 400], [544, 246], [512, 176])
  return points
})()

function inPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const ellipseDistance = (x, y, cx, cy, rx, ry) => Math.hypot((x - cx) / rx, (y - cy) / ry)
const onEllipseStroke = (x, y, cx, cy, rx, ry, width) =>
  ellipseDistance(x, y, cx, cy, rx + width / 2, ry + width / 2) <= 1 && ellipseDistance(x, y, cx, cy, rx - width / 2, ry - width / 2) >= 1

/** Paints the mark over `base` at a point in icon.svg's 1024 x 1024 space. */
function mark(base, x, y) {
  let color = base
  const wash = ellipseDistance(x, y, 512, 836, 300, 70)
  if (wash < 1) color = over(color, INDIGO_WASH, 0.9 * (1 - wash))
  if (onEllipseStroke(x, y, 512, 836, 330, 62, 16)) color = over(color, INDIGO_BRIGHT, 0.16)
  if (onEllipseStroke(x, y, 512, 836, 214, 38, 20)) color = over(color, INDIGO_BRIGHT, 0.3)
  if (inPolygon(x, y, DROP)) {
    const u = (x - 316) / 392
    const v = (y - 176) / 568
    const t = ((u - 0.3) * 0.4 + v) / (0.4 * 0.4 + 1)
    color = mix(INDIGO_BRIGHT, INDIGO, Math.max(0, Math.min(1, t)))
    const angle = (-18 * Math.PI) / 180
    const dx = x - 420
    const dy = y - 560
    const rx = dx * Math.cos(angle) - dy * Math.sin(angle)
    const ry = dx * Math.sin(angle) + dy * Math.cos(angle)
    if (Math.hypot(rx / 34, ry / 70) <= 1) color = over(color, PAPER_2, 0.32)
  }
  return color
}

/** `paper(y)` is the background row colour; the mark's 1024 box is drawn at `left, top` with `scale`. */
function render(width, height, paper, { left, top, scale }) {
  const pixels = new Uint8Array(width * height * 3)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const sum = [0, 0, 0]
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const x = px + (sx + 0.5) / SUBSAMPLES
          const y = py + (sy + 0.5) / SUBSAMPLES
          const color = mark(paper(y / height), (x - left) / scale, (y - top) / scale)
          for (let c = 0; c < 3; c++) sum[c] += color[c]
        }
      }
      for (let c = 0; c < 3; c++) pixels[(py * width + px) * 3 + c] = Math.round(sum[c] / SUBSAMPLES ** 2)
    }
  }
  return { width, height, pixels }
}

/** 24-bit bottom-up BI_RGB bitmap, the format NSIS's MUI expects. */
function bmp({ width, height, pixels }) {
  const stride = Math.ceil((width * 3) / 4) * 4
  const file = Buffer.alloc(54 + stride * height)
  file.write("BM", 0, "ascii")
  file.writeUInt32LE(file.length, 2)
  file.writeUInt32LE(54, 10)
  file.writeUInt32LE(40, 14)
  file.writeInt32LE(width, 18)
  file.writeInt32LE(height, 22)
  file.writeUInt16LE(1, 26)
  file.writeUInt16LE(24, 28)
  file.writeUInt32LE(stride * height, 34)
  file.writeInt32LE(2835, 38)
  file.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)
      file[row + x * 3] = b
      file[row + x * 3 + 1] = g
      file[row + x * 3 + 2] = r
    }
  }
  return file
}

const sidebarPaper = (t) => (t < 0.55 ? mix(PAPER_2, PAPER, t / 0.55) : mix(PAPER, PAPER_3, (t - 0.55) / 0.45))
const sidebarScale = 0.17
writeFileSync(
  join(HERE, "sidebar.bmp"),
  bmp(render(164, 314, sidebarPaper, { left: 82 - 512 * sidebarScale, top: 150 - 537 * sidebarScale, scale: sidebarScale })),
)

const headerScale = 0.066
writeFileSync(
  join(HERE, "header.bmp"),
  bmp(render(150, 57, () => PAPER, { left: 122 - 512 * headerScale, top: 28.5 - 537 * headerScale, scale: headerScale })),
)
