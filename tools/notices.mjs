// Writes licenses/THIRD_PARTY_NOTICES.txt: the licence texts and notices of the npm packages bundled into the interface
// (the production dependencies in package.json and everything they pull in) and of the Rust crates in src-tauri/Cargo.lock
// that build for Windows x64, each identical text printed once with the packages that use it.
// It reads node_modules and the Cargo registry sources, so run it after `npm install` and a cargo build. It exits 1 when a
// package or a crate's source is missing.
// usage: node tools/notices.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "licenses", "THIRD_PARTY_NOTICES.txt")
const TAURI_DIR = join(ROOT, "src-tauri")
const REGISTRY_SOURCES = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "src")
const TARGET = "x86_64-pc-windows-msvc"
/** The cfg values rustc sets for TARGET; every other name (unix, docsrs, miri, loom...) is false. */
const TARGET_CFG = {
  windows: true,
  target_os: ["windows"],
  target_family: ["windows"],
  target_arch: ["x86_64"],
  target_env: ["msvc"],
  target_vendor: ["pc"],
  target_pointer_width: ["64"],
  target_endian: ["little"],
  target_has_atomic: ["8", "16", "32", "64", "ptr"],
  target_feature: ["fxsr", "sse", "sse2"],
}
const DEPENDENCY_KINDS = {
  dependencies: "normal",
  "build-dependencies": "build",
  build_dependencies: "build",
  "dev-dependencies": "dev",
  dev_dependencies: "dev",
}
const LICENSE_FILE = /^(?:licen[cs]es?|copying|copyright|notices?)(?:[-_.][\w.-]*)?$/i
const NOT_LICENSE_TEXT = /\.(?:[cm]?[jt]s|json|map|html?|rs|toml|spdx)$/i
/** Packages that publish no licence file although their licence text ships with Weft. */
const TEXT_IN_REPO = { "@opencode-ai/sdk": "licenses/LICENSE-opencode.txt" }
const NOTICE_KIND = "NOTICE files"
const OTHER_KIND = "Other licence and copyright texts"
/** Recognises a licence from its text with whitespace collapsed; the first match wins. */
const LICENSE_KINDS = [
  ["Apache-2.0 WITH LLVM-exception", /LLVM Exceptions to the Apache 2\.0 License/i],
  ["Apache-2.0", /Apache License,? Version 2\.0/i],
  ["MPL-2.0", /Mozilla Public License,? (?:Version|v\.?) ?2\.0/i],
  ["BSL-1.0", /Boost Software License/i],
  ["Unicode-3.0", /UNICODE LICENSE V3/i],
  ["Unicode-DFS-2016", /UNICODE, INC\. LICENSE AGREEMENT/i],
  ["OFL-1.1", /SIL OPEN FONT LICENSE/i],
  ["Zlib", /Altered source versions must be plainly marked as such/i],
  ["BSD-3-Clause", /Redistribution and use in source and binary forms.*(?:Neither the name|names of its contributors)/i],
  ["BSD-2-Clause", /Redistribution and use in source and binary forms/i],
  ["0BSD", /distribute this software for any purpose with or without fee is hereby granted\. /i],
  ["ISC", /distribute this software for any purpose with or without fee is hereby granted, provided/i],
  ["MIT", /Permission is hereby granted, free of charge, to any person/i],
  ["Unlicense", /This is free and unencumbered software released into the public domain/i],
  ["CC0-1.0", /CC0 1\.0 Universal/i],
]
const COPYLEFT = /\b(?:MPL|LGPL|GPL|EPL|CDDL)-/
const WIDTH = 100
const RULE = "=".repeat(80)
const THIN_RULE = "-".repeat(80)

const missing = []
const notes = []

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const quoted = (text) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1])
const unquote = (value) => {
  const match = value.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/)
  return match ? (match[1] ?? match[2]) : value
}
const personName = (person) => (typeof person === "string" ? person : (person?.name ?? "")).replace(/\s*[<(].*$/, "").trim()
const cleanUrl = (url) => url?.replace(/^git\+/, "").replace(/\.git$/, "")

function tidy(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
}

function licenseTexts(dir, extra = []) {
  const files = new Set(extra.filter((file) => existsSync(join(dir, file))))
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!LICENSE_FILE.test(entry.name) || NOT_LICENSE_TEXT.test(entry.name)) continue
    if (entry.isFile()) files.add(entry.name)
    else if (entry.isDirectory())
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true }))
        if (inner.isFile() && !NOT_LICENSE_TEXT.test(inner.name)) files.add(`${entry.name}/${inner.name}`)
  }
  return [...files]
    .sort()
    .map((file) => ({ file, text: tidy(readFileSync(join(dir, file), "utf8")) }))
    .filter(({ text }) => text)
}

// npm

function resolveNpm(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return candidate
    if (dir === ROOT || dirname(dir) === dir) return undefined
  }
}

function npmLicense({ license, licenses }) {
  if (typeof license === "string") return license
  if (license?.type) return license.type
  if (Array.isArray(licenses)) return licenses.map((entry) => entry.type ?? entry).join(" OR ")
  return "unknown"
}

/** Walks the production dependency tree from package.json; package-lock.json drops anything npm marks dev-only. */
function npmPackages() {
  const lock = existsSync(join(ROOT, "package-lock.json")) ? (readJson(join(ROOT, "package-lock.json")).packages ?? {}) : {}
  const found = new Map()
  const queue = Object.keys(readJson(join(ROOT, "package.json")).dependencies ?? {}).map((name) => ({ name, from: ROOT, required: true }))
  while (queue.length) {
    const { name, from, required } = queue.shift()
    // Type declarations never reach the bundle.
    if (name.startsWith("@types/")) continue
    const dir = resolveNpm(from, name)
    if (!dir) {
      if (required) missing.push(`npm package ${name}, needed by ${relative(ROOT, from) || "package.json"}`)
      continue
    }
    if (found.has(dir) || lock[relative(ROOT, dir).split(sep).join("/")]?.dev) continue
    const manifest = readJson(join(dir, "package.json"))
    const inRepo = TEXT_IN_REPO[manifest.name]
    found.set(dir, {
      label: `${manifest.name}@${manifest.version}`,
      license: npmLicense(manifest),
      authors: [manifest.author, ...[manifest.contributors ?? []].flat()].map(personName).filter(Boolean),
      home: cleanUrl(manifest.homepage ?? (typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url)),
      source: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
      buildOnly: false,
      texts: [...licenseTexts(dir), ...(inRepo ? [{ file: inRepo, text: tidy(readFileSync(join(ROOT, inRepo), "utf8")) }] : [])],
    })
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, from: dir, required: true })
    for (const dependency of Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies }))
      queue.push({ name: dependency, from: dir, required: false })
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label))
}

// Rust

function parseLock(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .map((block) => ({
      name: block.match(/^name = "(.+)"$/m)[1],
      version: block.match(/^version = "(.+)"$/m)[1],
      source: block.match(/^source = "(.+)"$/m)?.[1],
      dependencies: [...(block.match(/^dependencies = \[\n([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    }))
}

function dottedKey(text) {
  return [...text.matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([\w-]+))\s*(?:\.|$)/g)].map(
    (match) => match[1]?.replace(/\\(.)/g, "$1") ?? match[2] ?? match[3],
  )
}

function dependencySection([first, second, third]) {
  if (Object.hasOwn(DEPENDENCY_KINDS, first)) return { kind: DEPENDENCY_KINDS[first], target: undefined, depth: 1 }
  if (first === "target" && Object.hasOwn(DEPENDENCY_KINDS, third)) return { kind: DEPENDENCY_KINDS[third], target: second, depth: 3 }
  return undefined
}

/** Reads the parts of a (registry-normalized) Cargo.toml this script needs, without a TOML library. */
function parseManifest(text) {
  const manifest = { license: undefined, licenseFile: undefined, authors: [], home: undefined, procMacro: false, dependencies: [] }
  let table = []
  let section
  let current
  let aliases = new Map()
  let inString = false
  let inAuthors = false
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fences = (line.match(/"""|'''/g) ?? []).length
    if (inString || fences % 2) {
      if (fences % 2) inString = !inString
      continue
    }
    if (inAuthors) {
      manifest.authors.push(...quoted(line))
      inAuthors = !line.includes("]")
      continue
    }
    const header = line.match(/^\s*\[{1,2}(.+?)\]{1,2}\s*(?:#.*)?$/)
    if (header) {
      table = dottedKey(header[1])
      section = dependencySection(table)
      current = undefined
      aliases = new Map()
      if (section && table.length > section.depth) {
        current = { name: table[section.depth], kind: section.kind, target: section.target }
        manifest.dependencies.push(current)
      }
      continue
    }
    const pair = line.match(/^\s*((?:"[^"]*"|'[^']*'|[\w-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[\w-]+))*)\s*=\s*(.*?)\s*$/)
    if (!pair) continue
    const key = dottedKey(pair[1])
    const value = pair[2]
    if (current) {
      if (key[0] === "package") current.name = unquote(value)
    } else if (section) {
      let dependency = aliases.get(key[0])
      if (!dependency) {
        dependency = { name: key[0], kind: section.kind, target: section.target }
        aliases.set(key[0], dependency)
        manifest.dependencies.push(dependency)
      }
      const renamed = key[1] === "package" ? unquote(value) : value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1]
      if (renamed) dependency.name = renamed
    } else if (table.length === 1 && table[0] === "package") {
      if (key[0] === "license") manifest.license = unquote(value)
      else if (key[0] === "license-file") manifest.licenseFile = unquote(value)
      else if (key[0] === "repository") manifest.home = unquote(value)
      else if (key[0] === "homepage") manifest.home ??= unquote(value)
      else if (key[0] === "authors") {
        manifest.authors.push(...quoted(value))
        inAuthors = !value.includes("]")
      }
    } else if (table.length === 1 && table[0] === "lib" && /^proc[-_]macro$/.test(key[0])) manifest.procMacro = value === "true"
  }
  return manifest
}

function cfgHolds(expression) {
  const tokens = [...expression.matchAll(/\s*(?:([A-Za-z_]\w*)|"([^"]*)"|([(),=]))/gy)].map(([, word, string, mark]) => ({
    word,
    string,
    mark,
  }))
  let at = 0
  const predicate = () => {
    const { word } = tokens[at++] ?? {}
    if (tokens[at]?.mark === "(") {
      at++
      const values = []
      while (at < tokens.length && tokens[at].mark !== ")") {
        values.push(predicate())
        if (tokens[at]?.mark === ",") at++
      }
      at++
      if (word === "all") return values.every(Boolean)
      if (word === "any") return values.some(Boolean)
      return word === "not" && !values[0]
    }
    if (tokens[at]?.mark === "=") {
      const value = tokens[at + 1]?.string
      at += 2
      return Object.hasOwn(TARGET_CFG, word) && [TARGET_CFG[word]].flat().includes(value)
    }
    return Object.hasOwn(TARGET_CFG, word) && TARGET_CFG[word] === true
  }
  return predicate()
}

function targetMatches(target) {
  if (target === undefined) return true
  const expression = target.match(/^cfg\((.*)\)$/s)?.[1]
  return expression === undefined ? target === TARGET : cfgHolds(expression)
}

/**
 * The crates Cargo.lock resolves, narrowed to the ones that build for TARGET (dev-dependencies and other platforms' dependencies
 * dropped). Crates that only run while Weft compiles (build scripts, procedural macros and what they use) are marked buildOnly.
 */
function cratePackages() {
  const lock = parseLock(readFileSync(join(TAURI_DIR, "Cargo.lock"), "utf8"))
  const byName = new Map()
  for (const entry of lock) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry])
  const registries = existsSync(REGISTRY_SOURCES) ? readdirSync(REGISTRY_SOURCES).map((index) => join(REGISTRY_SOURCES, index)) : []
  for (const entry of lock) {
    entry.dir = entry.source ? registries.map((index) => join(index, `${entry.name}-${entry.version}`)).find(existsSync) : TAURI_DIR
    const manifestPath = entry.dir && join(entry.dir, "Cargo.toml")
    entry.manifest = manifestPath && existsSync(manifestPath) ? parseManifest(readFileSync(manifestPath, "utf8")) : undefined
  }

  const find = (reference) => {
    const [name, version] = reference.split(" ")
    const candidates = byName.get(name) ?? []
    return version ? candidates.find((entry) => entry.version === version) : candidates[0]
  }
  const edgeCache = new Map()
  const edges = (entry) => {
    if (!edgeCache.has(entry)) edgeCache.set(entry, activeDependencies(entry))
    return edgeCache.get(entry)
  }
  const activeDependencies = (entry) =>
    entry.dependencies.flatMap((reference) => {
      const child = find(reference)
      if (!child) {
        notes.push(`Cargo.lock lists ${reference} under ${entry.name} but has no such package`)
        return []
      }
      const declared = entry.manifest?.dependencies.filter((dependency) => dependency.name === child.name) ?? []
      if (!declared.length) {
        if (entry.manifest) notes.push(`${child.name} is not declared in ${entry.name} ${entry.version}'s Cargo.toml; kept`)
        return [{ child, linked: true }]
      }
      const active = declared.filter((dependency) => dependency.kind !== "dev" && targetMatches(dependency.target))
      return active.length ? [{ child, linked: active.some((dependency) => dependency.kind === "normal") }] : []
    })
  const roots = lock.filter((entry) => !entry.source)
  const closure = (follow) => {
    const seen = new Set(roots)
    for (const queue = [...roots]; queue.length; )
      for (const child of follow(queue.shift()))
        if (!seen.has(child)) {
          seen.add(child)
          queue.push(child)
        }
    return seen
  }
  const built = closure((entry) => edges(entry).map(({ child }) => child))
  const linked = closure((entry) =>
    entry.manifest?.procMacro ? [] : edges(entry).flatMap(({ child, linked }) => (linked && !child.manifest?.procMacro ? [child] : [])),
  )

  return [...built]
    .filter((entry) => entry.source)
    .map((entry) => {
      if (!entry.dir) missing.push(`crate source ${entry.name}-${entry.version} (${entry.source}) is not under ${REGISTRY_SOURCES}`)
      return {
        label: `${entry.name} ${entry.version}`,
        license: entry.manifest?.license ?? (entry.manifest?.licenseFile ? "see its licence file" : "unknown"),
        authors: (entry.manifest?.authors ?? []).map(personName).filter(Boolean),
        home: cleanUrl(entry.manifest?.home),
        source: `https://crates.io/crates/${entry.name}/${entry.version}`,
        buildOnly: !linked.has(entry),
        texts: entry.dir ? licenseTexts(entry.dir, entry.manifest?.licenseFile ? [entry.manifest.licenseFile] : []) : [],
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }))
}

// Output

function kindOf(file, text) {
  const name = file.split("/").at(-1)
  if (/^notices?(?:[-_.]|$)/i.test(name)) return NOTICE_KIND
  if (/^copyright/i.test(name)) return OTHER_KIND
  const flat = text.replace(/\s+/g, " ")
  return LICENSE_KINDS.find(([, pattern]) => pattern.test(flat))?.[0] ?? OTHER_KIND
}

/** kind -> distinct texts (whitespace-insensitive) -> the packages that publish each. */
function groupTexts(packages) {
  const kinds = new Map()
  for (const pkg of packages)
    for (const { file, text } of pkg.texts) {
      const kind = kindOf(file, text)
      if (!kinds.has(kind)) kinds.set(kind, new Map())
      const texts = kinds.get(kind)
      const key = text.replace(/\s+/g, " ")
      if (!texts.has(key)) texts.set(key, { text, users: new Set() })
      texts.get(key).users.add(pkg.label)
    }
  return kinds
}

function wrapList(prefix, items, indent = "  ") {
  const lines = []
  let line = prefix
  items.forEach((item, index) => {
    const piece = index < items.length - 1 ? `${item},` : item
    if (line.length + 1 + piece.length > WIDTH) {
      lines.push(line)
      line = `${indent}${piece}`
    } else line = `${line} ${piece}`
  })
  return [...lines, line]
}

function tally(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function indexLines(packages) {
  const width = Math.min(52, Math.max(...packages.map((pkg) => pkg.label.length)) + 2)
  return packages.map((pkg) => {
    const marks = [pkg.buildOnly && "build time", !pkg.texts.length && "no licence file"].filter(Boolean)
    return `  ${pkg.label.padEnd(width)}${pkg.license}${marks.length ? `  (${marks.join(", ")})` : ""}`
  })
}

function render(npm, crates) {
  const all = [...npm, ...crates]
  const buildOnly = crates.filter((pkg) => pkg.buildOnly).length
  const out = [
    "Weft third-party notices",
    "",
    "Weft includes the open-source software listed here. The npm packages are bundled into its interface:",
    "the production dependencies in package.json and the packages they depend on. The Rust crates are the",
    `ones in src-tauri/Cargo.lock that build for ${TARGET}. Crates marked "build time" only run`,
    "while Weft is compiled (build scripts, code generators, procedural macros and what they use); they are",
    "listed for completeness.",
    "",
    "Each licence text and notice these packages publish appears once, under its licence, followed by the",
    "packages that publish it. Packages that publish no licence file are listed after the texts, with the",
    "licence they declare.",
    "",
    "The opencode engine is not part of Weft. Weft downloads the official opencode-windows-x64 package from",
    "registry.npmjs.org when it first runs, and that package carries its own licence.",
    "",
    "This file is generated by tools/notices.mjs. Run `node tools/notices.mjs` again after changing",
    "dependencies.",
    "",
    `${npm.length} npm packages, ${crates.length} Rust crates (${buildOnly} of them build time).`,
    "",
    "Declared licences:",
    ...tally(all.map((pkg) => pkg.license)).map(([license, count]) => `  ${String(count).padStart(4)}  ${license}`),
  ]
  const heading = (title) => out.push("", "", RULE, title, RULE)

  heading(`npm packages (${npm.length})`)
  out.push("", ...indexLines(npm))
  heading(`Rust crates (${crates.length})`)
  out.push("", ...indexLines(crates))

  const rank = (kind) => (kind === NOTICE_KIND ? 1 : kind === OTHER_KIND ? 2 : 0)
  const usersOf = (texts) => new Set([...texts.values()].flatMap((entry) => [...entry.users])).size
  const kinds = [...groupTexts(all)].sort(
    ([a, textsA], [b, textsB]) => rank(a) - rank(b) || usersOf(textsB) - usersOf(textsA) || a.localeCompare(b),
  )
  for (const [kind, texts] of kinds) {
    const count = usersOf(texts)
    heading(`${kind}: ${texts.size} ${texts.size === 1 ? "text" : "texts"}, ${count} ${count === 1 ? "package" : "packages"}`)
    const firstUser = (entry) => [...entry.users].sort()[0]
    const entries = [...texts.values()].sort((a, b) => b.users.size - a.users.size || firstUser(a).localeCompare(firstUser(b)))
    for (const { text, users } of entries) out.push("", THIN_RULE, ...wrapList("Used by", [...users].sort()), THIN_RULE, "", text)
  }

  const withoutFile = all.filter((pkg) => !pkg.texts.length)
  if (withoutFile.length) {
    heading(`Packages that publish no licence file (${withoutFile.length})`)
    out.push(
      "",
      "These packages declare a licence in their manifest but ship no licence text. Where another package",
      "publishes the same licence, its text is in the section of that name above. The copyright belongs to",
      "the authors named here.",
    )
    for (const pkg of withoutFile) {
      out.push("", `  ${pkg.label}`, `    Licence: ${pkg.license}`)
      if (pkg.authors.length) out.push(...wrapList("    Authors:", pkg.authors, "      "))
      if (pkg.home) out.push(`    Home: ${pkg.home}`)
    }
  }

  const copyleft = all.filter((pkg) => COPYLEFT.test(pkg.license))
  if (copyleft.length) {
    heading(`Source code of the copyleft-licensed packages (${copyleft.length})`)
    out.push("", "Weft uses these packages unmodified. Their source code is available here:", "")
    out.push(...copyleft.map((pkg) => `  ${pkg.label} (${pkg.license}): ${pkg.source}`))
  }
  return `${out.join("\n")}\n`
}

const npm = npmPackages()
const crates = cratePackages()
const text = render(npm, crates)
writeFileSync(OUT, text)

for (const note of notes) console.warn(`note: ${note}`)
for (const problem of missing) console.error(`missing: ${problem}`)
const unrecognised = [...groupTexts([...npm, ...crates]).get(OTHER_KIND)?.values() ?? []].length
console.log(
  `wrote ${relative(ROOT, OUT)}: ${npm.length} npm packages, ` +
    `${crates.length} crates (${crates.filter((pkg) => pkg.buildOnly).length} build time), ` +
    `${unrecognised} unclassified texts, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`,
)
process.exitCode = missing.length ? 1 : 0
