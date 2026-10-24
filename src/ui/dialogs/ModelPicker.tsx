import type { Model, Provider } from "@opencode-ai/sdk/v2/types"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useWeft } from "../../engine/context"
import { withOpenGateway } from "../../engine/opengateway"
import { IconCheck, IconCross, IconFile, IconImage, IconPlus, IconTool, IconWaves } from "../icons"
import {
  best,
  compactTokens,
  currentModel,
  findModel,
  fuzzy,
  isFree,
  literal,
  price,
  recentModels,
  rememberModel,
  sortProviders,
  usableModels,
  type ModelRef,
} from "./catalog"
import { openDialog } from "./controller"
import { Dialog, useDialog } from "./Dialog"
import { createCursor, KeyHints, Marked, Query } from "./list"

type ModelRow = { index: number; provider: Provider; model: Model; connected: boolean; hits?: number[] }
type Group = { key: string; label: string; connected: boolean; rows: ModelRow[] }

const MAX_OTHER_PROVIDERS = 6
const MAX_OTHER_MODELS = 4

type PickerProps = {
  sessionID?: string
  onClose: () => void
  onPick?: (ref: ModelRef) => void
  onConnect?: (providerID?: string) => void
}

/** What a model can do beyond plain text, each with the icon its row shows when it can. */
const CAPS = [
  { name: "Reasoning", icon: IconWaves, has: (m: Model) => m.capabilities.reasoning },
  { name: "Tools", icon: IconTool, has: (m: Model) => m.capabilities.toolcall },
  { name: "Images", icon: IconImage, has: (m: Model) => m.capabilities.input.image },
  { name: "PDF", icon: IconFile, has: (m: Model) => m.capabilities.input.pdf },
]

/** Model and effort for a session: connected providers' models, recent first; search reaches every provider. */
export function ModelPicker(props: PickerProps) {
  return (
    <Dialog onClose={props.onClose} name="Choose a model" tint="indigo" width={860} align="top" class="models">
      <ModelPickerBody {...props} />
    </Dialog>
  )
}

function ModelPickerBody(props: PickerProps) {
  const { state, actions } = useWeft()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const current = createMemo(() => currentModel(state, props.sessionID))
  const providers = createMemo(() => withOpenGateway(state.providers.all))
  const isCurrent = (row: ModelRow) => current()?.providerID === row.provider.id && current()?.modelID === row.model.id

  const groups = createMemo<Group[]>(() => {
    const q = query().trim()
    const connected = new Set(state.providers.connected)
    const out: Group[] = []
    let index = 0
    if (!q) {
      const recent = recentModels()
        .map((r) => findModel(state, r))
        .filter((x): x is NonNullable<typeof x> => !!x && connected.has(x.provider.id))
      if (recent.length)
        out.push({ key: "recent", label: "Recent", connected: true, rows: recent.map((x) => ({ index: index++, ...x, connected: true })) })
    }
    let others = 0
    for (const provider of sortProviders(providers(), state.providers.connected)) {
      const isConnected = connected.has(provider.id)
      if (!isConnected && (!q || others >= MAX_OTHER_PROVIDERS)) continue
      let found = usableModels(provider).map((model) => {
        const named = fuzzy(q, model.name)
        return { model, hits: named?.hits, score: best(named, literal(q, `${provider.id}/${model.id}`), literal(q, provider.name))?.score }
      })
      if (q) {
        found = found.filter((f) => f.score !== undefined).sort((a, b) => b.score! - a.score!)
        if (!isConnected) found = found.slice(0, MAX_OTHER_MODELS)
      }
      if (!found.length) continue
      if (!isConnected) others++
      out.push({
        key: provider.id,
        label: provider.name,
        connected: isConnected,
        rows: found.map((f) => ({ index: index++, provider, model: f.model, connected: isConnected, hits: f.hits })),
      })
    }
    return out
  })

  const rows = createMemo(() => groups().flatMap((g) => g.rows))
  const count = () => rows().length + 1
  const nav = createCursor(count, query)
  const focused = () => rows()[nav.cursor()]

  const startAt = rows().findIndex(isCurrent)
  if (startAt >= 0) nav.setCursor(startAt)

  const [variant, setVariant] = createSignal<string>()
  createEffect(
    on(focused, (row, previous) => {
      if (!row) return
      const names = Object.keys(row.model.variants ?? {})
      if (isCurrent(row)) setVariant(current()?.variant)
      else if (previous && variant() && names.includes(variant()!)) return
      else setVariant(undefined)
    }),
  )

  const connect = (providerID?: string) => (props.onConnect ? props.onConnect(providerID) : openDialog({ kind: "connect", providerID }))

  function choose(index: number) {
    const row = rows()[index]
    if (!row) return connect()
    if (!row.connected) return connect(row.provider.id)
    const ref: ModelRef = {
      providerID: row.provider.id,
      modelID: row.model.id,
      variant: row === focused() ? variant() : isCurrent(row) ? current()?.variant : undefined,
    }
    if (props.sessionID) actions.setModel(props.sessionID, ref.providerID, ref.modelID, ref.variant)
    else actions.setDraftModel?.(ref.providerID, ref.modelID, ref.variant)
    rememberModel(ref)
    props.onPick?.(ref)
    dialog.close()
  }

  const total = createMemo(() => providers().reduce((n, p) => n + usableModels(p).length, 0))

  return (
    <>
      <Query
        label="Search models and providers"
        placeholder="Search models and providers"
        value={query()}
        onInput={setQuery}
        onKeyDown={(e) => nav.onKey(e, choose)}
        count={`${rows().length} of ${total()}`}
      />
      <div class="dlg-split">
        <div class="dlg-list" ref={nav.bind} role="listbox" aria-label="Models">
          <For each={groups()}>
            {(group) => (
              <section class="dlg-group">
                <h3 class="dlg-group-title">
                  {group.label}
                  <Show when={!group.connected}>
                    <span class="tag group-note">Not connected</span>
                  </Show>
                </h3>
                <For each={group.rows}>
                  {(row) => (
                    <button
                      class="dlg-row model-row"
                      data-index={row.index}
                      role="option"
                      aria-selected={nav.cursor() === row.index}
                      classList={{ on: nav.cursor() === row.index, current: isCurrent(row), off: !row.connected }}
                      onMouseMove={() => nav.setCursor(row.index)}
                      onClick={() => choose(row.index)}
                    >
                      <span class="row-icon" title={isCurrent(row) ? "In use" : undefined}>
                        <Show when={isCurrent(row)}>
                          <IconCheck size={16} />
                        </Show>
                      </span>
                      <span class="row-title">
                        <Marked text={row.model.name} hits={row.hits} />
                      </span>
                      <span class="row-tags">
                        <Show when={isFree(row.model)}>
                          <span class="tag free">Free</span>
                        </Show>
                        <Show when={row.model.status === "alpha" || row.model.status === "beta"}>
                          <span class="tag">{row.model.status === "alpha" ? "Alpha" : "Beta"}</span>
                        </Show>
                        <span class="caps">
                          <For each={CAPS.filter((c) => c.has(row.model))}>
                            {(c) => (
                              <span title={c.name}>
                                <Dynamic component={c.icon} size={13} />
                              </span>
                            )}
                          </For>
                        </span>
                        <span class="num ctx" title="Context window">
                          {compactTokens(row.model.limit.context)}
                        </span>
                      </span>
                    </button>
                  )}
                </For>
              </section>
            )}
          </For>
          <button
            class="dlg-row connect-row"
            data-index={rows().length}
            classList={{ on: nav.cursor() === rows().length }}
            onMouseMove={() => nav.setCursor(rows().length)}
            onClick={() => connect()}
          >
            <span class="row-icon">
              <IconPlus size={16} />
            </span>
            <span class="row-title">Connect a provider</span>
            <span class="row-sub">
              {state.providers.connected.length} connected · {providers().length} available
            </span>
          </button>
        </div>
        <ModelDetail row={focused()} variant={variant()} onVariant={setVariant} onConnect={connect} />
      </div>
      <footer class="dialog-foot">
        <KeyHints
          keys={[
            ["↑↓", "Move"],
            ["↵", "Use"],
            ["Esc", "Close"],
          ]}
        />
        <span class="spacer" />
        <button class="btn ghost" onClick={dialog.close}>
          Cancel
        </button>
        <button class="btn primary" disabled={!focused()} onClick={() => choose(nav.cursor())}>
          {focused() && !focused()!.connected ? "Connect provider" : "Use model"} <kbd>↵</kbd>
        </button>
      </footer>
    </>
  )
}

function ModelDetail(props: {
  row?: ModelRow
  variant?: string
  onVariant: (variant: string | undefined) => void
  onConnect: (providerID?: string) => void
}) {
  return (
    <aside class="dlg-detail">
      <Show
        when={props.row}
        fallback={
          <>
            <p class="detail-eyebrow">Providers</p>
            <p class="detail-title">Connect a provider</p>
            <p class="detail-text">
              Add an API key or sign in to a provider to use its models. OpenCode Zen's free models work without a key.
            </p>
          </>
        }
      >
        {(row) => {
          const m = () => row().model
          const variants = () => Object.keys(m().variants ?? {})
          return (
            <>
              <p class="detail-eyebrow">{row().provider.name}</p>
              <p class="detail-title">{m().name}</p>
              <code class="detail-id">
                {row().provider.id}/{m().id}
              </code>
              <ul class="ledger detail-ledger">
                <li>
                  <span>Context</span>
                  <span class="num">{compactTokens(m().limit.context)}</span>
                </li>
                <li>
                  <span>Max output</span>
                  <span class="num">{compactTokens(m().limit.output)}</span>
                </li>
                <Show
                  when={!isFree(m())}
                  fallback={
                    <li>
                      <span>Cost</span>
                      <span class="num free-text">Free</span>
                    </li>
                  }
                >
                  <li>
                    <span>Input</span>
                    <span class="num">${price(m().cost.input)} / M</span>
                  </li>
                  <li>
                    <span>Output</span>
                    <span class="num">${price(m().cost.output)} / M</span>
                  </li>
                  <Show when={m().cost.cache.read}>
                    <li>
                      <span>Cache read</span>
                      <span class="num">${price(m().cost.cache.read)} / M</span>
                    </li>
                  </Show>
                </Show>
                <Show when={m().release_date}>
                  <li>
                    <span>Released</span>
                    <span class="num">{m().release_date}</span>
                  </li>
                </Show>
              </ul>
              <ul class="caps-list">
                <For each={CAPS}>
                  {(c) => (
                    <li classList={{ has: c.has(m()) }}>
                      <Show when={c.has(m())} fallback={<IconCross size={13} />}>
                        <IconCheck size={13} />
                      </Show>
                      {c.name}
                    </li>
                  )}
                </For>
              </ul>
              <Show when={variants().length}>
                <div class="detail-variants">
                  <p class="detail-eyebrow">Effort</p>
                  <div class="seg" role="radiogroup" aria-label="Effort">
                    <button role="radio" aria-checked={!props.variant} classList={{ on: !props.variant }} onClick={() => props.onVariant(undefined)}>
                      Default
                    </button>
                    <For each={variants()}>
                      {(v) => (
                        <button role="radio" aria-checked={props.variant === v} classList={{ on: props.variant === v }} onClick={() => props.onVariant(v)}>
                          {v}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
              <Show when={!row().connected}>
                <p class="dlg-note">
                  {row().provider.name} is not connected.{" "}
                  <button class="link" onClick={() => props.onConnect(row().provider.id)}>
                    Connect it
                  </button>{" "}
                  to use this model.
                </p>
              </Show>
            </>
          )
        }}
      </Show>
    </aside>
  )
}
