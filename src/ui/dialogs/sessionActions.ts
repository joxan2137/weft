import type { Session } from "@opencode-ai/sdk/v2/types"
import type { Actions } from "../../engine/contract"
import { copyText, openExternal, saveTextFile } from "../platform"
import { ask } from "./controller"
import { toast } from "./Toast"

/** Sharing uploads the whole conversation, file contents the agent read included, so it always asks first. */
export function confirmShare() {
  return ask({
    title: "Share this session publicly?",
    confirm: "Share",
    body: [
      "The whole conversation is uploaded to opencode's share service, including any code or file contents the agent read. Anyone with the link can read it.",
      "You can stop sharing later from the session menu.",
    ],
  })
}

/** Shows a new share link and copies it; the link stays readable in the toast if the clipboard refuses. */
export async function announceShared(url: string) {
  const copied = await copyText(url).then(
    () => true,
    () => false,
  )
  toast(`${copied ? "Share link copied" : "Shared at"}: ${url}`, "success", { label: "Open", run: () => void openExternal(url).catch(() => undefined) })
}

/** Shares after asking, or stops sharing at once. */
export async function toggleShare(actions: Actions, session: Session) {
  if (session.share) {
    await actions.shareSession(session.id, false)
    return toast("Sharing stopped")
  }
  if (!(await confirmShare())) return
  const url = await actions.shareSession(session.id, true)
  if (url) await announceShared(url)
}

/** Saves the session and all its messages as a JSON file the user places. */
export async function saveSessionFile(actions: Actions, session: Session) {
  const json = await actions.exportSession(session.id)
  if (await saveTextFile(`${session.slug || session.id}.json`, json)) toast("Session saved as JSON", "success")
}
