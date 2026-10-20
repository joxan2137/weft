import type { Provider, ProviderAuthMethod } from "@opencode-ai/sdk/v2/types"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { HttpError, type OAuthStart } from "../../engine/contract"
import { useWeft } from "../../engine/context"
import { IconCheck, IconCopy, IconOpen } from "../icons"
import { copyText, openExternal } from "../platform"
import { POPULAR, best, fuzzy, sortProviders, usableModels } from "./catalog"
import { Dialog, useDialog } from "./Dialog"
import { createCursor, KeyHints, Marked, Query } from "./list"
import { toast, toastError } from "./Toast"

type Prompt = NonNullable<ProviderAuthMethod["prompts"]>[number]

type Method = { index: number; type: "api" | "oauth"; label: string; prompts: Prompt[] }

type Flow =
  | { step: "idle" }
  | { step: "busy" }
  | { step: "code"; auth: OAuthStart }
  | { step: "waiting"; auth: OAuthStart }
  | { step: "error"; message: string }

const ZEN_URL = "https://opencode.ai/zen"

function methodsOf(auth: ProviderAuthMethod[] | undefined): Method[] {
  if (!auth?.length) return [{ index: -1, type: "api", label: "API key", prompts: [] }]
  return auth.map((m, index) => ({ index, type: m.type, label: m.label, prompts: m.prompts ?? [] }))
}

function visible(prompt: Prompt, inputs: Record<string, string>) {
  if (!prompt.when) return true
  const value = inputs[prompt.when.key] ?? ""
  return prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function idDiffersFromName(provider: Provider) {
  const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")
  return letters(provider.id) !== letters(provider.name)
}

/**
 * Browser sign-ins that listen on a fixed local port. When the port is taken the engine answers a bare 500, and its
 * plugin keeps the dead listener, so a retry hangs until the engine restarts.
 */
const SIGN_IN_PORTS: Record<string, number> = { openai: 1455, digitalocean: 1456 }

function startFailure(providerID: string, methodIndex: number, error: unknown) {
  const port = SIGN_IN_PORTS[providerID]
  if (port && methodIndex === 0 && error instanceof HttpError && error.status === 500)
    return `The browser sign-in could not listen on port ${port}; another app, such as OpenCode Desktop, may be signing in. Use another sign-in method, or let that sign-in finish, restart the engine and try again.`
  return message(error)
}

type ConnectProps = { providerID?: string; onClose: () => void }

/** Every provider the engine knows, searchable, beside the chosen one's own sign-in methods (API key, OAuth) and disconnect. */
export function Connect(props: ConnectProps) {
  return (
    <Dialog onClose={props.onClose} title="Providers" tint="teal" width={900} class="connect">
      <ConnectBody {...props} />
    </Dialog>
  )
}

function ConnectBody(props: ConnectProps) {
  const { state } = useWeft()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const connected = () => new Set(state.providers.connected)

  const groups = createMemo(() => {
    const q = query().trim()
    const sorted = sortProviders(state.providers.all, state.providers.connected)
    const matched = sorted
      .map((p) => {
        const m = best(fuzzy(q, p.name), fuzzy(q, p.id))
        return { provider: p, hits: fuzzy(q, p.name)?.hits, score: m?.score }
      })
      .filter((x) => x.score !== undefined)
    if (q) matched.sort((a, b) => b.score! - a.score!)
    const label = (p: Provider) =>
      q ? "Matches" : connected().has(p.id) ? "Connected" : POPULAR.includes(p.id) ? "Popular" : "All providers"
    const out: { label: string; items: { provider: Provider; hits?: number[]; index: number }[] }[] = []
    matched.forEach((x, index) => {
      const name = label(x.provider)
      const last = out[out.length - 1]
      const item = { provider: x.provider, hits: x.hits, index }
      if (last?.label === name) last.items.push(item)
      else out.push({ label: name, items: [item] })
    })
    return out
  })
  const flat = createMemo(() => groups().flatMap((g) => g.items))
  const nav = createCursor(() => flat().length)
  const [selectedID, setSelectedID] = createSignal(props.providerID ?? state.providers.connected[0] ?? "opencode")

  createEffect(
    on([query, flat], ([q, list], previous) => {
      const searched = previous !== undefined && previous[0] !== q
      nav.setCursor(searched ? 0 : Math.max(0, list.findIndex((x) => x.provider.id === selectedID())))
      if (searched && list[0]) setSelectedID(list[0].provider.id)
    }),
  )
  createEffect(on(nav.cursor, (i) => flat()[i] && setSelectedID(flat()[i].provider.id), { defer: true }))

  const selected = createMemo(() => state.providers.all.find((p) => p.id === selectedID()))

  return (
    <>
      <div class="dlg-split">
        <div class="dlg-pane">
          <Query
            label="Search providers"
            placeholder="Search providers"
            value={query()}
            onInput={setQuery}
            onKeyDown={(e) => nav.onKey(e, () => document.querySelector<HTMLElement>(".connect [data-flow-start]")?.focus())}
            count={`${flat().length} of ${state.providers.all.length}`}
          />
          <div class="dlg-list" ref={nav.bind} role="listbox" aria-label="Providers">
            <For each={groups()}>
              {(group) => (
                <section class="dlg-group">
                  <h3 class="dlg-group-title">{group.label}</h3>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        class="dlg-row provider-row"
                        data-index={item.index}
                        role="option"
                        aria-selected={item.provider.id === selectedID()}
                        classList={{ on: item.provider.id === selectedID(), current: connected().has(item.provider.id) }}
                        onClick={() => nav.setCursor(item.index)}
                      >
                        <span class="row-icon" title={connected().has(item.provider.id) ? "Connected" : undefined}>
                          <Show when={connected().has(item.provider.id)}>
                            <IconCheck size={16} />
                          </Show>
                        </span>
                        <span class="row-title">
                          <Marked text={item.provider.name} hits={item.hits} />
                        </span>
                        <Show when={idDiffersFromName(item.provider)}>
                          <span class="row-sub">{item.provider.id}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </section>
              )}
            </For>
            <Show when={!flat().length}>
              <p class="dlg-empty">No provider matches “{query().trim()}”</p>
            </Show>
          </div>
        </div>
        <Show when={selected() && selectedID()} keyed fallback={<div class="dlg-detail" />}>
          {(_id) => <ProviderDetail provider={selected()!} />}
        </Show>
      </div>
      <footer class="dialog-foot">
        <KeyHints
          keys={[
            ["↑↓", "Provider"],
            ["↵", "Sign in"],
          ]}
        />
        <span class="foot-note">No Claude Pro/Max sign-in: an Anthropic API key works.</span>
        <span class="spacer" />
        <button class="btn ghost" onClick={dialog.close}>
          Done
        </button>
      </footer>
    </>
  )
}

function ProviderDetail(props: { provider: Provider }) {
  const { state, actions } = useWeft()
  const id = () => props.provider.id
  const isConnected = () => state.providers.connected.includes(id())
  const methods = createMemo(() => methodsOf(state.providers.auth[id()]))
  const [methodAt, setMethodAt] = createSignal(0)
  const method = () => methods()[methodAt()] ?? methods()[0]
  const [flow, setFlow] = createSignal<Flow>({ step: "idle" })
  const [key, setKey] = createSignal("")
  const [code, setCode] = createSignal("")
  const [inputs, setInputs] = createSignal<Record<string, string>>({})
  let attempt = 0
  onCleanup(() => attempt++)

  const reset = () => {
    attempt++
    setFlow({ step: "idle" })
    setKey("")
    setCode("")
  }
  createEffect(on(methodAt, reset, { defer: true }))

  /** The engine reloads for new credentials only once no reply is running (actions.ts `reloadForCredentials`). */
  const replying = () => Object.values(state.status).some((status) => status.type !== "idle")
  const UNTIL_IDLE = "Its models arrive once the running replies finish."

  const succeeded = (waited: boolean) => {
    reset()
    toast(`${props.provider.name} connected.${waited ? ` ${UNTIL_IDLE}` : ""}`, "success")
  }

  async function run(work: () => Promise<void>) {
    const mine = ++attempt
    setFlow({ step: "busy" })
    try {
      const waited = replying()
      await work()
      if (mine === attempt) succeeded(waited)
    } catch (error) {
      if (mine === attempt) setFlow({ step: "error", message: message(error) })
    }
  }

  /** Answers to the method's visible prompts; an API key method stores them with the key (an account id, a resource name). */
  const answers = () => Object.fromEntries(method().prompts.filter((p) => visible(p, inputs())).map((p) => [p.key, inputs()[p.key] ?? ""]))

  function submitKey(event: Event) {
    event.preventDefault()
    const value = key().trim()
    if (!value) return setFlow({ step: "error", message: "Enter an API key first." })
    const metadata = answers()
    void run(() => actions.connectKey(id(), value, Object.keys(metadata).length ? metadata : undefined))
  }

  async function startOAuth(event: Event) {
    event.preventDefault()
    const m = method()
    const mine = ++attempt
    let started = false
    setFlow({ step: "busy" })
    try {
      const auth = await actions.oauthStart(id(), m.index, answers())
      started = true
      if (mine !== attempt) return
      if (!auth) return setFlow({ step: "error", message: "This method has no browser step. Use an API key instead." })
      void openExternal(auth.url).catch(() => undefined)
      if (auth.method === "code") return setFlow({ step: "code", auth })
      setFlow({ step: "waiting", auth })
      await actions.oauthFinish(id(), m.index)
      if (mine === attempt) succeeded(replying())
    } catch (error) {
      if (mine === attempt) setFlow({ step: "error", message: started ? message(error) : startFailure(id(), m.index, error) })
    }
  }

  function finishCode(event: Event) {
    event.preventDefault()
    const value = code().trim()
    if (!value) return
    void run(() => actions.oauthFinish(id(), method().index, value))
  }

  async function disconnect() {
    try {
      const waited = replying()
      await actions.disconnect(id())
      toast(`${props.provider.name} disconnected.${waited ? " Replies already running finish first." : ""}`, "info")
    } catch (error) {
      toast(message(error), "error")
    }
  }

  const models = () => usableModels(props.provider)
  const freeModels = () => models().filter((m) => m.cost.input === 0 && m.cost.output === 0).length
  const busy = () => flow().step === "busy"

  return (
    <aside class="dlg-detail provider-detail">
      <p class="detail-eyebrow">
        <span class="mono">{props.provider.id}</span>
        <Show when={isConnected()}>
          <span class="tag connected-word">Connected</span>
        </Show>
      </p>
      <p class="detail-title">{props.provider.name}</p>
      <p class="detail-text dim">
        {models().length} {models().length === 1 ? "model" : "models"}
        <Show when={freeModels()}> · {freeModels()} free</Show>
        <Show when={props.provider.env.length}>
          {" "}
          · also reads <span class="mono">{props.provider.env.join(", ")}</span>
        </Show>
      </p>

      <Switch>
        <Match when={id() === "opencode"}>
          <p class="dlg-note">
            OpenCode Zen is the opencode team's model gateway. Its free models work without a key. A key from{" "}
            <button class="link" onClick={() => openExternal(ZEN_URL)}>
              opencode.ai/zen
            </button>{" "}
            unlocks the paid ones, and the same key also connects OpenCode Go.
          </p>
        </Match>
        <Match when={id() === "opencode-go"}>
          <p class="dlg-note">
            OpenCode Go is a low-cost subscription from the opencode team. Connect it with the same key you use for Zen, from{" "}
            <button class="link" onClick={() => openExternal(ZEN_URL)}>
              opencode.ai/zen
            </button>
            .
          </p>
        </Match>
        <Match when={id() === "anthropic"}>
          <p class="dlg-note warn">Claude Pro/Max subscription sign-in is not offered. Use an API key from the Anthropic Console.</p>
        </Match>
      </Switch>

      <Show when={isConnected()}>
        <div class="connected-box">
          <span class="dot ready" />
          <span class="connected-state">
            Connected
            <Show when={props.provider.source === "env"}> from the environment</Show>
            <Show when={props.provider.source === "config"}> by config</Show>
          </span>
          <span class="spacer" />
          <Show when={props.provider.source === "api" || props.provider.source === "custom"}>
            <button class="btn danger" onClick={disconnect} title="Removes the stored key or sign-in">
              Disconnect
            </button>
          </Show>
        </div>
      </Show>

      <Show when={methods().length > 1}>
        <div class="dlg-field">
          <span class="field-label">Sign-in method</span>
          <div class="method-list" role="radiogroup" aria-label="Sign-in method">
            <For each={methods()}>
              {(m, i) => (
                <button
                  class="method"
                  role="radio"
                  aria-checked={methodAt() === i()}
                  classList={{ on: methodAt() === i() }}
                  onClick={() => setMethodAt(i())}
                  disabled={busy()}
                >
                  <span class="method-label">{m.label}</span>
                  <span class="method-kind">{m.type === "api" ? "Key" : "Browser"}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Switch>
        <Match when={flow().step === "code" && (flow() as { auth: OAuthStart }).auth}>
          {(auth) => (
            <form class="flow" onSubmit={finishCode}>
              <AuthLink auth={auth()} />
              <label class="dlg-field">
                <span class="field-label">Code</span>
                <input
                  class="dlg-input mono"
                  value={code()}
                  onInput={(e) => setCode(e.currentTarget.value)}
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="Paste the code from the browser"
                />
              </label>
              <div class="flow-actions">
                <button type="button" class="btn ghost" onClick={reset}>
                  Cancel
                </button>
                <button class="btn primary" disabled={!code().trim()}>
                  Finish <kbd>↵</kbd>
                </button>
              </div>
            </form>
          )}
        </Match>
        <Match when={flow().step === "waiting" && (flow() as { auth: OAuthStart }).auth}>
          {(auth) => (
            <div class="flow">
              <AuthLink auth={auth()} />
              <div class="flow-waiting">
                <span class="spinner" aria-hidden="true" />
                <span>Waiting for the browser to finish…</span>
                <span class="spacer" />
                <button class="btn ghost" onClick={reset}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Match>
        <Match when={method().type === "api"}>
          <form class="flow" onSubmit={submitKey}>
            <Prompts prompts={method().prompts} inputs={inputs()} onInput={setInputs} />
            <label class="dlg-field">
              <span class="field-label">API key</span>
              <input
                data-flow-start
                class="dlg-input mono key-input"
                type="password"
                value={key()}
                onInput={(e) => setKey(e.currentTarget.value)}
                autocomplete="off"
                spellcheck={false}
                placeholder={isConnected() ? "Paste a new key to replace the stored one" : "Paste your API key"}
                disabled={busy()}
                aria-label={`${props.provider.name} API key`}
              />
            </label>
            <div class="flow-actions">
              <span class="flow-hint">Stored by the engine in its auth file; never shown again.</span>
              <button class="btn primary" disabled={busy() || !key().trim()}>
                {busy() ? "Connecting…" : isConnected() ? "Replace key" : "Connect"} <kbd>↵</kbd>
              </button>
            </div>
          </form>
        </Match>
        <Match when={method().type === "oauth"}>
          <form class="flow" onSubmit={startOAuth}>
            <Prompts prompts={method().prompts} inputs={inputs()} onInput={setInputs} />
            <div class="flow-actions">
              <span class="flow-hint">Opens {props.provider.name}'s sign-in page in your browser.</span>
              <button data-flow-start class="btn primary" disabled={busy()}>
                {busy() ? "Starting…" : "Continue"} <kbd>↵</kbd>
              </button>
            </div>
          </form>
        </Match>
      </Switch>

      <Show when={flow().step === "error" && (flow() as { message: string }).message}>
        {(text) => <p class="dlg-error">{text()}</p>}
      </Show>
    </aside>
  )
}

/** The questions a sign-in method asks before it starts, in the engine's order; `when` hides the ones that do not apply. */
function Prompts(props: { prompts: Prompt[]; inputs: Record<string, string>; onInput: (inputs: Record<string, string>) => void }) {
  const answer = (key: string, value: string) => props.onInput({ ...props.inputs, [key]: value })
  return (
    <For each={props.prompts.filter((p) => visible(p, props.inputs))}>
      {(prompt) => (
        <label class="dlg-field">
          <span class="field-label">{prompt.message}</span>
          <Show
            when={prompt.type === "select" && prompt}
            fallback={
              <input
                class="dlg-input"
                value={props.inputs[prompt.key] ?? ""}
                placeholder={(prompt as { placeholder?: string }).placeholder}
                onInput={(e) => answer(prompt.key, e.currentTarget.value)}
                spellcheck={false}
              />
            }
          >
            {(select) => (
              <span class="seg">
                <For each={(select() as Extract<Prompt, { type: "select" }>).options}>
                  {(o) => (
                    <button type="button" classList={{ on: props.inputs[prompt.key] === o.value }} title={o.hint} onClick={() => answer(prompt.key, o.value)}>
                      {o.label}
                    </button>
                  )}
                </For>
              </span>
            )}
          </Show>
        </label>
      )}
    </For>
  )
}

function AuthLink(props: { auth: OAuthStart }) {
  return (
    <div class="auth-link">
      <Show when={props.auth.instructions}>
        <p class="detail-text">{props.auth.instructions}</p>
      </Show>
      <div class="dlg-field">
        <span class="field-label">Sign-in link</span>
        <code class="url-box selectable">{props.auth.url}</code>
      </div>
      <div class="flow-actions">
        <button
          type="button"
          class="btn ghost"
          onClick={() =>
            copyText(props.auth.url).then(
              () => toast("Sign-in link copied", "success"),
              () => toast("The link could not be copied. Use Open in browser instead.", "warn"),
            )
          }
        >
          <IconCopy size={14} /> Copy link
        </button>
        <button type="button" class="btn" onClick={() => openExternal(props.auth.url).catch(toastError)}>
          <IconOpen size={14} /> Open in browser
        </button>
      </div>
    </div>
  )
}
