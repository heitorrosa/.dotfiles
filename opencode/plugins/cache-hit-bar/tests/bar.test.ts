import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { computeBarModel, formatBarLine, formatExpandedLines, formatMenuTitle, formatTokens, pricedSessionCost, savedSessionCost, trendGlyph } from "../src/bar-format.ts"
import { nextMenuAction, rowFg } from "../src/bar.tsx"
import type { AssistantMessage, SessionSnapshot } from "../src/types.ts"

const DB_PATH = `${process.env.USERPROFILE ?? "C:/Users/Administrator"}/.local/share/opencode/opencode.db`
const PRIME = "ses_efa2f67e2ffewDfMVX2Wbfarnl"
const LANE_CHILD = "ses_eec492240ffeWWmRdz0joNjnO6"

function rows() {
  let db: Database
  try {
    db = new Database(DB_PATH, { readonly: true })
  } catch {
    return null
  }
  try {
    const prime = db.query("SELECT * FROM session_v2 WHERE id = ?").get(PRIME) as Record<string, number> | null
    if (!prime) return null
    const kids = db.query("SELECT * FROM session_v2 WHERE parent_id = ?").all(PRIME) as Record<string, number>[]
    return { prime, kids }
  } catch {
    return null
  } finally {
    db.close()
  }
}

const snapOf = (r: Record<string, number>): SessionSnapshot => ({
  model: "muse-spark-1.3-contributor",
  providerID: "opencode-go",
  cost: r.cost,
  input: r.tokens_input,
  output: r.tokens_output,
  reasoning: r.tokens_reasoning,
  cacheRead: r.tokens_cache_read,
  cacheWrite: r.tokens_cache_write,
})

const close = (v: number, want: number, eps = 0.05) => expect(Math.abs(v - want)).toBeLessThan(eps)

describe("bar numbers vs DB ground truth", () => {
  test("prime + children match session_v2 aggregates", () => {
    const data = rows()
    if (!data) {
      console.warn("DB unavailable, skipping ground-truth check")
      return
    }
    expect(data.kids.length).toBeGreaterThan(50)
    // Independent expectation straight from the same rows (no shared helpers).
    let si = 0
    let sr = 0
    let sc = 0
    let so = 0
    let sw = 0
    let sreason = 0
    for (const k of data.kids) {
      si += k.tokens_input
      sr += k.tokens_cache_read
      sc += k.cost
      so += k.tokens_output
      sw += k.tokens_cache_write
      sreason += k.tokens_reasoning
    }
    const wantSess = (data.prime.tokens_cache_read / (data.prime.tokens_cache_read + data.prime.tokens_input)) * 100
    const wantSubs = (sr / (sr + si)) * 100
    const gi = data.prime.tokens_input + si
    const gr = data.prime.tokens_cache_read + sr
    const wantGrand = (gr / (gr + gi)) * 100
    const wantTokens =
      gi + gr + data.prime.tokens_output + so + data.prime.tokens_cache_write + sw + data.prime.tokens_reasoning + sreason
    const model = computeBarModel(snapOf(data.prime), [], data.kids.map((k) => ({ id: String(k.id), snap: snapOf(k) })), [])
    close(model.sessionHit, wantSess)
    close(model.subsHit ?? -1, wantSubs)
    expect(model.subsCount).toBe(data.kids.length)
    // providers=[] → every session falls back to OpenCode's reported cost.
    expect(Math.abs(model.costTotal - (data.prime.cost + sc))).toBeLessThan(1e-6)
    expect(model.reqHit).toBeNull()
    // Grand total vs DB (0.5pt tolerance for hit, exact for tokens).
    close(model.totalHit, wantGrand, 0.5)
    expect(model.totalTokens).toBe(wantTokens)
    const line = formatBarLine(model)
    // Collapsed: `TOTAL tok · cache hit REQ (TOTAL) ·` — trailing bare ·, no subs inline, no pipe.
    // (No previous turn supplied: first-sighting up arrows.)
    expect(line).toContain("tok · cache hit --")
    expect(line).toContain(`(${wantGrand.toFixed(1)}% ↑) ·`)
    expect(line.endsWith("·")).toBe(true)
    expect(line.endsWith("· ")).toBe(false)
    expect(line).not.toMatch(/\s$/)
    expect(line).not.toContain("subagents")
    expect(line).not.toContain("subs")
    expect(line).not.toContain("|")
    expect(line).not.toContain("$")
    expect(line).not.toContain("total)")
    expect(line).toMatch(/^\S+ tok · cache hit -- \(\d+\.\d+% ↑\) ·$/)
    expect(line.length).toBeLessThan(90)
  })

  test("single lane-impl child session", () => {
    const data = rows()
    if (!data) return
    const one = data.kids.find((k) => k.id === LANE_CHILD)
    expect(one).toBeDefined()
    const want = (one!.tokens_cache_read / (one!.tokens_cache_read + one!.tokens_input)) * 100
    const model = computeBarModel(snapOf(data.prime), [], [{ id: LANE_CHILD, snap: snapOf(one!) }], [])
    close(model.subsHit ?? -1, want)
    expect(Math.abs(model.costTotal - (data.prime.cost + one!.cost))).toBeLessThan(1e-9)
  })

  test("per-request hit from latest assistant message", () => {
    const msg = (input: number, read: number, created: number): AssistantMessage =>
      ({ id: `m${created}`, role: "assistant", created, tokens: { input, output: 1, reasoning: 0, cache: { read, write: 0 } } }) as AssistantMessage
    const data = rows()
    const primeSnap = data ? snapOf(data.prime) : snapOf({ cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0 })
    const model = computeBarModel(primeSnap, [msg(100, 100, 1), msg(100, 900, 2)], [], [])
    close(model.reqHit ?? -1, 90.0)
  })

  test("missing rates keep reported cost (no blending)", () => {
    const snap: SessionSnapshot = { model: "nope", providerID: "nope", cost: 0.42, input: 10, output: 1, reasoning: 0, cacheRead: 90, cacheWrite: 0 }
    expect(pricedSessionCost(snap, [])).toBe(0.42)
  })

  test("grand aggregation: prime+2 children where prime-only != grand, grand wins (incl union reqHit)", () => {
    const tmsg = (id: string, input: number, read: number, completed: number): AssistantMessage =>
      ({ id, role: "assistant", time: { created: completed, completed }, tokens: { input, output: 1, reasoning: 0, cache: { read, write: 0 } } }) as unknown as AssistantMessage
    // Prime alone: 0% hit (input 1000, read 0). Kid1: 90% (input 100, read 900).
    // Kid2: 50% (input 100, read 100). Grand: read 1000 / (1000 + 1200) = 45.5%.
    // Prime-only (0%) must NOT win.
    const primeSnap: SessionSnapshot = { model: "m", providerID: "p", cost: 0, input: 1000, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const kidSnap: SessionSnapshot = { model: "m", providerID: "p", cost: 0, input: 100, output: 10, reasoning: 0, cacheRead: 900, cacheWrite: 0 }
    // Union timeline: prime 0% @1, kid1 90% @2, kid2 50% @3 (latest).
    const primeMsgs = [tmsg("p1", 100, 0, 1)]
    const k1 = { id: "k1", snap: kidSnap, messages: [tmsg("k1m", 100, 900, 2)] }
    const k2snap: SessionSnapshot = { ...kidSnap, input: 100, cacheRead: 100 }
    const k2 = { id: "k2", snap: k2snap, messages: [tmsg("k2m", 100, 100, 3)] }
    const model = computeBarModel(primeSnap, primeMsgs, [k1, k2], [])
    // Tokens: grand = (1000+50+0) + (100+10+900) + (100+10+100) = 2270.
    expect(model.totalTokens).toBe(2270)
    // Total hit is grand over the same union (recompute grand with k2's own read).
    const wantGrand = (0 + 900 + 100) / ((0 + 900 + 100) + (1000 + 100 + 100)) * 100
    close(model.totalHit, wantGrand, 1e-9)
    expect(model.totalHit).not.toBeCloseTo(0.0, 6)
    // Per-request hit is union-wide latest billable turn: kid2's 50%, NOT prime's 0%.
    close(model.reqHit ?? -1, 50.0, 1e-9)
    close(model.prevReqHit ?? -1, 90.0, 1e-9)
    const line = formatBarLine(model)
    expect(line).toContain("cache hit 50.0%")
    expect(line).toContain(`(${wantGrand.toFixed(1)}%`)
    expect(line).toContain("·")
    expect(line.endsWith("·")).toBe(true)
    expect(line.endsWith("· ")).toBe(false)
    expect(line).not.toMatch(/\s$/)
    expect(line.length).toBeLessThan(90)
  })
})

describe("trend arrows (computed, never hardcoded)", () => {
  const msg = (input: number, read: number, created: number): AssistantMessage =>
    ({ id: `m${created}`, role: "assistant", created, tokens: { input, output: 1, reasoning: 0, cache: { read, write: 0 } } }) as AssistantMessage
  const snap: SessionSnapshot = { model: "m", providerID: "p", cost: 0, input: 1000, output: 50, reasoning: 0, cacheRead: 3000, cacheWrite: 0 }

  test("trendGlyph strict: rises up, falls down, flat and first-sighting up", () => {
    expect(trendGlyph(90, 80)).toBe("↑")
    expect(trendGlyph(80, 90)).toBe("↓")
    expect(trendGlyph(90, 90)).toBe("↑")
    expect(trendGlyph(90, 89.99)).toBe("↑")
    expect(trendGlyph(90, 90.01)).toBe("↓")
    expect(trendGlyph(null, 90)).toBe("↑")
    expect(trendGlyph(90, null)).toBe("↑")
    expect(trendGlyph(90, undefined)).toBe("↑")
    expect(trendGlyph(null, null)).toBe("↑")
  })

  test("per-request arrow follows message history (rising up, falling down, first sighting up)", () => {
    const rising = computeBarModel(snap, [msg(900, 100, 1), msg(100, 900, 2)], [], [])
    expect(rising.prevReqHit).toBeCloseTo(10.0, 6)
    expect(formatBarLine(rising)).toContain("cache hit 90.0% ↑")
    const falling = computeBarModel(snap, [msg(100, 900, 1), msg(900, 100, 2)], [], [])
    expect(formatBarLine(falling)).toContain("cache hit 10.0% ↓")
    const first = computeBarModel(snap, [msg(100, 900, 1)], [], [])
    expect(first.prevReqHit).toBeNull()
    expect(formatBarLine(first)).toContain("cache hit 90.0% ↑")
    expect(formatBarLine(first).endsWith("·")).toBe(true)
    expect(formatBarLine(first).endsWith("· ")).toBe(false)
    const none = computeBarModel(snap, [], [], [])
    expect(none.reqHit).toBeNull()
    expect(formatBarLine(none)).toContain("cache hit --")
    expect(formatBarLine(none)).not.toContain("-- ↑")
    expect(formatBarLine(none)).not.toContain("-- ↓")
  })

  test("aggregate arrows follow the last-turn snapshot (explicit prev)", () => {
    const model = computeBarModel(snap, [], [], [])
    const up = { sessionHit: model.sessionHit - 5, subsHit: null, totalHit: model.totalHit - 5, reqHit: undefined }
    const linesUp = formatExpandedLines(model, up)
    expect(linesUp[1]).toContain("↑")
    expect(linesUp[5]).toContain("↑")
    const down = { sessionHit: model.sessionHit + 5, totalHit: model.totalHit + 5 }
    expect(formatBarLine(model, down)).toContain("↓")
    const flat = { sessionHit: model.sessionHit, totalHit: model.totalHit }
    expect(formatBarLine(model, flat)).toContain("↑")
    expect(formatBarLine(model, flat)).not.toContain("↓")
    expect(formatBarLine(model, flat)).not.toContain("→")
  })

  test("menu title bar: Cache Hit + total context", () => {
    const model = computeBarModel(snap, [], [], [])
    const title = formatMenuTitle(model)
    expect(title).toContain("Cache Hit")
    expect(title).toContain(model.totalHit.toFixed(1))
    expect(title).toContain("tok")
    expect(title).toContain("·")
  })
})

describe("expanded menu (click opens dialog, never inline)", () => {
  test("grand totals vs DB ground truth (0.5pt tolerance)", () => {
    const data = rows()
    if (!data) {
      console.warn("DB unavailable, skipping ground-truth check")
      return
    }
    let read = data.prime.tokens_cache_read
    let write = data.prime.tokens_cache_write
    for (const k of data.kids) {
      read += k.tokens_cache_read
      write += k.tokens_cache_write
    }
    const model = computeBarModel(snapOf(data.prime), [], data.kids.map((k) => ({ id: String(k.id), snap: snapOf(k) })), [])
    expect(Math.abs(model.cacheReadTotal - read)).toBeLessThan(0.5)
    expect(Math.abs(model.cacheWriteTotal - write)).toBeLessThan(0.5)
    expect(model.subsCount).toBe(data.kids.length)
    // providers=[] → rates never resolve → saved 0, never guessed.
    expect(model.savedTotal).toBe(0)
    expect(savedSessionCost(snapOf(data.prime), [])).toBe(0)
  })

  test("saved-vs-uncached at own rates (synthetic, exact)", () => {
    const providers = [
      {
        id: "opencode-go",
        models: {
          "muse-spark-1.3-contributor": {
            cost: { input: 3, output: 15, cache: { read: 0.3, write: 3 } },
          },
        },
      },
    ]
    const snap: SessionSnapshot = {
      model: "muse-spark-1.3-contributor",
      providerID: "opencode-go",
      cost: 0,
      input: 1_000_000,
      output: 50_000,
      reasoning: 0,
      cacheRead: 9_000_000,
      cacheWrite: 100_000,
    }
    // uncached = (10M·3 + 50K·15)/1M = 30.75; cached = (1M·3+50K·15+9M·0.3+100K·3)/1M = 6.75.
    expect(savedSessionCost(snap, providers)).toBeCloseTo(24.0, 9)
    const model = computeBarModel(snap, [], [], providers)
    expect(model.savedTotal).toBeCloseTo(24.0, 9)
    expect(model.cacheReadTotal).toBe(9_000_000)
    expect(model.cacheWriteTotal).toBe(100_000)
  })

  test("expanded lines content; collapsed row still cost-free", () => {
    const model = {
      reqHit: 90.0,
      sessionHit: 90.0,
      subsHit: null,
      subsCount: 0,
      costTotal: 6.75,
      cacheReadTotal: 9_000_000,
      cacheWriteTotal: 100_000,
      savedTotal: 24.0,
      totalHit: 90.0,
      totalTokens: 10_150_000,
    }
    expect(formatExpandedLines(model)).toEqual([
      "req hit      : 90.0% ↑",
      "session total: 90.0% ↑",
      "",
      "subagents    : -- (0)",
      "",
      "total        : 10.2M tok (90.0% ↑)",
      "cache read   : 9M tok",
      "cache write  : 100K tok",
      "",
      "saved cost   : $24.00",
    ])
    // Total row is tokens-first, hit in brackets (collapsed-row order).
    expect(formatExpandedLines(model)[5]).toMatch(/^total\s+: \S+ tok \(.+\)$/)
    const collapsed = formatBarLine(model)
    expect(collapsed).not.toContain("$")
    expect(collapsed).not.toContain("subagents")
    expect(collapsed).not.toContain("|")
    expect(collapsed).toContain("tok · cache hit 90.0% ↑ (90.0% ↑) ·")
    expect(collapsed.endsWith("·")).toBe(true)
    expect(collapsed.endsWith("· ")).toBe(false)
    expect(collapsed).not.toMatch(/\s$/)
    expect(collapsed.length).toBeLessThan(90)
    expect(formatTokens(180_000_000)).toBe("180M")
    expect(formatTokens(370_000)).toBe("370K")
    expect(formatTokens(999)).toBe("999")
  })

  test("cache write zero renders n/a (implicit); nonzero unchanged", () => {
    const base = {
      reqHit: 90.0,
      sessionHit: 90.0,
      subsHit: null,
      subsCount: 0,
      costTotal: 0,
      cacheReadTotal: 9_000_000,
      savedTotal: 0,
      totalHit: 90.0,
      totalTokens: 10_000_000,
    }
    // Provider (opencode-go) reports implicit-only caching: write=0 on
    // 12,676/12,677 assistant turns DB-wide, so 0 must not read as "0 tok".
    expect(formatExpandedLines({ ...base, cacheWriteTotal: 0 })[7]).toBe("cache write  : n/a (implicit)")
    expect(formatExpandedLines({ ...base, cacheWriteTotal: 100_000 })[7]).toBe("cache write  : 100K tok")
  })

  test("menu content renders padded groups standalone", async () => {
    const root = join(import.meta.dir, "..")
    const fixtures = join(root, "tests", "fixtures")
    const proc = Bun.spawn(
      ["bun", "--conditions=browser", join(fixtures, "bar-probe-runner.ts"), join(fixtures, "bar-probe-expanded.tsx"), "12"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode, `probe failed:\n${stderr}`).toBe(0)
    const { frame } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { frame: string }
    for (const want of [
      "Cache Hit",
      "90.0%",
      "10.2M tok",
      "req hit",
      "90.0% ↑",
      "session total",
      "subagents",
      "-- (0)",
      "cache read",
      "9M tok",
      "cache write",
      "100K tok",
      "saved cost",
      "$24.00",
    ]) {
      expect(frame).toContain(want)
    }
    // Padded container: content is indented, not crammed at column 0.
    expect(frame).toContain("  req hit")
  })

  test("menu open/close decision", () => {
    expect(nextMenuAction(false, true)).toBe("open")
    expect(nextMenuAction(true, true)).toBe("close")
    expect(nextMenuAction(false, false)).toBe("noop")
    expect(nextMenuAction(true, false)).toBe("noop")
  })

  test("row fg: muted at rest, base/white on hover, muted fallback when base missing", () => {
    expect(rowFg(false, "#9ca3af", "#ffffff")).toBe("#9ca3af")
    expect(rowFg(true, "#9ca3af", "#ffffff")).toBe("#ffffff")
    expect(rowFg(true, "#9ca3af", undefined)).toBe("#9ca3af")
    expect(rowFg(false, "#9ca3af", undefined)).toBe("#9ca3af")
  })

  test("hover renders the row white, rest renders muted gray (span fg proof)", async () => {
    const root = join(import.meta.dir, "..")
    const fixtures = join(root, "tests", "fixtures")
    const proc = Bun.spawn(
      ["bun", "--conditions=browser", join(fixtures, "bar-hover-runner.ts"), join(fixtures, "bar-probe-hover.tsx")],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode, `hover probe failed:\n${stderr}`).toBe(0)
    const { spans } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
      spans: { text: string; fg: number[] }[][]
    }
    const rows = spans.flat().filter((s) => s.text.includes("cache hit")).map((s) => s.fg)
    expect(rows.length).toBe(3)
    // Rest row: muted #9ca3af ≈ (0.612, 0.639, 0.686); hovered row: white (1,1,1).
    const [rest, lit, rgbaRest] = rows
    for (const [i, want] of [156 / 255, 164 / 255, 175 / 255].entries()) {
      expect(Math.abs(rest[i] - want)).toBeLessThan(0.02)
    }
    expect(lit).toEqual([1, 1, 1, 1])
    expect(lit).not.toEqual(rest)
    // True runtime token shape (RGBA object, not string) renders the same gray.
    for (const [i, want] of [156 / 255, 164 / 255, 175 / 255].entries()) {
      expect(Math.abs(rgbaRest[i] - want)).toBeLessThan(0.02)
    }
  })

  test("click row opens menu via dialog; second click closes; row stays one line", async () => {
    const root = join(import.meta.dir, "..")
    const fixtures = join(root, "tests", "fixtures")
    const proc = Bun.spawn(
      ["bun", "--conditions=browser", join(fixtures, "bar-toggle-runner.ts"), join(fixtures, "bar-probe-toggle.tsx")],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode, `toggle probe failed:\n${stderr}`).toBe(0)
    const { calls, frame } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
      calls: { show: number; clear: number }
      frame: string
    }
    expect(calls.show).toBeGreaterThanOrEqual(1)
    expect(calls.clear).toBeGreaterThanOrEqual(1)
    // The footer row itself never grows inline: cost stays out of it, no subs segment.
    // Trailing · divider present (frame may trim the final space, so match up to ·).
    expect(frame).toContain("cache hit 90.0%")
    expect(frame).toContain("tok ·")
    expect(frame).toContain("↑) ·")
    expect(frame).not.toContain("saved cost")
    expect(frame).not.toContain("subagents")
    expect(frame).not.toContain("|")
  })
})
describe("widget render smoke", () => {
  test("CacheHitBarHost renders collapsed TOTAL row (no subs inline)", async () => {
    const root = join(import.meta.dir, "..")
    const fixtures = join(root, "tests", "fixtures")
    const proc = Bun.spawn(
      ["bun", "--conditions=browser", join(fixtures, "bar-probe-runner.ts"), join(fixtures, "bar-probe.tsx")],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode, `probe failed:\n${stderr}`).toBe(0)
    const { frame } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { frame: string }
    // Fixture prime: input 1000 + output 50 + read 3000 = 4050 yields 4.1K tok; hit 75%.
    // Single billable turn + first sighting renders up arrows on both figures.
    // Trailing · divider present (frame may trim the final space, so match up to ·).
    expect(frame).toContain("4.1K tok · cache hit 90.0% ↑ (75.0% ↑) ·")
    expect(frame).not.toContain("subagents")
    expect(frame).not.toContain("|")
    expect(frame).not.toContain("$")
  })
})

describe("plugin entry contract", () => {
  test("resolveMutedFg passes through native theme gray (string or RGBA object)", async () => {
    const mod = await import("../src/plugin.tsx")
    expect(mod.resolveMutedFg({ text: { muted: "#9ca3af" } })).toBe("#9ca3af")
    // Runtime ResolvedTheme value is an RGBA object, NOT a string — must pass through.
    // (Built-in prompt.footer.location/file use `theme.text.muted` directly as `fg`.)
    const rgba = { buffer: new Uint16Array([1, 2, 3, 4]) }
    expect(mod.resolveMutedFg({ text: { muted: rgba } })).toBe(rgba)
    // V1 flat shape fallback.
    expect(mod.resolveMutedFg({ current: { textMuted: rgba } })).toBe(rgba)
    expect(mod.resolveMutedFg(undefined)).toBeUndefined()
    expect(mod.resolveMutedFg({})).toBeUndefined()
    expect(mod.resolveMutedFg({ text: { muted: "" } })).toBeUndefined()
  })
  test("resolveBaseFg passes through the same record's base/white token", async () => {
    const mod = await import("../src/plugin.tsx")
    expect(mod.resolveBaseFg({ text: { base: "#ffffff", muted: "#9ca3af" } })).toBe("#ffffff")
    const rgba = { buffer: new Uint16Array([1, 2, 3, 4]) }
    expect(mod.resolveBaseFg({ text: { base: rgba } })).toBe(rgba)
    // V1 flat themes carry no base token → undefined (rowFg falls back to muted).
    expect(mod.resolveBaseFg({ current: { textMuted: rgba } })).toBeUndefined()
    expect(mod.resolveBaseFg(undefined)).toBeUndefined()
    expect(mod.resolveBaseFg({})).toBeUndefined()
    expect(mod.resolveBaseFg({ text: { base: "" } })).toBeUndefined()
  })
  test("server entry id", async () => {
    const mod = await import("../src/v2/server.ts")
    expect(mod.default.id).toBe("cache-hit-bar")
  })

  test("setup claims prompt.footer.status; tui registers app_bottom", async () => {
    const mod = await import("../src/plugin.tsx")
    expect(mod.PLUGIN_ID).toBe("cache-hit-bar")
    expect(mod.setup).toBeTypeOf("function")
    expect(mod.tui).toBeTypeOf("function")

    const claims: unknown[] = []
    const noopSync = () => Promise.resolve()
    const fakeCtx = {
      data: {
        on: () => () => {},
        session: {
          get: () => undefined,
          list: () => [],
          sync: noopSync,
          message: { get: () => undefined, list: () => [], sync: noopSync },
        },
        location: {
          provider: { list: () => [], sync: noopSync },
          model: { list: () => [], sync: noopSync },
        },
      },
      session: {},
      message: {},
      location: { directory: "C:/tmp" },
      provider: { all: async () => [] },
      model: {},
      client: {},
      ui: { slot: (c: unknown) => { claims.push(c); return () => {} } },
      on: () => () => {},
    }
    const dispose = (mod.setup as (ctx: unknown) => () => void)(fakeCtx)
    expect(claims.length).toBe(1)
    expect((claims[0] as { append: string }).append).toBe("prompt.footer.status")
    expect(dispose).toBeTypeOf("function")
    dispose()

    const regs: unknown[] = []
    const fakeApi = {
      event: { on: () => () => {} },
      slots: { register: (r: unknown) => { regs.push(r); return "x" } },
    }
    await (mod.tui as (api: unknown) => Promise<void>)(fakeApi)
    expect(regs.length).toBe(1)
    expect(Object.keys((regs[0] as { slots: object }).slots)).toContain("app_bottom")
  })
})
