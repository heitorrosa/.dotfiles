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
  }

  function save() {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of sessions) {
      obj[k] = serializeSession(v)
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2))
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
