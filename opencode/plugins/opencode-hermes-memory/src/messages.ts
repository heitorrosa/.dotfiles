import type { Message, TextPart } from "./types.js"

export function findLastUserMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") return messages[i]
  }
  return null
}

export function findLastAssistantMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "assistant") return messages[i]
  }
  return null
}

export function injectNudgeIntoMessage(message: Message, nudge: string): void {
  const existing = message.parts.find((p) => p.type === "text") as TextPart | undefined
  if (existing) {
    // Append if already has content, prepend otherwise
    const trimmed = existing.text.trim()
    // Cache stability: if this exact nudge is already present (message was
    // already sent to the provider), do NOT touch it - re-stripping and
    // re-appending changes bytes and breaks prefix-cache hits on the next turn.
    if (trimmed.includes(nudge)) return
    if (trimmed.includes("[Hermes Memory")) {
      // Already has a nudge — replace it
      existing.text = existing.text.replace(
        /\n*<system-reminder>\[Hermes Memory[^\]]*\]<\/system-reminder>\n*/g,
        ""
      )
    }
    existing.text = existing.text.trimEnd() + "\n" + nudge
  } else {
    message.parts.push({ type: "text", text: nudge })
  }
}

/**
 * Inject nudge into assistant message, falling back to user message.
 */
export function dualInject(messages: Message[], nudge: string): boolean {
  const target = findLastAssistantMessage(messages) || findLastUserMessage(messages)
  if (!target) return false
  injectNudgeIntoMessage(target, nudge)
  return true
}
