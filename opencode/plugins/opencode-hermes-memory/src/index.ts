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

  // Frozen memory snapshot — read once per session, invalidated on session.idle
  let cachedSystemPrompt: string | null = null

  function resolveSessionID(input: any): string {
    return input?.sessionID || input?.sessionId || `nudge-fallback-${randomUUID()}`
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

  function getFrozenSnapshot(): string {
    if (!cachedSystemPrompt) {
      cachedSystemPrompt = [
        buildMemorySummary("# Hermes Memory State"),
        "",
        "## Retrieval Reminder",
        "Before acting on any task, use memory_search(query: \"keywords\") to check past knowledge.",
        "After completing complex tasks (5+ tool calls), consider skill_create() for reusable workflows.",
      ].join("\n")
    }
    return cachedSystemPrompt
  }

  return {
    // ─── 1. TOOLS ─────────────────────────────────────────────────────────
    tool: allTools,

    // ─── 2. SYSTEM PROMPT INJECTION ───────────────────────────────────────
    "experimental.chat.system.transform": (systemParts: any[]) => {
      return [...(Array.isArray(systemParts) ? systemParts : []), { role: "system" as const, content: getFrozenSnapshot() }]
    },

    // ─── 3. MESSAGE-LEVEL NUDGE INJECTION ─────────────────────────────────
    "experimental.chat.messages.transform": async (input: any, output: any) => {
      try {
        const sessionID = resolveSessionID(input)
        const state = sessionManager.get(sessionID)

        const messages = output.messages as Message[]
        if (!messages || messages.length === 0) return

        state.monotonicTurnCount++

        const turnsSinceNudge = state.monotonicTurnCount - state.lastNudgeMonotonic
        const shouldPeriodicNudge =
          state.toolCallCount >= mergedConfig.minToolCallsBeforeNudge &&
          turnsSinceNudge >= mergedConfig.nudgeFrequency

        // Check for pending signal nudges (array, not single value)
        const pendingSignals = pendingSignalNudges.get(sessionID)
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
        if (state.lastMemorySearchMonotonic >= 0) {
          const turnsSinceSearch = state.monotonicTurnCount - state.lastMemorySearchMonotonic
          if (turnsSinceSearch >= mergedConfig.nudgeFrequency) {
            const gapNudge = RETRIEVAL_GAP_NUDGE.replace("{toolCalls}", String(state.toolCallCount))
            dualInject(messages, gapNudge)
          }
        }

        // ─── CORRECTION DETECTION ─────────────────────────────────────────
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.info?.role !== "user" || !msg.parts?.length) continue
          for (const part of msg.parts) {
            if (part.type !== "text") continue
            const text = (part as any).text
            if (detectCorrectionInText(text)) {
              const key = `${state.monotonicTurnCount}-correction`
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
    "experimental.chat.tool.execute.after": (toolResult: any) => {
      try {
        const toolName = toolResult.info.tool
        const sessionID = resolveSessionID(toolResult)
        const state = sessionManager.get(sessionID)

        // ─── FILE-EDIT GUARD ───────────────────────────────────────────────
        // Block direct edits/writes to memory.md and user.md
        if (toolName === "edit" || toolName === "write") {
          const filePath = (toolResult.args?.filePath || toolResult.args?.path || "").replace(/\\/g, "/")
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
          const result = toolResult.properties?.result
          if (result) {
            const output = typeof result === "string" ? result : JSON.stringify(result)
            const signalType = detectSignalInToolOutput(toolName, output)
            if (signalType) {
              const key = `${state.monotonicTurnCount}-${signalType}`
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
        if ((toolName === "skill_list" || toolName === "skill") && mergedConfig.signalDetection) {
          if (!pendingSignalNudges.has(sessionID)) {
            pendingSignalNudges.set(sessionID, [])
          }
          pendingSignalNudges.get(sessionID)!.push(SKILL_NUDGE)
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

        // Invalidate frozen snapshot so next session re-reads from disk
        cachedSystemPrompt = null

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
