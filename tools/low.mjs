// Runs a command at idle CPU priority (child processes inherit it) and passes its exit code through.
// usage: node tools/low.mjs <command> [args...]
import { spawnSync } from "node:child_process"
import { constants, setPriority } from "node:os"

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error("usage: node tools/low.mjs <command> [args...]")
  process.exit(2)
}

/** Quotes an argument for cmd.exe so spaces and & | < > ^ ( ) % ! survive. */
const quote = (arg) => (/[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

// Windows gives a new process this one's idle priority class, and Unix inherits the nice value.
setPriority(process.pid, constants.priority.PRIORITY_LOW)

const result =
  process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`], {
        stdio: "inherit",
        windowsVerbatimArguments: true,
      })
    : spawnSync(command, args, { stdio: "inherit" })
process.exit(result.status ?? 1)
