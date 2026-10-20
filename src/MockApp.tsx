// The design harness: the whole app driven by src/mock/loom.ts instead of an engine (?mock).
// Flags: still (no streaming), top, edit=N, cloth, empty, boot (boot=hold keeps it starting),
// workbench=review|terminal|suggest (q=prompt text for suggest).
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Part, TextPart } from "@opencode-ai/sdk/v2/types"
import { Boot, type BootPhase } from "./art/Boot"
import { History } from "./art/History"
import { SessionHead } from "./art/SessionHead"
import { Water } from "./art/Water"
import { latestReply } from "./engine/speed"
import { partText, type LoomView, type PickView } from "./engine/view"
import { mockLoom } from "./mock/loom"
import { MOCK_SESSION, MockWeftProvider } from "./mock/weft"
import { benchWeft, typeIntoPrompt, type Bench } from "./mock/workbench"
import { Cloth } from "./ui/Cloth"
import { DraftPanel } from "./ui/DraftPanel"
import { EmptyLoom } from "./ui/EmptyLoom"
import { Fell } from "./ui/Fell"
import type { PickActions } from "./ui/Pick"
import { Review } from "./ui/Review"
import { SwatchBook } from "./ui/SwatchBook"
import { Terminal } from "./ui/Terminal"
import { Titlebar } from "./ui/Titlebar"

const STREAM_TAIL =
  "\n\nOnce you allow it, I'll delete `dist/`, re-run the build five times in a row, and push the workflow change so CI picks up the sequential steps."

export function MockApp() {
  const params = new URLSearchParams(location.search)
  const bench = params.get("workbench") as Bench | null
  return bench ? (
    <MockWeftProvider weft={benchWeft(bench)}>
      <MockLoom bench={bench} />
    </MockWeftProvider>
  ) : (
    <MockLoom />
  )
}

function MockLoom(props: { bench?: Bench }) {
  const params = new URLSearchParams(location.search)
  const [loom, setLoom] = createStore<LoomView>(structuredClone(mockLoom))
  if (params.has("empty")) setLoom("picks", [])
  const [bookOpen, setBookOpen] = createSignal(true)
  const [draftOpen, setDraftOpen] = createSignal(true)
  const [clothOpen, setClothOpen] = createSignal(params.has("cloth"))
  const [boot, setBoot] = createSignal<{ phase: BootPhase; progress: number } | undefined>(
    params.has("boot") ? { phase: "resolving", progress: 0 } : undefined,
  )
  if (params.has("boot")) {
    const hold = params.get("boot") === "hold"
    let p = 0
    const timer = window.setInterval(() => {
      p += 0.07
      if (p < 1) setBoot({ phase: "installing", progress: p })
      else if (p < 1.3 || hold) setBoot({ phase: "starting", progress: 1 })
      else {
        setBoot({ phase: "ready", progress: 1 })
        window.clearInterval(timer)
      }
    }, 120)
  }

  const [column, setColumn] = createSignal<HTMLElement>()
  const active = createMemo(() => loom.sessions.find((s) => s.session.id === loom.activeID))
  const live = () => loom.picks.some((p) => p.live)
  // Mock parts carry no stream times, so a finished mock reply keeps its live estimate.
  const reply = () => latestReply(loom.picks) ?? loom.picks.findLast((p) => p.info.role === "assistant")
  const todos = createMemo(() => {
    for (const pick of [...loom.picks].reverse())
      for (const part of pick.parts)
        if (part.type === "tool" && part.tool === "todowrite" && "metadata" in part.state)
          return ((part.state.metadata as { todos?: LoomView["todos"] })?.todos ?? []) as LoomView["todos"]
    return []
  })

  let streamTimer = 0
  onMount(() => {
    if (params.has("still")) return
    let i = 0
    streamTimer = window.setInterval(() => {
      if (i >= STREAM_TAIL.length) {
        window.clearInterval(streamTimer)
        setLoom("picks", (p) => !!p.live, "live", false)
        return
      }
      const chunk = STREAM_TAIL.slice(i, i + 3)
      i += 3
      setLoom(
        "picks",
        (p) => !!p.live,
        produce((pick: PickView) => {
          const last = [...pick.parts].reverse().find((x) => x.type === "text") as TextPart | undefined
          if (last) last.text += chunk
        }),
      )
    }, 45)
  })
  onCleanup(() => window.clearInterval(streamTimer))
  onMount(() => {
    if (props.bench === "suggest") typeIntoPrompt(params.get("q") ?? "move the copy step after the build: @cop")
  })

  const actions: PickActions = {
    save(pick, edit) {
      setLoom(
        "picks",
        (p) => p.id === pick.id,
        produce((p: PickView) => {
          p.mends = [...(p.mends ?? []), { text: partText(p.parts), role: p.role, at: Date.now() }]
          p.role = edit.role
          const part = (p.parts.find((x) => x.id === edit.partID) ?? p.parts.find((x) => x.type === "text")) as TextPart | undefined
          if (part) part.text = edit.text
          else p.parts.unshift({ id: `prt_${Date.now()}`, sessionID: p.info.sessionID, messageID: p.id, type: "text", text: edit.text } as Part)
        }),
      )
    },
    fork() {},
    remove(pick) {
      setLoom("picks", (ps) => ps.filter((p) => p.id !== pick.id))
    },
    setMuted(pick, muted) {
      setLoom("picks", (p) => p.id === pick.id, "muted", muted || undefined)
    },
  }

  function jumpTo(index: number) {
    setClothOpen(false)
    requestAnimationFrame(() =>
      document.querySelector(`article.pick[data-pick="${index}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    )
  }

  return (
    <div class="app" classList={{ "book-closed": !bookOpen(), "draft-closed": !draftOpen() }}>
      <Water column={column} />
      <Show when={boot()}>
        {(b) => (
          <Boot
            phase={b().phase}
            progress={b().progress}
            detail={b().phase === "installing" ? "opencode 1.19.1" : undefined}
            onDone={() => setBoot(undefined)}
          />
        )}
      </Show>
      <Titlebar
        title={active()?.session.title}
        directory={loom.directory}
        live={live()}
        bookOpen={bookOpen()}
        draftOpen={draftOpen()}
        clothOpen={clothOpen()}
        onBook={() => setBookOpen(!bookOpen())}
        onDraft={() => setDraftOpen(!draftOpen())}
        onCloth={() => setClothOpen(!clothOpen())}
      />
      <Show when={bookOpen()}>
        <SwatchBook loom={loom} onOpen={(id) => setLoom("activeID", id)} onNew={() => setLoom("picks", [])} onProject={() => {}} />
      </Show>
      <main class="loom">
        <Cloth
          picks={loom.picks}
          permission={loom.permission}
          root={loom.directory}
          actions={actions}
          busy={live()}
          onPermission={() => setLoom("permission", undefined)}
          empty={<EmptyLoom />}
          onColumn={setColumn}
          head={
            <Show when={active()}>
              {(a) => (
                <SessionHead
                  id={a().session.id}
                  title={a().session.title}
                  draft={a().draft}
                  created={a().session.time.created}
                  updated={a().session.time.updated}
                  model={loom.model.name ?? loom.model.modelID}
                />
              )}
            </Show>
          }
        >
          <Fell
            context={loom.context}
            agent={loom.agent}
            agents={["build", "plan"]}
            model={loom.model}
            busy={live()}
            reply={reply()}
            attachments={[{ id: "a1", name: "ci-run-4127.log", detail: "14 KB" }]}
            onAgent={(a) => setLoom("agent", a)}
            onModel={() => {}}
            onSend={() => {}}
            onStop={() => setLoom("picks", (p) => !!p.live, "live", false)}
            onAttach={() => {}}
            onDetach={() => {}}
          />
        </Cloth>
        <Show when={props.bench === "review"}>
          <Review sessionID={MOCK_SESSION} onClose={() => {}} />
        </Show>
        <Show when={props.bench === "terminal"}>
          <Terminal onClose={() => {}} />
        </Show>
        <Show when={clothOpen()}>
          <History picks={loom.picks} title={active()?.session.title} onClose={() => setClothOpen(false)} onJump={jumpTo} />
        </Show>
      </main>
      <Show when={draftOpen()}>
        <DraftPanel loom={loom} todos={todos()} />
      </Show>
    </div>
  )
}
