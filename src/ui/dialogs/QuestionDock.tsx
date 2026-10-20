import type { QuestionRequest } from "@opencode-ai/sdk/v2/types"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useWeft } from "../../engine/context"
import { IconCheck } from "../icons"
import { takeFocus } from "./layer"
import { toastError } from "./Toast"

/** The open session's pending question tool call, on a card above the composer: numbered choices and an answer of your own. */
export function QuestionDock(props: { sessionID: string }) {
  const { state } = useWeft()
  const pending = () => state.questions[props.sessionID] ?? []
  return (
    <Show when={pending()[0]?.id} keyed>
      {(id) => <Question request={pending().find((r) => r.id === id) ?? pending()[0]} waiting={pending().length - 1} />}
    </Show>
  )
}

function Question(props: { request: QuestionRequest; waiting: number }) {
  const { actions } = useWeft()
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as string[][],
    custom: [] as string[],
    customOn: [] as boolean[],
    sending: false,
  })
  let section!: HTMLElement
  const total = () => props.request.questions.length
  const question = createMemo(() => props.request.questions[store.tab])
  const multi = () => question()?.multiple === true
  const allowsCustom = () => question()?.custom !== false
  const picked = (label: string) => store.answers[store.tab]?.includes(label) ?? false
  const answered = (i: number) => (store.answers[i]?.length ?? 0) > 0
  const last = () => store.tab >= total() - 1
  const complete = () => props.request.questions.every((_, i) => answered(i))

  function pick(label: string) {
    const tab = store.tab
    if (!multi()) {
      setStore(produce((s) => {
        s.answers[tab] = [label]
        s.customOn[tab] = false
      }))
      return
    }
    const now = store.answers[tab] ?? []
    setStore("answers", tab, now.includes(label) ? now.filter((a) => a !== label) : [...now, label])
  }

  function writeCustom(text: string) {
    const tab = store.tab
    const previous = (store.custom[tab] ?? "").trim()
    const next = text.trim()
    setStore(produce((s) => {
      s.custom[tab] = text
      s.customOn[tab] = next.length > 0
      const kept = multi() ? (s.answers[tab] ?? []).filter((a) => a !== previous) : []
      s.answers[tab] = next ? [...kept, next] : kept
    }))
  }

  async function submit() {
    if (!complete() || store.sending) return
    setStore("sending", true)
    try {
      await actions.answerQuestion(props.request.sessionID, props.request.id, props.request.questions.map((_, i) => [...(store.answers[i] ?? [])]))
    } catch (error) {
      toastError(error)
      setStore("sending", false)
    }
  }

  async function dismiss() {
    setStore("sending", true)
    try {
      await actions.rejectQuestion(props.request.sessionID, props.request.id)
    } catch (error) {
      toastError(error)
      setStore("sending", false)
    }
  }

  const next = () => (last() ? submit() : setStore("tab", store.tab + 1))

  function onEnter(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    if (!(event.target as HTMLElement).closest("input")) return
    event.preventDefault()
    if (answered(store.tab)) next()
  }

  function onDigit(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey || store.sending) return
    if ((event.target as HTMLElement).closest("textarea, input, [contenteditable]")) return
    if (!/^[1-9]$/.test(event.key)) {
      if (event.key.length === 1 && !event.repeat) focus?.returnFocus()
      return
    }
    const at = Number(event.key) - 1
    const options = question()?.options ?? []
    if (at === options.length && allowsCustom()) {
      event.preventDefault()
      section.querySelector<HTMLInputElement>(".option-input")?.focus()
      return
    }
    const option = options[at]
    if (!option) return
    event.preventDefault()
    pick(option.label)
  }
  let focus: ReturnType<typeof takeFocus> | undefined
  // The card takes the focus when no field has it, so 1–9 answer it, and gives it back when answered.
  onMount(() => {
    window.addEventListener("keydown", onDigit)
    focus = takeFocus(section)
  })
  onCleanup(() => {
    window.removeEventListener("keydown", onDigit)
    focus?.release()
  })

  const choices = () => (question()?.options.length ?? 0) + (allowsCustom() ? 1 : 0)

  return (
    <section ref={section} class="question-dock" tabIndex={-1} data-role="assistant" role="group" aria-label="The assistant asks" onKeyDown={onEnter}>
      <div class="question-card rise">
        <header class="question-head">
          <span class="drop" aria-hidden="true" />
          <span class="question-word">Question</span>
          <Show when={total() > 1} fallback={<span class="question-header">{question()?.header}</span>}>
            <span class="question-tabs" role="tablist">
              <For each={props.request.questions}>
                {(q, i) => (
                  <button
                    class="question-tab"
                    role="tab"
                    aria-selected={store.tab === i()}
                    classList={{ on: store.tab === i(), answered: answered(i()) }}
                    onClick={() => setStore("tab", i())}
                  >
                    <Show when={answered(i())} fallback={<span class="tab-mark" />}>
                      <IconCheck size={12} />
                    </Show>
                    {q.header}
                  </button>
                )}
              </For>
            </span>
          </Show>
          <Show when={total() > 1 || props.waiting > 0}>
            <span class="num question-count">
              <Show when={total() > 1}>
                {store.tab + 1} of {total()}
              </Show>
              <Show when={total() > 1 && props.waiting > 0}> · </Show>
              <Show when={props.waiting > 0}>{props.waiting} more waiting</Show>
            </span>
          </Show>
        </header>
        <p class="question-text selectable">{question()?.question}</p>
        <div class="question-options" classList={{ multi: multi() }} role={multi() ? "group" : "radiogroup"}>
          <For each={question()?.options ?? []}>
            {(option, i) => (
              <button
                class="question-option"
                role={multi() ? "checkbox" : "radio"}
                aria-checked={picked(option.label)}
                classList={{ picked: picked(option.label) }}
                onClick={() => pick(option.label)}
                disabled={store.sending}
              >
                <span class="option-no num">
                  <Show when={picked(option.label)} fallback={i() + 1}>
                    <IconCheck size={12} />
                  </Show>
                </span>
                <span class="option-text">
                  <span class="option-label">{option.label}</span>
                  <Show when={option.description}>
                    <span class="option-desc">{option.description}</span>
                  </Show>
                </span>
              </button>
            )}
          </For>
          <Show when={allowsCustom()}>
            <label class="question-option custom" classList={{ picked: store.customOn[store.tab] === true }}>
              <span class="option-no num">
                <Show when={store.customOn[store.tab]} fallback={(question()?.options.length ?? 0) + 1}>
                  <IconCheck size={12} />
                </Show>
              </span>
              <input
                class="option-input"
                placeholder="Or answer in your own words"
                value={store.custom[store.tab] ?? ""}
                onInput={(e) => writeCustom(e.currentTarget.value)}
                disabled={store.sending}
                spellcheck={false}
              />
            </label>
          </Show>
        </div>
        <footer class="question-actions">
          <span class="question-hint">
            {multi() ? "Choose any" : "Choose one"}
            <Show when={choices() > 1}>
              {" "}
              · press <kbd>1</kbd>–<kbd>{Math.min(choices(), 9)}</kbd>
            </Show>
          </span>
          <span class="spacer" />
          <button class="btn ghost danger" onClick={dismiss} disabled={store.sending}>
            Dismiss
          </button>
          <Show when={store.tab > 0}>
            <button class="btn ghost" onClick={() => setStore("tab", store.tab - 1)}>
              Back
            </button>
          </Show>
          <button class="btn primary" onClick={next} disabled={store.sending || (last() ? !complete() : !answered(store.tab))}>
            {last() ? (store.sending ? "Sending…" : "Submit") : "Next"} <kbd>↵</kbd>
          </button>
        </footer>
      </div>
    </section>
  )
}
