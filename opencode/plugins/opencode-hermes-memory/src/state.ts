import fs from "node:fs"
import path from "node:path"
import type { SessionState } from "./types.js"

const PLUGIN_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"))
const STATE_FILE = path.join(PLUGIN_DIR, "nudge-state.json")
// ─── Serialization helpers ────────────────────────────────────────────────────

function serializeSession(state: SessionState) {
  return { ...state, signalNudgeSent: Array.from(state.signalNudgeSent) }
}

function deserializeSession(raw: Record<string, unknown>): SessionState {
  return {
    ...raw,
    signalNudgeSent: new Set((raw.signalNudgeSent as string[]) ?? []),
  } as SessionState
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export function createSessionManager() {
  let sessions = new Map<string, SessionState>()

  function load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
        sessions = new Map(
          Object.entries(raw).map(([id, data]) => [id, deserializeSession(data as Record<string, unknown>)])
        )
      }
    } catch {
      sessions = new Map()
    }
    // FIX (state bloat): prune dead fallback sessions. Every process spawn
    // creates a new nudge-fallback-* id; with toolCallCount 0 they never merge
    // and accumulated into an 11K-entry / 4.8MB state file that was rewritten
    // synchronously on EVERY transform + tool call. Drop empty fallbacks and
    // cap total sessions.
    const before = sessions.size
    for (const [id, state] of sessions) {
      if (id.startsWith("nudge-fallback-") && state.toolCallCount === 0) {
        sessions.delete(id)
      }
    }
    // Cap: keep the most recent real sessions (fallbacks already cleaned above).
    const MAX_SESSIONS = 200
    if (sessions.size > MAX_SESSIONS) {
      const all = [...sessions.entries()]
      // Keep real sessions first (they matter), drop oldest fallback-like keys.
      const sorted = all.sort((a, b) => (b[1] as SessionState).lastNudgeTimestamp - (a[1] as SessionState).lastNudgeTimestamp)
      sessions = new Map(sorted.slice(0, MAX_SESSIONS))
    }
    if (sessions.size !== before) {
      try { fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2)) } catch { /* ignore */ }
    }
  }

  // Throttle disk writes: full-file JSON rewrite on every transform + tool call
  // is wasteful. Write at most once per second; the final state is always
  // flushed on the next save after the throttle window.
  let lastSaveTime = 0
  const SAVE_THROTTLE_MS = 1000

  function save() {
    const now = Date.now()
    if (now - lastSaveTime < SAVE_THROTTLE_MS) return
    lastSaveTime = now
    const obj: Record<string, unknown> = {}
    for (const [k, v] of sessions) {
      obj[k] = serializeSession(v)
    }
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2))
    } catch {
      // ignore write errors
    }
  }

  function get(id: string): SessionState {
    if (!sessions.has(id)) {
      const { createSessionState } = require("./types")
      sessions.set(id, createSessionState())
    }
    return sessions.get(id)!
  }

  function mergeFallbacks(realSessionId: string) {
    const toRemove: string[] = []
    const real = get(realSessionId)

    for (const [id, state] of sessions) {
      if (id.startsWith("nudge-fallback-") && state.toolCallCount > 0) {
        real.monotonicTurnCount = Math.max(real.monotonicTurnCount, state.monotonicTurnCount)
        real.toolCallCount = Math.max(real.toolCallCount, state.toolCallCount)
        real.memorySearchCount = Math.max(real.memorySearchCount, state.memorySearchCount)
        real.skillLoadCount = Math.max(real.skillLoadCount, state.skillLoadCount)
        real.taskCompletionCount = Math.max(real.taskCompletionCount, state.taskCompletionCount)
        real.lastNudgeMonotonic = Math.max(real.lastNudgeMonotonic, state.lastNudgeMonotonic)
        real.lastMemorySaveMonotonic = Math.max(real.lastMemorySaveMonotonic, state.lastMemorySaveMonotonic)
        real.lastMemorySearchMonotonic = Math.max(real.lastMemorySearchMonotonic, state.lastMemorySearchMonotonic)
        real.lastSkillLoadMonotonic = Math.max(real.lastSkillLoadMonotonic, state.lastSkillLoadMonotonic)
        if (state.lastNudgeTimestamp > real.lastNudgeTimestamp) {
          real.lastNudgeTimestamp = state.lastNudgeTimestamp
        }
        for (const sig of state.signalNudgeSent) {
          real.signalNudgeSent.add(sig)
        }
        toRemove.push(id)
      }
    }
    for (const id of toRemove) {
      sessions.delete(id)
    }
    if (toRemove.length > 0) save()
    return real
  }

  load()
  return { get, save, mergeFallbacks }
}
