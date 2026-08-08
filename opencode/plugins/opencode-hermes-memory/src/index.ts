// opencode-hermes-memory plugin
// Merged from opencode-hermes-memory (npm) + opencode-memory-nudge (local)
// Provides: memory tools, skill tools, system prompt injection, nudge injection, signal detection

import { randomUUID } from "crypto"
import { MemoryManager } from "./memory-manager.ts"
import { SkillManager } from "./skill-manager.ts"
import { createSessionManager } from "./state.ts"
import { detectCorrectionInText, detectSignalInToolOutput } from "./signals.ts"
import { dualInject } from "./messages.ts"
import {
  DEFAULT_CONFIG,
  PERIODIC_NUDGE,
  RETRIEVAL_GAP_NUDGE,
  SKILL_NUDGE,
  SIGNAL_CORRECTION_NUDGE,
  SIGNAL_WORKFLOW_NUDGE,
  SIGNAL_ENVIRONMENT_NUDGE,
} from "./config.ts"
import { createMemoryTools } from "./tools/memory-tools.ts"
import { createSkillTools } from "./tools/skill-tools.ts"
import type { MemoryNudgeConfig, SessionState, Message } from "./types.ts"
import { createSessionState } from "./types.ts"

const memoryManager = new MemoryManager()
const skillManager = new SkillManager()
const sessionManager = createSessionManager()

// ─── Plugin Entry ─────────────────────────────────────────────────────────────

export default function createPlugin(config?: Partial<MemoryNudgeConfig>) {
  const mergedConfig: MemoryNudgeConfig = { ...DEFAULT_CONFIG, ...config }

  const memoryTools = createMemoryTools(memoryManager)
  const skillTools = createSkillTools(skillManager)
  const allTools = { ...memoryTools, ...skillTools }

  // Pending signal nudges (array to avoid overwriting — BUG-006)
  const pendingSignalNudges = new Map<string, string[]>()

  // Frozen memory snapshot — built once per SESSION and kept byte-stable for the
  // rest of that session (prompt-cache stability). The old code set this to null
  // on every session.idle, which fires after EVERY assistant turn; that rebuilt
  // the snapshot constantly, so any memory_save / skill_create mid-session
  // changed the injected system prompt and killed provider prefix cache hits.
  // Design intent (Hermes prompt assembly): snapshot frozen at session start,
  // mid-session writes appear on the NEXT session. Map keyed by sessionID.
  const snapshotCache = new Map<string, string>()
  const SNAPSHOT_CACHE_MAX = 64

  // Stable per-process fallback ID — avoids fragmenting state across 100+ random UUIDs
  const STABLE_FALLBACK_ID = `nudge-fallback-${randomUUID()}`

  function resolveSessionID(input: any, messages?: Message[]): string {
    // 1. Direct sessionID on input (tool.execute.after has it)
    if (input?.sessionID) return input.sessionID
    if (input?.sessionId) return input.sessionId
    // 2. Session ID on message info (messages.transform)
    if (messages?.length) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const sid = (messages[i].info as any)?.sessionID
        if (sid) return sid
      }
    }
    return STABLE_FALLBACK_ID
  }

  function buildMemorySummary(title: string): string {
    const memoryContent = memoryManager.readMemory()
    const skills = skillManager.list()
    const userProfile = memoryManager.readUserProfile()
    const skillLines = skills.map(
      (s: { name: string; description: string }) => `- ${s.name}: ${s.description}`
    )
    return [
      title,
      "",
      "## Semantic Memory (MEMORY.md)",
      memoryContent.trim() || "(empty)",
      "",
      "## Procedural Memory (Skills)",
      skillLines.length > 0 ? skillLines.join("\n") : "(none)",
      "",
      "## User Profile (USER.md)",
      userProfile.trim() || "(empty)",
    ].join("\n")
  }

  function getFrozenSnapshot(sessionID: string): string {
    // Key by the REAL session id when available; fallback id is stable per process.
    const key = sessionID || "default"
    const cached = snapshotCache.get(key)
    if (cached !== undefined) return cached
    const snapshot = [
      buildMemorySummary("# Hermes Memory State"),
      "",
      "## Retrieval Reminder",
      "Before acting on any task, use memory_search(query: \"keywords\") to check past knowledge.",
      "After completing complex tasks (5+ tool calls), consider skill_create() for reusable workflows.",
    ].join("\n")
    snapshotCache.set(key, snapshot)
    // Bound memory usage: drop oldest entries beyond the cap.
    if (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
      const oldest = snapshotCache.keys().next().value
      if (oldest !== undefined) snapshotCache.delete(oldest)
    }
    return snapshot
  }

  return {
    // ─── 1. TOOLS ─────────────────────────────────────────────────────────
    tool: allTools,

    // ─── 2. SYSTEM PROMPT INJECTION ───────────────────────────────────────
    "experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
      const sessionID = input?.sessionID || input?.sessionId || ""
      output.system.push(getFrozenSnapshot(sessionID))
    },

    // ─── 3. MESSAGE-LEVEL NUDGE INJECTION ─────────────────────────────────
    "experimental.chat.messages.transform": async (input: any, output: any) => {
      try {
        const messages = output.messages as Message[]
        if (!messages || messages.length === 0) return

        const sessionID = resolveSessionID(input, messages)
        const state = sessionManager.get(sessionID)

        state.monotonicTurnCount++

        const turnsSinceNudge = state.monotonicTurnCount - state.lastNudgeMonotonic
        const shouldPeriodicNudge =
          state.toolCallCount >= mergedConfig.minToolCallsBeforeNudge &&
          turnsSinceNudge >= mergedConfig.nudgeFrequency

        // Check for pending signal nudges (array, not single value)
        const pendingSignals = pendingSignalNudges.get(sessionID)
        // Cap the queue: never inject more than a few nudges per session turn -
        // prevents nudge storms after bursty tool activity.
        while (pendingSignals && pendingSignals.length > 3) pendingSignals.shift()
        const pendingSignal = pendingSignals?.length ? pendingSignals.shift()! : null

        // Determine which nudge to inject
        let nudgeText: string | null = null

        if (pendingSignal) {
          nudgeText = pendingSignal
        } else if (shouldPeriodicNudge) {
          nudgeText = PERIODIC_NUDGE
          state.lastNudgeMonotonic = state.monotonicTurnCount
        }

        if (nudgeText) {
          dualInject(messages, nudgeText)
          state.lastNudgeTimestamp = Date.now()
        }

        // ─── RETRIEVAL GAP NUDGE ──────────────────────────────────────────
        // FIX (spam): the old code fired this on EVERY turn once the gap was
        // exceeded - it never updated lastMemorySearchMonotonic or
        // lastNudgeMonotonic. Cooldown: only fire if we have NOT nudged within
        // nudgeFrequency turns, then record the nudge. Recompute turnsSinceNudge
        // here (a periodic/pending nudge above may have just updated the cooldown).
        const turnsSinceNudgeNow = state.monotonicTurnCount - state.lastNudgeMonotonic
        if (
          state.lastMemorySearchMonotonic >= 0 &&
          turnsSinceNudgeNow >= mergedConfig.nudgeFrequency
        ) {
          const turnsSinceSearch = state.monotonicTurnCount - state.lastMemorySearchMonotonic
          if (turnsSinceSearch >= mergedConfig.nudgeFrequency) {
            const gapNudge = RETRIEVAL_GAP_NUDGE.replace("{toolCalls}", String(state.toolCallCount))
            dualInject(messages, gapNudge)
            state.lastNudgeMonotonic = state.monotonicTurnCount
            state.lastNudgeTimestamp = Date.now()
          }
        }

        // ─── CORRECTION DETECTION ─────────────────────────────────────────
        // FIX (spam): keyed on monotonicTurnCount, so the SAME correction in the
        // SAME user message re-queued a nudge every turn (turn count changes
        // every transform call). Key on the message ID instead: one nudge per
        // offending message, ever.
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.info?.role !== "user" || !msg.parts?.length) continue
          for (const part of msg.parts) {
            if (part.type !== "text") continue
            const text = (part as any).text
            if (detectCorrectionInText(text)) {
              const msgId = (msg.info as any)?.id || `corr-${i}`
              const key = `correction:${msgId}`
              if (!state.signalNudgeSent.has(key)) {
                state.signalNudgeSent.add(key)
                if (!pendingSignalNudges.has(sessionID)) {
                  pendingSignalNudges.set(sessionID, [])
                }
                pendingSignalNudges.get(sessionID)!.push(SIGNAL_CORRECTION_NUDGE)
              }
              break
            }
          }
          break
        }

        sessionManager.save()
      } catch {
        // Silent — never break the conversation
      }
    },

    // ─── 4. TOOL EXECUTION TRACKING ───────────────────────────────────────
    "experimental.chat.tool.execute.after": (input: any, output: any) => {
      try {
        const toolName = input.tool
        const sessionID = input.sessionID || resolveSessionID(input)
        const state = sessionManager.get(sessionID)

        // ─── FILE-EDIT GUARD ───────────────────────────────────────────────
        // Block direct edits/writes to memory.md and user.md
        if (toolName === "edit" || toolName === "write") {
          const filePath = (input.args?.filePath || input.args?.path || "").replace(/\\/g, "/")
          if (/\/(memory|user)\.md$/i.test(filePath) && !toolName.startsWith("memory_")) {
            return {
              content: `BLOCKED: Cannot edit ${filePath} directly. Use memory_save() or memory_search() instead.`,
            }
          }
        }

        state.toolCallCount++

        // Track memory operations
        if (toolName === "memory_save") {
          state.lastMemorySaveMonotonic = state.monotonicTurnCount
        }
        if (toolName === "memory_search") {
          state.lastMemorySearchMonotonic = state.monotonicTurnCount
          state.memorySearchCount++
        }
        if (toolName === "skill") {
          state.lastSkillLoadMonotonic = state.monotonicTurnCount
          state.skillLoadCount++
        }
        if (toolName === "skill_create" || toolName === "skill_update") {
          state.taskCompletionCount++
        }

        // Signal detection on tool output
        if (mergedConfig.signalDetection && !mergedConfig.protectedTools.includes(toolName)) {
          const toolOutput = output?.output
          if (toolOutput) {
            const outputText = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput)
            const signalType = detectSignalInToolOutput(toolName, outputText)
            if (signalType) {
              // FIX (spam): key on tool name + call signature, not turn count,
              // so the same output does not re-queue a nudge every turn.
              const key = `signal:${toolName}:${signalType}`
              if (!state.signalNudgeSent.has(key)) {
                state.signalNudgeSent.add(key)
                if (!pendingSignalNudges.has(sessionID)) {
                  pendingSignalNudges.set(sessionID, [])
                }
                const nudgeMap: Record<string, string> = {
                  workflow: SIGNAL_WORKFLOW_NUDGE,
                  environment: SIGNAL_ENVIRONMENT_NUDGE,
                }
                pendingSignalNudges.get(sessionID)!.push(nudgeMap[signalType])
              }
            }
          }
        }

        // ─── SKILL UPDATE NUDGE ───────────────────────────────────────────
        // FIX (spam): every skill_list/skill call queued SKILL_NUDGE with no
        // dedup - the agent calls skill() constantly, so nudges piled up for
        // dozens of turns. Only queue once per session.
        if ((toolName === "skill_list" || toolName === "skill") && mergedConfig.signalDetection) {
          const key = `signal:skill:${toolName}`
          if (!state.signalNudgeSent.has(key)) {
            state.signalNudgeSent.add(key)
            if (!pendingSignalNudges.has(sessionID)) {
              pendingSignalNudges.set(sessionID, [])
            }
            pendingSignalNudges.get(sessionID)!.push(SKILL_NUDGE)
          }
        }

        sessionManager.save()
      } catch {
        // Silent
      }
    },

    // ─── 5. SESSION LIFECYCLE ─────────────────────────────────────────────
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        // Merge fallback sessions into real session (BUG-014 fix)
        sessionManager.mergeFallbacks(sessionID)

        // NOTE: we intentionally do NOT invalidate the frozen snapshot here.
        // session.idle fires after every assistant turn; invalidating rebuilt
        // the snapshot on every turn, so any memory_save mid-session changed the
        // system prompt and destroyed prompt-cache hits. Snapshot stays frozen
        // per session; new sessions build their own fresh snapshot.

        // Clean up session state
        pendingSignalNudges.delete(sessionID)
      }

      if (event.type === "session.compacting") {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return
        return {
          messages: [
            {
              role: "assistant",
              content: `## Session State Summary\n${buildMemorySummary("# Session Context")}\n\nPersist critical facts to MEMORY.md or USER.md using memory_save before they are lost.`,
            },
          ],
        }
      }
    },
  }
}
