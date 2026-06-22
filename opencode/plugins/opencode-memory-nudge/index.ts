// ~/.config/opencode/plugins/opencode-memory-nudge/index.ts
// Nudges the agent to persist memory during conversations.
// Modeled on ACP's compression nudging pattern — injects nudges into
// the MESSAGE STREAM via experimental.chat.messages.transform.

import { randomUUID } from "crypto"

// ─── Configuration ────────────────────────────────────────────────────────────

interface MemoryNudgeConfig {
  /** Nudge every N turns (default: 10) */
  turnFrequency: number
  /** Detect persistable signals in tool output (default: true) */
  signalDetection: boolean
  /** Nudge on session.idle events (default: true) */
  sessionEndNudge: boolean
  /** Tools whose output should not trigger signal nudges */
  protectedTools: string[]
  /** Minimum tool calls before turn nudge starts (default: 5) */
  minToolCallsBeforeNudge: number
  /**
   * Controls which message role receives nudge injection.
   * - "soft" (default): Inject into assistant messages (less intrusive)
   * - "strong": Inject into user messages (more forceful)
   * Mirrors ACP's nudgeForce config.
   */
  nudgeForce: "soft" | "strong"
}

const DEFAULT_CONFIG: MemoryNudgeConfig = {
  turnFrequency: 10,
  signalDetection: true,
  sessionEndNudge: true,
  protectedTools: [
    "memory_save",
    "memory_search",
    "compress",
    "ctx_search",
    "ctx_stats",
    "skill_list",
    "skill",
  ],
  minToolCallsBeforeNudge: 5,
  nudgeForce: "soft",
}

// ─── Nudge Text Templates ─────────────────────────────────────────────────────

const TURN_NUDGE = `<system-reminder>
[Hermes Memory Nudge] You've been working for a while. Pause and evaluate:
- Did the user correct you? → memory_save(type: "correction")
- Did you discover a project fact (build command, deploy step, file structure)? → memory_save(type: "environment")
- Did you find a reusable workflow? → memory_save(type: "workflow")
- Did you learn a user preference? → memory_save(type: "user_preference")
Persist now — future sessions depend on it.
</system-reminder>`

const SIGNAL_CORRECTION_NUDGE = `<system-reminder>
[Hermes Memory — Correction Detected] The user just corrected you. This is your highest-value signal.
Call memory_save(type: "correction", content: "...") NOW with the exact correction.
Do not defer — corrections are the most important thing to persist.
</system-reminder>`

const SIGNAL_WORKFLOW_NUDGE = `<system-reminder>
[Hermes Memory — Workflow Discovered] You just completed a multi-step process that worked.
Call memory_save(type: "workflow", content: "...") to document it for future sessions.
</system-reminder>`

const SIGNAL_ENVIRONMENT_NUDGE = `<system-reminder>
[Hermes Memory — Environment Fact] You discovered a project-specific fact (path, command, config, dependency).
Call memory_save(type: "environment", content: "...") to record it.
</system-reminder>`

// ─── Signal Detection ─────────────────────────────────────────────────────────

/**
 * Patterns that indicate the user is correcting the agent.
 * FIXED (BUG-004): Require stronger signal than bare "no" —
 * bare "no" is too common in conversation and false-positives.
 * Now requires contextual anchoring (e.g., "no, ...", "no. ...", "no! ...").
 */
const CORRECTION_PATTERNS = [
  /\bno[,.!]\s/i,                          // "no," or "no." or "no!" — anchored, not bare
  /\bactually\b/i,                          // "actually" is a strong correction signal
  /\bthat'?s\s+(not|wrong|incorrect)\b/i,   // "that's not right"
  /\byou\s+should\s+have\b/i,               // "you should have done X"
  /\buse\s+\S+\s+instead\b/i,              // "use X instead"
  /\bdon'?t\s+(use|do|run|call)\b/i,        // "don't use X"
  /\bincorrect\b/i,                         // "incorrect" is unambiguous
]

/** Patterns that indicate an environment fact was discovered */
const ENVIRONMENT_PATTERNS = [
  /deploy(?:ment)?\s+(via|using|with|command)/i,
  /build\s+(command|step|script)/i,
  /runtime:\s*/i,
  /package\s+manager/i,
  /node\s+version/i,
  /\b(pnpm|bun|yarn|npm)\b.*\b(install|run|build)\b/i,
]

/** Patterns that indicate a workflow was completed */
const WORKFLOW_PATTERNS = [
  /step\s+\d+\s*(of|:)/i,
  /phase\s+\d+/i,
  /successfully\s+(completed|deployed|built|installed)/i,
]

function detectSignalInToolOutput(toolName: string, output: string): "workflow" | "environment" | null {
  if (toolName.startsWith("memory_") || toolName.startsWith("ctx_")) return null

  for (const pattern of WORKFLOW_PATTERNS) {
    if (pattern.test(output)) return "workflow"
  }
  for (const pattern of ENVIRONMENT_PATTERNS) {
    if (pattern.test(output)) return "environment"
  }
  return null
}

// ─── Session State ────────────────────────────────────────────────────────────

interface SessionState {
  /** Monotonic counter — incremented on each hook call, never reset by compaction */
  monotonicTurnCount: number
  /** Last monotonic count at which a nudge was sent */
  lastNudgeMonotonic: number
  /** Tool call count */
  toolCallCount: number
  /** Monotonic count at last memory_save */
  lastMemorySaveMonotonic: number
  /** Signal types already sent this session */
  signalNudgeSent: Set<string>
  /** Phase 3: Timestamp of last nudge injection (for cooldown) */
  lastNudgeTimestamp: number
  /** Phase 3: Count of consecutive failed injection attempts */
  consecutiveFailures: number
}

function createSessionState(): SessionState {
  return {
    monotonicTurnCount: 0,
    lastNudgeMonotonic: 0,
    toolCallCount: 0,
    lastMemorySaveMonotonic: -1,
    signalNudgeSent: new Set(),
    lastNudgeTimestamp: 0,
    consecutiveFailures: 0,
  }
}

// ─── Phase 3: State Persistence ───────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const STATE_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'opencode', 'plugins', 'opencode-memory-nudge')
const STATE_FILE = join(STATE_DIR, 'nudge-state.json')

function loadPersistedState(): Map<string, Partial<SessionState>> {
  const map = new Map<string, Partial<SessionState>>()
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, 'utf8')
      const data = JSON.parse(raw)
      for (const [k, v] of Object.entries(data)) {
        map.set(k, v as Partial<SessionState>)
      }
    }
  } catch { /* cold start */ }
  return map
}

function persistState(sessions: Map<string, SessionState>) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const obj: Record<string, any> = {}
    for (const [k, v] of sessions) {
      obj[k] = {
        monotonicTurnCount: v.monotonicTurnCount,
        lastNudgeMonotonic: v.lastNudgeMonotonic,
        toolCallCount: v.toolCallCount,
        lastMemorySaveMonotonic: v.lastMemorySaveMonotonic,
        signalNudgeSent: Array.from(v.signalNudgeSent),
        lastNudgeTimestamp: v.lastNudgeTimestamp,
        consecutiveFailures: v.consecutiveFailures,
      }
    }
    writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch { /* degrade silently */ }
}

// ─── Message Helpers (adapted from ACP) ───────────────────────────────────────

interface MessageInfo {
  id: string
  role: string
}

interface TextPart {
  type: "text"
  text: string
}

interface Message {
  info: MessageInfo
  parts: Array<TextPart | { type: string; [key: string]: unknown }>
}

/**
 * Inject a nudge into a message by appending to its last text part.
 * Adapted from ACP's injectAnchoredNudge().
 */
function injectNudgeIntoMessage(message: Message, nudgeText: string): boolean {
  if (!nudgeText.trim()) return false

  if (message.info.role === "user") {
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]
      if (part.type === "text") {
        ;(part as TextPart).text += "\n\n" + nudgeText
        return true
      }
    }
    message.parts.push({ type: "text", text: nudgeText } as TextPart)
    return true
  }

  if (message.info.role === "assistant") {
    if (message.parts.length === 0) return false
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]
      if (part.type === "text") {
        ;(part as TextPart).text += "\n\n" + nudgeText
        return true
      }
    }
    return false
  }

  return false
}

function findLastUserMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "user" && msg.parts?.length > 0) {
      return msg
    }
  }
  return null
}

function findLastAssistantMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "assistant" && msg.parts?.length > 0) {
      return msg
    }
  }
  return null
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default async function (input: any) {
  const config: MemoryNudgeConfig = { ...DEFAULT_CONFIG }

  /**
   * PHASE 3: Load persisted state from disk so sessions survive restarts.
   * Maps are hydrated from JSON, Sets reconstructed from arrays.
   */
  const persisted = loadPersistedState()
  const sessions = new Map<string, SessionState>()
  for (const [k, v] of persisted) {
    sessions.set(k, {
      ...createSessionState(),
      ...v,
      signalNudgeSent: new Set(v.signalNudgeSent || []),
    })
  }

  /**
   * FIXED (BUG-006): Use array to avoid overwriting pending signals.
   * Multiple signals in the same turn should queue, not collide.
   */
  const pendingSignalNudges = new Map<string, string[]>()

  function getSession(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (!state) {
      state = createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  /**
   * FIXED (BUG-001): sessionID fallback using crypto.randomUUID().
   * The SDK type definition declares input: {} for messages.transform,
   * so sessionID may be undefined. This is the ROOT CAUSE of the plugin
   * being completely dead — the early return on line 234 killed every call.
   */
  function resolveSessionID(input: any, context: string): string {
    const id = input?.sessionID || input?.sessionId
    if (id) return id
    return `nudge-fallback-${randomUUID()}`
  }

  return {
    // ─── 1. MESSAGE-LEVEL NUDGE INJECTION ─────────────────────────────────
    "experimental.chat.messages.transform": async (input: any, output: any) => {
      /**
       * FIXED (BUG-005): Wrapped entire handler in try-catch.
       * An unhandled exception in messages.transform kills the message pipeline
       * for ALL plugins loaded after this one — a silent cascade failure.
       */
      try {
        const sessionID = resolveSessionID(input, "messages.transform")
        const state = getSession(sessionID)

        const messages = output.messages as Message[]
        if (!messages || messages.length === 0) return

        /**
         * FIXED (BUG-002): Monotonic counter instead of counting user messages.
         * Previously: state.turnCount = userMessageCount (from messages array).
         * Problem: After compaction, messages array shrinks → turnCount DECREASES,
         * but lastNudgeTurn stays high → nudge timer permanently broken.
         * Fix: Increment a monotonic counter on every hook call — never decreases.
         */
        state.monotonicTurnCount++

        // Check if we should nudge (periodic)
        const turnsSinceNudge = state.monotonicTurnCount - state.lastNudgeMonotonic
        const shouldTurnNudge =
          state.toolCallCount >= config.minToolCallsBeforeNudge &&
          turnsSinceNudge >= config.turnFrequency

        // Check for pending signal nudges (array, not single value)
        const pendingSignals = pendingSignalNudges.get(sessionID)
        const pendingSignal = pendingSignals && pendingSignals.length > 0
          ? pendingSignals.shift()!
          : null

        // Determine which nudge to inject
        let nudgeText: string | null = null

        if (pendingSignal) {
          nudgeText = pendingSignal
        } else if (shouldTurnNudge) {
          nudgeText = TURN_NUDGE
          state.lastNudgeMonotonic = state.monotonicTurnCount
        }

        /**
         * PHASE 3: Dual-injection for reliability.
         * Inject into BOTH assistant and user messages so the nudge is visible
         * regardless of which role's messages the model actually processes.
         * This mirrors opencode-btw's dual-injection pattern.
         */
        if (nudgeText) {
          const assistantMsg = findLastAssistantMessage(messages)
          const userMsg = findLastUserMessage(messages)
          if (assistantMsg) injectNudgeIntoMessage(assistantMsg, nudgeText)
          if (userMsg && userMsg !== assistantMsg) injectNudgeIntoMessage(userMsg, nudgeText)
          state.lastNudgeTimestamp = Date.now()
        }

        // ─── CORRECTION DETECTION ─────────────────────────────────────────
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.info?.role !== "user") continue
          if (!msg.parts?.length) continue

          const textParts = msg.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as TextPart).text)
            .join(" ")

          if (!textParts) continue

          if (textParts.includes("[Hermes Memory — Correction Detected]")) break

          for (const pattern of CORRECTION_PATTERNS) {
            if (pattern.test(textParts)) {
              injectNudgeIntoMessage(msg, SIGNAL_CORRECTION_NUDGE)
              break
            }
          }
          break
        }
      } catch {
        // Silent — do not leak errors into terminal
      }
    },

    // ─── 2. SYSTEM PROMPT ENHANCEMENT ─────────────────────────────────────
    "experimental.chat.system.transform": async (input: any, output: any) => {
      try {
        const sessionID = resolveSessionID(input, "system.transform")
        const state = getSession(sessionID)

        const turnsSinceNudge = state.monotonicTurnCount - state.lastNudgeMonotonic

        /**
         * PHASE 3: Context-aware cooldown.
         * If we recently injected a nudge (within 2 hook calls), skip re-injection
         * to avoid redundant content. This prevents the stale/redundant system
         * prompt push that was reported as BUG-010 (originally numbered).
         */
        const timeSinceNudge = Date.now() - state.lastNudgeTimestamp
        const COOLDOWN_MS = 30000 // 30s cooldown between system prompt injections
        if (timeSinceNudge < COOLDOWN_MS) return

        if (state.toolCallCount >= config.minToolCallsBeforeNudge) {
          output.system.push(
            `[Memory Nudge] ${state.toolCallCount} tool calls this session, ${state.monotonicTurnCount} turns. ` +
            `Next periodic nudge in ~${Math.max(0, config.turnFrequency - turnsSinceNudge)} turns. ` +
            `Persist corrections, workflows, environment facts, and user preferences via memory_save() proactively — do not wait for nudges.`
          )
        }
      } catch {
        // Silent — do not leak errors into terminal
      }
    },

    // ─── 3. SIGNAL DETECTION (tool.execute.after) ─────────────────────────
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const sessionID = resolveSessionID(input, "tool.execute.after")
        const state = getSession(sessionID)
        const toolName = input.tool
        const toolOutput = (output.output ?? "") as string

        state.toolCallCount++

        if (toolName === "memory_save") {
          state.lastMemorySaveMonotonic = state.monotonicTurnCount
          return
        }

        if (config.protectedTools.includes(toolName)) return
        if (!config.signalDetection) return

        const signal = detectSignalInToolOutput(toolName, toolOutput)
        if (signal && !state.signalNudgeSent.has(signal)) {
          const turnsSinceSave = state.monotonicTurnCount - state.lastMemorySaveMonotonic
          if (turnsSinceSave >= 3) {
            const nudgeText =
              signal === "workflow" ? SIGNAL_WORKFLOW_NUDGE : SIGNAL_ENVIRONMENT_NUDGE
            /**
             * FIXED (BUG-006): Push to array instead of overwriting.
             * If two signals fire in the same turn, both should queue.
             */
            if (!pendingSignalNudges.has(sessionID)) {
              pendingSignalNudges.set(sessionID, [])
            }
            pendingSignalNudges.get(sessionID)!.push(nudgeText)
            state.signalNudgeSent.add(signal)
          }
        }
      } catch {
        // Silent — do not leak errors into terminal
      }
    },

    // ─── 4. SESSION LIFECYCLE ─────────────────────────────────────────────
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        /**
         * CRITICAL FIX: Session ID Merge on session.idle
         *
         * Problem: messages.transform and tool.execute.after resolve DIFFERENT
         * session IDs for the same agent session. messages.transform gets a
         * fallback UUID (input.sessionID undefined), while tool.execute.after
         * sometimes gets the real session ID. This means monotonicTurnCount
         * and toolCallCount live on DIFFERENT Map entries, so nudge thresholds
         * (10 turns + 5 tool calls) can NEVER be reached.
         *
         * Solution: When session.idle fires with the real sessionID, scan all
         * sessions for fallback UUID entries that have activity (toolCallCount > 0
         * or monotonicTurnCount > 0). Merge their counters into the real session.
         */
        let state = sessions.get(sessionID)

        // Scan for active fallback sessions and merge their state
        for (const [key, fallbackState] of sessions) {
          if (key.startsWith("nudge-fallback-") && (fallbackState.toolCallCount > 0 || fallbackState.monotonicTurnCount > 0)) {
            if (!state) {
              // Promote the fallback session to the real session ID
              state = createSessionState()
              sessions.set(sessionID, state)
            }
            // Merge counters (take the max to avoid double-counting)
            state.monotonicTurnCount = Math.max(state.monotonicTurnCount, fallbackState.monotonicTurnCount)
            state.toolCallCount = Math.max(state.toolCallCount, fallbackState.toolCallCount)
            state.lastMemorySaveMonotonic = Math.max(state.lastMemorySaveMonotonic, fallbackState.lastMemorySaveMonotonic)
            state.lastNudgeMonotonic = Math.max(state.lastNudgeMonotonic, fallbackState.lastNudgeMonotonic)
            state.lastNudgeTimestamp = Math.max(state.lastNudgeTimestamp, fallbackState.lastNudgeTimestamp || 0)
            // Merge signalNudgeSent sets
            for (const sig of fallbackState.signalNudgeSent) {
              state.signalNudgeSent.add(sig)
            }
            // Merge pending signals
            const fallbackPending = pendingSignalNudges.get(key)
            if (fallbackPending && fallbackPending.length > 0) {
              if (!pendingSignalNudges.has(sessionID)) {
                pendingSignalNudges.set(sessionID, [])
              }
              pendingSignalNudges.get(sessionID)!.push(...fallbackPending)
            }
            // Clean up the fallback entry
            sessions.delete(key)
            pendingSignalNudges.delete(key)
          }
        }

        if (!state) return

        // Persist state before cleanup
        persistState(sessions)

        // Clean up session state
        sessions.delete(sessionID)
        pendingSignalNudges.delete(sessionID)
      }
    },
  }
}
