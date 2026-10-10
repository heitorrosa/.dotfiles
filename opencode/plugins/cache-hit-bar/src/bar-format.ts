import type { AssistantMessage, ProviderInfo, SessionSnapshot } from "./types.ts"
import {
  aggregateSubAgents,
  cacheHitRatio,
  compareAssistantMessages,
  isInteractiveAssistantMessage,
  perMessageHitPercent,
  toSubAgentSummary,
  withModelFallback,
} from "./stats.ts"
import { billingCost } from "./dynamic-pricing/context.ts"
import { resolveModelCost } from "./dynamic-pricing/lookup.ts"

export type BarChildInput = {
  id: string
  snap: SessionSnapshot
  messages?: readonly AssistantMessage[]
}

export type BarModel = {
  /** Latest per-request hit % UNION-wide (prime + subs latest billable turn), null when none exists yet. */
  reqHit: number | null
  /**
   * Previous billable request's hit % (latest interactive assistant message
   * before the current one with a measurable hit), null when fewer than two
   * exist. The per-request trend arrow compares reqHit against this.
   */
  prevReqHit?: number | null
  /** Prime-only session hit % (DB-level, prime session only). */
  sessionHit: number
  /** Null when there are no sub-agents. */
  subsHit: number | null
  subsCount: number
  /** NON-UNIFIED total: prime + children, each at its own rates. */
  costTotal: number
  /** Grand totals: prime + all children. */
  cacheReadTotal: number
  cacheWriteTotal: number
  /**
   * Σ per-session (uncached − cached) at each session's OWN rates; 0 when
   * rates don't resolve. uncached bills every input-equivalent token at the
   * input rate: ((input + cacheRead) · rIn + output · rOut) / 1e6.
   */
  savedTotal: number
  /** Grand (prime + subs) hit % — collapsed TOTAL in brackets. */
  totalHit: number
  /** Grand (prime + subs) total tokens — collapsed TOTAL TOKENS. */
  totalTokens: number
}

/**
 * One session's cost at ITS OWN rates; falls back to OpenCode's reported
 * cost when no rates match (never blend rates across sessions).
 */
export function pricedSessionCost(
  snap: SessionSnapshot,
  providers: ReadonlyArray<ProviderInfo>,
): number {
  const resolved = resolveModelCost(providers, snap.providerID, snap.model)
  if (!resolved) return snap.cost
  return billingCost(resolved.rates, snap.input, snap.output, snap.cacheRead, snap.cacheWrite)
}

export function computeBarModel(
  main: SessionSnapshot,
  mainMessages: readonly AssistantMessage[],
  kids: readonly BarChildInput[],
  providers: ReadonlyArray<ProviderInfo>,
): BarModel {
  const snap = withModelFallback(main, mainMessages)
  // Grand scope: latest billable turn across prime + all subs (union-wide).
  // Kids carry TUI-mirror tails (their latest turn is always in the mirror);
  // prime carries full history. No per-child full-history fetch: the "latest"
  // query only needs recent tails.
  const kidMessages = kids.flatMap((k) => k.messages ?? [])
  const ordered = [...mainMessages, ...kidMessages]
    .filter((msg) => msg.role === "assistant" && isInteractiveAssistantMessage(msg))
    .slice()
    .sort(compareAssistantMessages)
  const last = ordered[ordered.length - 1]
  // Previous billable request: latest measurable hit before `last` (history
  // source for the per-request trend arrow). Skips turns with no denominator.
  let prevReqHit: number | null = null
  for (let i = ordered.length - 2; i >= 0; i--) {
    const h = perMessageHitPercent(ordered[i])
    if (h !== null) {
      prevReqHit = h
      break
    }
  }
  const subSnaps = kids.map((k) => withModelFallback(k.snap, k.messages ?? []))
  const agg = aggregateSubAgents(kids.map((k, i) => toSubAgentSummary(k.id, subSnaps[i])))
  let costTotal = pricedSessionCost(snap, providers)
  let cacheReadTotal = snap.cacheRead
  let cacheWriteTotal = snap.cacheWrite
  let savedTotal = savedSessionCost(snap, providers)
  let inputTotal = snap.input
  let outputTotal = snap.output
  let reasoningTotal = snap.reasoning
  for (const sub of subSnaps) {
    costTotal += pricedSessionCost(sub, providers)
    cacheReadTotal += sub.cacheRead
    cacheWriteTotal += sub.cacheWrite
    savedTotal += savedSessionCost(sub, providers)
    inputTotal += sub.input
    outputTotal += sub.output
    reasoningTotal += sub.reasoning
  }
  return {
    reqHit: last ? perMessageHitPercent(last) : null,
    prevReqHit,
    sessionHit: cacheHitRatio(snap.cacheRead, snap.input) * 100,
    subsHit: kids.length > 0 ? cacheHitRatio(agg.cacheRead, agg.input) * 100 : null,
    subsCount: kids.length,
    costTotal,
    cacheReadTotal,
    cacheWriteTotal,
    savedTotal,
    totalHit: cacheHitRatio(cacheReadTotal, inputTotal) * 100,
    totalTokens: inputTotal + outputTotal + cacheReadTotal + cacheWriteTotal + reasoningTotal,
  }
}

/**
 * One session's saved-vs-uncached cost at ITS OWN rates (never blended):
 * uncached − billingCost, where uncached bills input + cacheRead at the input
 * rate. Null rates yield 0 (uncached price unknowable, never guess).
 */
export function savedSessionCost(
  snap: SessionSnapshot,
  providers: ReadonlyArray<ProviderInfo>,
): number {
  const resolved = resolveModelCost(providers, snap.providerID, snap.model, {
    contextTokens: snap.input + snap.cacheRead,
  })
  if (!resolved) return 0
  const r = resolved.rates
  const uncached = ((snap.input + snap.cacheRead) * r.input + snap.output * r.output) / 1_000_000
  return uncached - billingCost(r, snap.input, snap.output, snap.cacheRead, snap.cacheWrite)
}

/**
 * Strict trend glyph: d = cur - prev; d >= 0 renders "↑", d < 0 renders "↓".
 * No deadband, no flat glyph. Missing previous (first sighting) defaults to
 * "↑". Null cur never reaches here (pctTrend renders bare "--" with no glyph).
 */
export function trendGlyph(cur: number | null | undefined, prev?: number | null): string {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return "↑"
  return cur - prev >= 0 ? "↑" : "↓"
}

/**
 * Previous-turn values for the aggregate figures (session/subs/total), held
 * as per-host closure state in bar.tsx (one snapshot per session; first
 * sighting = all undefined, renders up). The per-request figure does NOT use
 * this — its previous comes from message history (BarModel.prevReqHit); an
 * explicit reqHit here overrides that (tests).
 */
export type TrendPrev = {
  reqHit?: number | null
  sessionHit?: number | null
  subsHit?: number | null
  totalHit?: number | null
}

/** Previous value for the per-request arrow: explicit override wins, else message history. */
function prevReqOf(m: BarModel, prev?: TrendPrev): number | null | undefined {
  if (prev?.reqHit !== undefined) return prev.reqHit
  return m.prevReqHit ?? undefined
}

/** Null value renders "--" with no glyph (blank/no-data state); else value + computed trend glyph. */
function pctTrend(v: number | null, prev?: number | null): string {
  if (v === null) return "--"
  return `${v.toFixed(1)}% ${trendGlyph(v, prev)}`
}

/** Collapsed composer-downbar row: TOTAL TOKENS · per-request hit + TOTAL (grand) in brackets + trailing bare · divider (no trailing space). No subs segment, no cost. */
export function formatBarLine(m: BarModel, prev?: TrendPrev): string {
  const req = pctTrend(m.reqHit, prevReqOf(m, prev))
  return `${formatTokens(m.totalTokens)} tok · cache hit ${req} (${m.totalHit.toFixed(1)}% ${trendGlyph(m.totalHit, prev?.totalHit)}) ·`
}

/** Compact token count: 9M / 370K / 999 (one decimal, ".0" stripped). */
export function formatTokens(v: number): string {
  const trim1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "")
  if (v >= 1_000_000) return `${trim1(v / 1_000_000)}M`
  if (v >= 1_000) return `${trim1(v / 1_000)}K`
  return `${v}`
}

/**
 * Dialog menu title-bar text: `Cache Hit` + grand-total context. The dialog
 * overlay (`ctx.ui.dialog.show/set`, opencode 2.0.22) takes no title prop and
 * built-in sheets render in-content header rows — the permission sheet's
 * `Cv({title: "Permission required"})` △+title header, the image viewer's
 * `Image X of Y … esc` space-between row — while the sibling
 * opencode-cache-hit panel uses a bold-`<b>`-in-`<text>` first row
 * (tui-panel/components.tsx TuiPanelTitle/TuiSection); zero built-in or
 * sibling usages of the box-border `title` prop exist. So the title lives as
 * the menu's first row (bold, via CacheStatusMenu `title`), reusing the bar's
 * `·` separator language instead of inventing a new one.
 */
export function formatMenuTitle(m: BarModel): string {
  return `Cache Hit (${m.totalHit.toFixed(1)}% · ${formatTokens(m.totalTokens)} tok)`
}

/**
 * Expanded click menu: per-request, session total, subs aggregate + count,
 * grand total, cache read/write, saved cost — groups separated by blank
 * breathing lines (the host component renders "" as a blank row). Labels are
 * padEnd-aligned so values form one column. Cost appears ONLY here.
 */
export function formatExpandedLines(m: BarModel, prev?: TrendPrev): string[] {
  const req = pctTrend(m.reqHit, prevReqOf(m, prev))
  const sess = pctTrend(m.sessionHit, prev?.sessionHit)
  const subs = pctTrend(m.subsHit, prev?.subsHit)
  const total = pctTrend(m.totalHit, prev?.totalHit)
  const label = (s: string) => s.padEnd(13, " ")
  // ponytail: provider reports implicit-only caching (write=0 on 12,676/12,677 turns DB-wide); keep n/a until upstream ever bills it
  const cacheWriteValue = m.cacheWriteTotal > 0 ? `${formatTokens(m.cacheWriteTotal)} tok` : "n/a (implicit)"
  return [
    `${label("req hit")}: ${req}`,
    `${label("session total")}: ${sess}`,
    "",
    `${label("subagents")}: ${m.subsHit === null ? "--" : subs} (${m.subsCount})`,
    "",
    `${label("total")}: ${formatTokens(m.totalTokens)} tok (${total})`,
    `${label("cache read")}: ${formatTokens(m.cacheReadTotal)} tok`,
    `${label("cache write")}: ${cacheWriteValue}`,
    "",
    `${label("saved cost")}: $${m.savedTotal.toFixed(2)}`,
  ]
}
