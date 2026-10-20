// Fails when package.json and src-tauri/Cargo.toml disagree on Weft's version (the app and installer read
// package.json; Cargo's version names the engine download's User-Agent).
// usage: node tools/check-version.mjs
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const npmVersion = JSON.parse(read("package.json")).version
const cargoVersion = read("src-tauri/Cargo.toml").match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m)?.[1]

if (npmVersion !== cargoVersion) {
  console.error(`package.json is ${npmVersion} but src-tauri/Cargo.toml is ${cargoVersion ?? "missing a version"}`)
  process.exit(1)
}
console.log(`version ${npmVersion}`)
