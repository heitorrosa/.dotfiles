// ~/.config/opencode/plugins/opencode-vcc/extraction/transcript.ts

import type { NormalizedBlock } from "../utils/normalize.js";

const MAX_TRANSCRIPT_LINES = 120;
const MAX_LINE_LENGTH = 200;
const TOKEN_BUDGET = 4000; // ~4K tokens for transcript section

/**
 * Generate a brief transcript from normalized blocks.
 * Rolling window of ~120 lines, tool calls collapsed to one-liners, token budget truncation.
 */
export function generateTranscript(blocks: NormalizedBlock[]): string {
  const lines: string[] = [];
  let charCount = 0;

  // Take last MAX_TRANSCRIPT_LINES blocks
  const window = blocks.slice(-MAX_TRANSCRIPT_LINES);

  for (const block of window) {
    const line = formatBlock(block);
    if (!line) continue;

    const truncated = line.length > MAX_LINE_LENGTH
      ? line.slice(0, MAX_LINE_LENGTH) + "..."
      : line;

    // Token budget check (rough: 1 token ≈ 4 chars)
    const estimatedTokens = (charCount + truncated.length) / 4;
    if (estimatedTokens > TOKEN_BUDGET) break;

    lines.push(truncated);
    charCount += truncated.length;
  }

  return lines.join("\n");
}

function formatBlock(block: NormalizedBlock): string {
  switch (block.role) {
    case "user":
      return `> ${block.content.split("\n")[0].slice(0, MAX_LINE_LENGTH)}`;
    case "assistant":
      return block.content.split("\n")[0].slice(0, MAX_LINE_LENGTH);
    case "tool_call": {
      const args = block.content.length > 80
        ? block.content.slice(0, 80) + "..."
        : block.content;
      return `  [${block.toolName ?? "tool"}] ${args}`;
    }
    case "tool_result": {
      const result = block.content.split("\n")[0].slice(0, 150);
      return `  → ${result}`;
    }
    default:
      return "";
  }
}
