// ~/.config/opencode/plugins/opencode-vcc/utils/filter.ts

import type { NormalizedBlock } from "./normalize.js";

/**
 * Filter out noise from normalized blocks.
 * Removes system messages, empty blocks, and thinking blocks.
 */
export function filterBlocks(blocks: NormalizedBlock[]): NormalizedBlock[] {
  return blocks.filter((block) => {
    // Remove system messages
    if (block.role === "system") return false;
    // Remove empty content
    if (!block.content || block.content.trim().length === 0) return false;
    // Remove thinking blocks (not useful for extraction)
    if (block.role === "thinking") return false;
    return true;
  });
}

/**
 * Get only user blocks (for goal/preference extraction).
 */
export function getUserBlocks(blocks: NormalizedBlock[]): NormalizedBlock[] {
  return blocks.filter((b) => b.role === "user" && b.content.trim().length > 0);
}

/**
 * Get only tool call blocks (for file/commit extraction).
 */
export function getToolBlocks(blocks: NormalizedBlock[]): NormalizedBlock[] {
  return blocks.filter((b) => b.role === "tool_call" || b.role === "tool_result");
}

/**
 * Get last N blocks (for blocker detection).
 */
export function getLastNBlocks(blocks: NormalizedBlock[], n: number): NormalizedBlock[] {
  return blocks.slice(-n);
}
