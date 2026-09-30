// ~/.config/opencode/plugins/opencode-vcc/utils/normalize.ts

/**
 * Normalized block representing a single piece of a message.
 */
export interface NormalizedBlock {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "thinking" | "system";
  content: string;
  toolName?: string;
  timestamp?: string;
}

/**
 * Normalize OpenCode messages into uniform blocks for extraction.
 * Maps Part types to block roles.
 *
 * Works with plain objects — no SDK type dependencies.
 */
export function normalizeMessages(
  messages: { info: any; parts: any[] }[]
): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];

  for (const msg of messages) {
    const role = msg.info?.role || "unknown";

    for (const part of msg.parts || []) {
      const block = normalizePart(role, part, msg.info);
      if (block) blocks.push(block);
    }
  }

  return blocks;
}

function normalizePart(
  role: string,
  part: any,
  info: any
): NormalizedBlock | null {
  const timestamp = info?.time ? String(info.time) : undefined;

  if (part.type === "text") {
    return {
      role: role as "user" | "assistant",
      content: typeof part.text === "string" ? part.text : "",
      timestamp,
    };
  }

  if (part.type === "tool-invocation") {
    const toolName = part.toolInvocation?.toolName ?? "unknown";
    const state = part.toolInvocation?.state;

    if (state === "result") {
      return {
        role: "tool_result",
        content: typeof part.toolInvocation?.result === "string"
          ? part.toolInvocation.result
          : JSON.stringify(part.toolInvocation?.result ?? ""),
        toolName,
        timestamp,
      };
    }

    return {
      role: "tool_call",
      content: typeof part.toolInvocation?.args === "object"
        ? JSON.stringify(part.toolInvocation.args)
        : String(part.toolInvocation?.args ?? ""),
      toolName,
      timestamp,
    };
  }

  if (part.type === "reasoning") {
    return {
      role: "thinking",
      content: typeof part.reasoning === "string" ? part.reasoning : "",
      timestamp,
    };
  }

  return null;
}
