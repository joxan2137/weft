// Ink in water: a stable-fluids simulation (semi-Lagrangian advection, vorticity confinement,
// Jacobi pressure solve) run at low resolution on the GPU. The dye texture holds optical density
// per channel. By day inks mix subtractively, as pigment on paper: colour = paper · e^(−density).
// At night the same density is light in dark water, the dual: colour = 1 − (1 − ground) · e^(−density),
// so overlapping inks screen each other and glow. Water absorbs red first, so thin light turns deep blue
// and only dense cores keep the ink's own hue: a warm ink screened thin over the dark would read as rust.
// The solver is adapted from WebGL-Fluid-Simulation by Pavel Dobryakov
// (https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), MIT License, Copyright (c) 2017 Pavel Dobryakov.
// See licenses/LICENSE-webgl-fluid-simulation.txt.
import type { Splat } from "./ink"

const SIM_RES = 112
const DYE_RES = 448
const PRESSURE_ITERATIONS = 16
const CURL = 14
const VELOCITY_DISSIPATION = 0.9
const DENSITY_DISSIPATION = 0.035
const PRESSURE_DECAY = 0.8
const SPLAT_RADIUS = 0.0022

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
uniform vec2 texelSize;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
`

const FRAG = {
  splat: `${HEAD}
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  outColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`,
  advect: `${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  outColor = texture(uSource, coord) / (1.0 + dissipation * dt);
}`,
  divergence: `${HEAD}
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,
  curl: `${HEAD}
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,
  vorticity: `${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
  outColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}`,
  pressure: `${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`,
  gradient: `${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  outColor = vec4(velocity, 0.0, 1.0);
}`,
  scale: `${HEAD}
uniform sampler2D uTexture;
uniform float value;
void main () {
  outColor = value * texture(uTexture, vUv);
}`,
  display: `${HEAD}
uniform sampler2D uDye;
uniform vec3 uPaper;
uniform vec4 uVeil;
uniform float uVeilStrength;
uniform float uNight;
uniform vec2 uResolution;
void main () {
  vec3 density = texture(uDye, vUv).rgb;
  float edge = mix(0.05, 0.1, uNight);
  float inColumn = smoothstep(uVeil.x - edge, uVeil.x + 0.03, vUv.x) * (1.0 - smoothstep(uVeil.z - 0.03, uVeil.z + edge, vUv.x));
  vec3 transmitted = exp(-density * mix(1.0, uVeilStrength, inColumn));
  vec3 day = uPaper * transmitted;
  vec3 lit = 1.0 - transmitted;
  float glow = max(lit.r, max(lit.g, lit.b));
  vec3 deep = vec3(0.14, 0.24, 0.78) * glow;
  vec3 light = mix(deep, lit, smoothstep(0.12, 0.7, glow)) + smoothstep(0.6, 0.95, glow) * 0.05;
  vec3 night = uPaper + (1.0 - uPaper) * light;
  night += vec3(0.004, 0.007, 0.013) * vUv.y;
  vec3 color = mix(day, night, uNight);
  float grain = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
  color += (grain - 0.5) * mix(0.014, 0.01, uNight);
  vec2 c = vUv - 0.5;
  color *= 1.0 - dot(c, c) * mix(0.05, 0.12, uNight);
  outColor = vec4(color, 1.0);
}`,
}

type Target = { texture: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number }
type Double = { read: Target; write: Target; swap: () => void }
type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }

/** Linear RGB in 0..1 of a CSS colour like "#e0533a". */
export function rgbOf(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/** Optical density that turns white paper into this colour: d = −ln(c). */
export function densityOf(rgb: [number, number, number]): [number, number, number] {
  return rgb.map((c) => -Math.log(Math.max(0.02, c))) as [number, number, number]
}

/** The density that, screened over black water, glows this colour: d = −ln(1 − c). */
export function glowOf(rgb: [number, number, number]): [number, number, number] {
  return rgb.map((c) => -Math.log(1 - Math.min(0.97, c))) as [number, number, number]
}

export class Water {
  private gl: WebGL2RenderingContext
  private programs: Record<keyof typeof FRAG, Program>
  private velocity!: Double
  private dye!: Double
  private pressure!: Double
  private divergence!: Target
  private curl!: Target
  private quad: WebGLVertexArrayObject
  private paper: [number, number, number]
  private veil: [number, number, number, number] = [0.3, 0, 0.7, 1]
  private night = false

  static create(canvas: HTMLCanvasElement, paper: [number, number, number]) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" })
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return undefined
    try {
      return new Water(gl, paper)
    } catch (error) {
      console.error("[water]", error)
      return undefined
    }
  }

  private constructor(gl: WebGL2RenderingContext, paper: [number, number, number]) {
    this.gl = gl
    this.paper = paper
    const vert = this.compile(gl.VERTEX_SHADER, VERT)
    this.programs = Object.fromEntries(
      Object.entries(FRAG).map(([name, src]) => [name, this.link(vert, this.compile(gl.FRAGMENT_SHADER, src))]),
    ) as Record<keyof typeof FRAG, Program>
    this.quad = gl.createVertexArray()!
    gl.bindVertexArray(this.quad)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.allocate()
  }

  private compile(type: number, source: string) {
    const gl = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader")
    return shader
  }

  private link(vert: WebGLShader, frag: WebGLShader): Program {
    const gl = this.gl
    const program = gl.createProgram()!
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.bindAttribLocation(program, 0, "aPosition")
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program")
    const uniforms: Program["uniforms"] = {}
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i)!.name
      uniforms[name] = gl.getUniformLocation(program, name)
    }
    return { program, uniforms }
  }

  private target(width: number, height: number): Target {
    const gl = this.gl
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return { texture, fbo, width, height }
  }

  private double(width: number, height: number): Double {
    const pair = { read: this.target(width, height), write: this.target(width, height) } as Double
    pair.swap = () => {
      const t = pair.read
      pair.read = pair.write
      pair.write = t
    }
    return pair
  }

  private size(base: number) {
    const aspect = this.gl.drawingBufferWidth / Math.max(1, this.gl.drawingBufferHeight)
    return aspect >= 1 ? { width: Math.round(base * aspect), height: base } : { width: base, height: Math.round(base / aspect) }
  }

  /** (Re)allocates the simulation for the canvas' current shape. Ink is kept when it exists. */
  allocate() {
    const sim = this.size(SIM_RES)
    const dye = this.size(DYE_RES)
    const old = this.dye
    this.velocity = this.double(sim.width, sim.height)
    this.pressure = this.double(sim.width, sim.height)
    this.divergence = this.target(sim.width, sim.height)
    this.curl = this.target(sim.width, sim.height)
    this.dye = this.double(dye.width, dye.height)
    if (old) {
      this.use("scale", old.read.texture)
      this.uniform("scale", "value", 1)
      this.blit(this.dye.write)
      this.dye.swap()
    }
  }

  /** Day or night paper. The ink in the water means different colours in each, so changing it empties the water. */
  setPaper(paper: [number, number, number], night: boolean) {
    this.paper = paper
    if (night !== this.night) this.clear()
    this.night = night
  }

  /** Empties the water: no ink, no current. */
  clear() {
    const gl = this.gl
    for (const target of [this.dye.read, this.dye.write, this.velocity.read, this.velocity.write, this.pressure.read, this.pressure.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      gl.viewport(0, 0, target.width, target.height)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  /** The reading column, as a fraction of the window width: ink there is drawn paler. */
  setVeil(left: number, right: number) {
    this.veil = [left, 0, right, 1]
  }

  private use(name: keyof typeof FRAG, ...textures: WebGLTexture[]) {
    const gl = this.gl
    const program = this.programs[name]
    gl.useProgram(program.program)
    textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    })
    return program
  }

  private uniform(name: keyof typeof FRAG, key: string, ...values: number[]) {
    const gl = this.gl
    const location = this.programs[name].uniforms[key]
    if (location === undefined || location === null) return
    if (values.length === 1) gl.uniform1f(location, values[0])
    else if (values.length === 2) gl.uniform2f(location, values[0], values[1])
    else if (values.length === 3) gl.uniform3f(location, values[0], values[1], values[2])
    else gl.uniform4f(location, values[0], values[1], values[2], values[3])
  }

  private sampler(name: keyof typeof FRAG, key: string, unit: number) {
    const location = this.programs[name].uniforms[key]
    if (location) this.gl.uniform1i(location, unit)
  }

  private blit(target: Target | null) {
    const gl = this.gl
    if (target) {
      gl.viewport(0, 0, target.width, target.height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    gl.bindVertexArray(this.quad)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * Puts a splat in: density into the dye, impulse into the velocity. x, y in 0..1 from the top
   * left; dx, dy in window widths and heights per second.
   */
  splat(x: number, y: number, dx: number, dy: number, density: [number, number, number], radius: number) {
    const aspect = this.gl.drawingBufferWidth / Math.max(1, this.gl.drawingBufferHeight)
    const sim = this.velocity.read
    const r = SPLAT_RADIUS * radius * radius * (aspect > 1 ? aspect : 1)
    this.use("splat", this.velocity.read.texture)
    this.sampler("splat", "uTarget", 0)
    this.uniform("splat", "aspectRatio", aspect)
    this.uniform("splat", "point", x, 1 - y)
    this.uniform("splat", "color", dx * sim.width, -dy * sim.height, 0)
    this.uniform("splat", "radius", r)
    this.blit(this.velocity.write)
    this.velocity.swap()
    if (density.some((d) => d > 0)) {
      this.use("splat", this.dye.read.texture)
      this.sampler("splat", "uTarget", 0)
      this.uniform("splat", "color", ...density)
      this.uniform("splat", "radius", r * 1.6)
      this.blit(this.dye.write)
      this.dye.swap()
    }
  }

  /** Advances the water by dt seconds. */
  step(dt: number) {
    const sim = this.velocity.read
    const texel = [1 / sim.width, 1 / sim.height] as const

    this.use("curl", this.velocity.read.texture)
    this.uniform("curl", "texelSize", ...texel)
    this.sampler("curl", "uVelocity", 0)
    this.blit(this.curl)

    this.use("vorticity", this.velocity.read.texture, this.curl.texture)
    this.uniform("vorticity", "texelSize", ...texel)
    this.sampler("vorticity", "uVelocity", 0)
    this.sampler("vorticity", "uCurl", 1)
    this.uniform("vorticity", "curl", CURL)
    this.uniform("vorticity", "dt", dt)
    this.blit(this.velocity.write)
    this.velocity.swap()

    this.use("divergence", this.velocity.read.texture)
    this.uniform("divergence", "texelSize", ...texel)
    this.sampler("divergence", "uVelocity", 0)
    this.blit(this.divergence)

    this.use("scale", this.pressure.read.texture)
    this.sampler("scale", "uTexture", 0)
    this.uniform("scale", "value", PRESSURE_DECAY)
    this.blit(this.pressure.write)
    this.pressure.swap()

    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      this.use("pressure", this.pressure.read.texture, this.divergence.texture)
      this.uniform("pressure", "texelSize", ...texel)
      this.sampler("pressure", "uPressure", 0)
      this.sampler("pressure", "uDivergence", 1)
      this.blit(this.pressure.write)
      this.pressure.swap()
    }

    this.use("gradient", this.pressure.read.texture, this.velocity.read.texture)
    this.uniform("gradient", "texelSize", ...texel)
    this.sampler("gradient", "uPressure", 0)
    this.sampler("gradient", "uVelocity", 1)
    this.blit(this.velocity.write)
    this.velocity.swap()

    this.use("advect", this.velocity.read.texture, this.velocity.read.texture)
    this.uniform("advect", "texelSize", ...texel)
    this.sampler("advect", "uVelocity", 0)
    this.sampler("advect", "uSource", 1)
    this.uniform("advect", "dt", dt)
    this.uniform("advect", "dissipation", VELOCITY_DISSIPATION)
    this.blit(this.velocity.write)
    this.velocity.swap()

    this.use("advect", this.velocity.read.texture, this.dye.read.texture)
    this.uniform("advect", "texelSize", ...texel)
    this.sampler("advect", "uVelocity", 0)
    this.sampler("advect", "uSource", 1)
    this.uniform("advect", "dt", dt)
    this.uniform("advect", "dissipation", DENSITY_DISSIPATION)
    this.blit(this.dye.write)
    this.dye.swap()
  }

  /** Draws the ink onto the paper. */
  render() {
    const gl = this.gl
    this.use("display", this.dye.read.texture)
    this.sampler("display", "uDye", 0)
    this.uniform("display", "uPaper", ...this.paper)
    this.uniform("display", "uVeil", ...this.veil)
    this.uniform("display", "uVeilStrength", this.night ? 0.3 : 0.22)
    this.uniform("display", "uNight", this.night ? 1 : 0)
    this.uniform("display", "uResolution", gl.drawingBufferWidth, gl.drawingBufferHeight)
    this.blit(null)
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext()
  }
}

export type { Splat }
