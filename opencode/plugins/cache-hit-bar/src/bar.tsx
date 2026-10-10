/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, untrack } from "solid-js"
import { createChildSessionSync } from "./child-session-sync.ts"
import { loadSessionMessages } from "./session-messages.ts"
import {
  aggregateFromSessionObject,
  aggregateSessionFromMessages,
  emptySessionSnapshot,
  withModelFallback,
} from "./stats.ts"
import type { AssistantMessage, OpenCodeTuiApi } from "./types.ts"
import type { V2Dialog } from "./v2/types.ts"
import { computeBarModel, formatBarLine, formatExpandedLines, formatMenuTitle, type BarChildInput, type TrendPrev } from "./bar-format.ts"

/** Click decision: open the menu, close it, or no-op (no dialog reachable). Pure for tests. */
export function nextMenuAction(menuOpen: boolean, hasDialog: boolean): "open" | "close" | "noop" {
  if (!hasDialog) return "noop"
  return menuOpen ? "close" : "open"
}

/**
 * Collapsed-row fg: hovered renders the base/white token (clickability
 * affordance, same `hovered() ? text.base : text.muted` as the built-in
 * `sidebar.footer.location` row), otherwise the muted gray. Missing base
 * (V1/older runtimes carry no base token) falls back to muted. Pure for tests.
 */
export function rowFg(hovered: boolean, muted: unknown, base: unknown): unknown {
  return hovered ? (base ?? muted) : muted
}

/** Menu body: title-bar first row (bold, sibling-panel language) + padded container with blank breathing rows between groups. Rendered in the dialog overlay, never inline. */
export function CacheStatusMenu(props: { lines: string[]; muted?: unknown; title?: string }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      {props.title ? (
        <>
          <text wrapMode="none">
            <b>{props.title}</b>
          </text>
          <text wrapMode="none">{" "}</text>
        </>
      ) : null}
      <For each={props.lines}>
        {(l) =>
          l === "" ? (
            <text wrapMode="none">{" "}</text>
          ) : (
            <text wrapMode="none" fg={props.muted as never}>
              {l}
            </text>
          )
        }
      </For>
    </box>
  )
}

/**
 * Session-scoped one-line status bar. Reads DB-level aggregates via
 * session.get() (falls back to the TUI message mirror), full history for the
 * per-request hit %, and session.list for direct children only.
 *
 * Click opens the cache-status MENU via ctx.ui.dialog (overlay layer, Esc to
 * dismiss); the footer row itself always stays one collapsed line.
 */
export function CacheHitBarHost(props: { sessionId: string; api: OpenCodeTuiApi; muted?: unknown; base?: unknown; dialog?: V2Dialog; hovered?: () => boolean; onMouseOver?: (ev?: unknown) => void; onMouseOut?: (ev?: unknown) => void }) {
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [childIds, setChildIds] = createSignal<string[]>([])
  const [historyMessages, setHistoryMessages] = createSignal<AssistantMessage[]>([])
  const [menuOpen, setMenuOpen] = createSignal(false)
  let historyLoadGeneration = 0

  const bumpRefresh = () => setRefreshTick((v) => v + 1)

  const childSync = createChildSessionSync({
    client: props.api.client.session,
    getDirectory: () => props.api.state.path.directory,
    getParentId: () => props.sessionId,
    setChildIds,
    onSynced: bumpRefresh,
  })
  onCleanup(() => childSync.dispose())

  const mirrorMessages = createMemo(() => {
    void refreshTick()
    const sid = props.sessionId
    if (!sid) return [] as AssistantMessage[]
    return (props.api.state.session.messages(sid) ?? []) as AssistantMessage[]
  })

  const mainSnap = createMemo(() => {
    void refreshTick()
    const sid = props.sessionId
    if (!sid) return emptySessionSnapshot()
    const session = props.api.state.session.get?.(sid)
    if (session) {
      const snap = aggregateFromSessionObject(session)
      const msgs = props.api.state.session.messages(sid) as AssistantMessage[] | undefined
      return msgs ? withModelFallback(snap, msgs) : snap
    }
    const msgs = props.api.state.session.messages(sid)
    return msgs?.length
      ? aggregateSessionFromMessages(msgs as AssistantMessage[])
      : emptySessionSnapshot()
  })

  const kids = createMemo((): BarChildInput[] => {
    void refreshTick()
    const out: BarChildInput[] = []
    for (const cid of childIds()) {
      // Mirror tails feed the union-wide latest billable turn (bar-format).
      // One cheap cache read per child; miss => [] (async sync fills, next tick corrects).
      const kidMsgs = (props.api.state.session.messages(cid) ?? []) as AssistantMessage[]
      const session = props.api.state.session.get?.(cid)
      if (session) {
        const snap = aggregateFromSessionObject(session)
        out.push({ id: cid, snap: kidMsgs.length ? withModelFallback(snap, kidMsgs) : snap, messages: kidMsgs })
        continue
      }
      if (kidMsgs.length) out.push({ id: cid, snap: aggregateSessionFromMessages(kidMsgs), messages: kidMsgs })
    }
    return out
  })

  const model = createMemo(() => {
    void refreshTick()
    const hist = historyMessages()
    return computeBarModel(
      mainSnap(),
      hist.length ? hist : untrack(mirrorMessages),
      kids(),
      props.api.state.provider ?? [],
    )
  })

  // Last-turn aggregate snapshot for the session/subs/total trend arrows.
  // Per-host closure state (one per session); first sighting renders up arrows.
  // The line memo reads it untracked so it lags exactly one turn (a tracked
  // read would flatten the arrow as soon as the snapshot catches up). The
  // per-request arrow needs no state: message history is its source.
  const [lastTurnPrev, setLastTurnPrev] = createSignal<TrendPrev | undefined>(undefined)
  const line = createMemo(() => formatBarLine(model(), untrack(lastTurnPrev)))
  createEffect(() => {
    const m = model()
    setLastTurnPrev({ sessionHit: m.sessionHit, subsHit: m.subsHit, totalHit: m.totalHit })
  })

  const toggleMenu = (ev?: { button?: number; stopPropagation?: () => void }) => {
    if (ev && typeof ev.button === "number" && ev.button !== 0) return
    ev?.stopPropagation?.()
    const dialog = props.dialog
    switch (nextMenuAction(menuOpen(), Boolean(dialog))) {
      case "open":
        setMenuOpen(true)
        dialog!.show(
          () => (
            <CacheStatusMenu
              title={formatMenuTitle(model())}
              lines={formatExpandedLines(model(), untrack(lastTurnPrev))}
              muted={props.muted}
            />
          ),
          () => setMenuOpen(false),
        )
        return
      case "close":
        setMenuOpen(false)
        dialog!.clear()
        return
      case "noop":
        return
    }
  }

  const loadHistory = (sid: string) => {
    const generation = ++historyLoadGeneration
    const mirror = untrack(mirrorMessages)
    setHistoryMessages(mirror)
    if (!sid) return
    void loadSessionMessages({
      client: props.api.client.session,
      sessionId: sid,
      directory: props.api.state.path.directory,
      fallback: mirror,
    }).then((result) => {
      if (generation !== historyLoadGeneration) return
      setHistoryMessages(result.messages)
    })
  }

  createEffect(() => {
    const sid = props.sessionId
    void props.api.state.path.directory
    childSync.resetForParentChange()
    loadHistory(sid)
    if (sid) childSync.loadChildren()
  })

  createEffect(() => {
    const unsub = props.api.event.on("message.updated", (event) => {
      bumpRefresh()
      const msg = event.properties?.info as (AssistantMessage & { sessionID?: string }) | undefined
      childSync.onForeignSessionActivity(msg?.sessionID)
      if (msg?.sessionID === props.sessionId && msg?.role === "assistant") {
        setHistoryMessages((messages) => {
          const id = msg.id ?? msg.messageID
          const next = [...messages]
          const index = id ? next.findIndex((m) => (m.id ?? m.messageID) === id) : -1
          if (index >= 0) next[index] = msg
          else next.push(msg)
          return next
        })
      }
    })
    onCleanup(() => unsub?.())
  })

  return (
    <text wrapMode="none" truncate fg={rowFg(props.hovered?.() ?? false, props.muted, props.base) as never} onMouseOver={props.onMouseOver as never} onMouseOut={props.onMouseOut as never} onMouseUp={toggleMenu}>
      {line()}
    </text>
  )
}
