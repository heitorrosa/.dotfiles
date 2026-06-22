// ~/.config/opencode/plugins/opencode-vcc/extraction/blockers.ts

import type { NormalizedBlock } from "../utils/normalize.js";
import { getLastNBlocks, getUserBlocks } from "../utils/filter.js";

const BLOCKER_KEYWORDS = /\b(fail|failed|broken|cannot|can't|blocked|error|error:|exception|stuck|issue|problem|bug|warning|not working|doesn'?t work|won'?t work)\b/i;

const MAX_BLOCKER_LENGTH = 200;
const MIN_BLOCKER_LENGTH = 15;
const MAX_BLOCKERS = 5;
const SCAN_LAST_N_BLOCKS = 20;

/**
 * Detect outstanding blockers from recent blocks.
 * Scans last 20 blocks, require >15 chars, cap at 5.
 */
export function extractBlockers(
  allBlocks: NormalizedBlock[],
  goalTexts: string[] = []
): string[] {
  const recentBlocks = getLastNBlocks(allBlocks, SCAN_LAST_N_BLOCKS);
  const blockers: string[] = [];
  const seen = new Set<string>();

  for (const block of recentBlocks) {
    if (blockers.length >= MAX_BLOCKERS) break;

    const lines = block.content.split("\n");
    for (const line of lines) {
      if (blockers.length >= MAX_BLOCKERS) break;

      const trimmed = line.trim();
      if (trimmed.length < MIN_BLOCKER_LENGTH) continue;
      if (trimmed.length > MAX_BLOCKER_LENGTH) continue;

      if (BLOCKER_KEYWORDS.test(trimmed)) {
        // Don't duplicate goal text
        const isGoal = goalTexts.some((g) => trimmed.includes(g) || g.includes(trimmed));
        if (!isGoal && !seen.has(trimmed)) {
          seen.add(trimmed);
          blockers.push(trimmed);
        }
      }
    }
  }

  return blockers;
}
