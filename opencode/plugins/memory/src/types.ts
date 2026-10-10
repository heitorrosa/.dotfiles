// Shared types for opencode-hermes-memory plugin

export interface MemoryNudgeConfig {
  /** Nudge every N turns (default: 10). All other thresholds derive from this. */
  nudgeFrequency: number
  /** Detect persistable signals in tool output (default: true) */
  signalDetection: boolean
  /** Nudge on session.idle events (default: true) */
  sessionEndNudge: boolean
  /** Tools whose output should not trigger signal nudges */
  protectedTools: string[]
  /** Minimum tool calls before nudging starts (default: 5) */
  minToolCallsBeforeNudge: number
  /** "soft" = assistant messages, "strong" = user messages */
  nudgeForce: "soft" | "strong"
}

export interface SessionState {
  /** Monotonic counter — incremented on each hook call */
  monotonicTurnCount: number
  /** Last monotonic count at which a nudge was sent */
  lastNudgeMonotonic: number
  /** Tool call count */
  toolCallCount: number
  /** Monotonic count at last memory_save */
  lastMemorySaveMonotonic: number
  /** Signal types already sent this session */
  signalNudgeSent: Set<string>
  /** Timestamp of last nudge injection (for cooldown) */
  lastNudgeTimestamp: number
  /** Monotonic count at last memory_search */
  lastMemorySearchMonotonic: number
  /** Monotonic count at last skill() load */
  lastSkillLoadMonotonic: number
  /** Total memory_search calls this session */
  memorySearchCount: number
  /** Total skill() loads this session */
  skillLoadCount: number
  /** Count of detected task completions */
  taskCompletionCount: number
}

export interface TextPart {
  type: "text"
  text: string
}

/** V2 session-hook message shape ({role, content} — V1's {info, parts} is gone). */
export interface Message {
  id?: string
  role: string
  content: Array<TextPart | { type: string; [key: string]: unknown }>
}

/** Minimal shape of a V2 tool `execute.after` result, for text extraction. */
export interface ToolResultLike {
  content?: string | ReadonlyArray<{ type?: string; text?: string; [key: string]: unknown }>
  output?: unknown
  metadata?: Record<string, unknown>
}

/**
 * A V2 plugin tool definition as produced by createMemoryTools/createSkillTools,
 * registered via ctx.tool.transform(editor => editor.add(...)).
 */
export interface ToolDef {
  name: string
  description: string
  input: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: boolean
  }
  execute: (
    input: Record<string, any>,
    context?: { sessionID?: string; messageID?: string; agent?: string }
  ) => Promise<{ content: string }>
}

export function createSessionState(): SessionState {
  return {
    monotonicTurnCount: 0,
    lastNudgeMonotonic: 0,
    toolCallCount: 0,
    lastMemorySaveMonotonic: -1,
    signalNudgeSent: new Set(),
    lastNudgeTimestamp: 0,
    lastMemorySearchMonotonic: -1,
    lastSkillLoadMonotonic: -1,
    memorySearchCount: 0,
    skillLoadCount: 0,
    taskCompletionCount: 0,
  }
}


