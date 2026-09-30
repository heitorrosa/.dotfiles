// ~/.config/opencode/plugins/opencode-vcc/extraction/preferences.ts

import type { NormalizedBlock } from "../utils/normalize.js";
import { getUserBlocks } from "../utils/filter.js";

const PREFERENCE_PATTERNS = [
  /\b(?:prefer|i prefer|we prefer)\s+(.+)/i,
  /\b(?:don'?t want|do not want)\s+(.+)/i,
  /\b(?:always use|always use)\s+(.+)/i,
  /\b(?:never use|don'?t use)\s+(.+)/i,
  /\b(?:please use|use instead)\s+(.+)/i,
  /\b(?:instead of .+ use)\s+(.+)/i,
];

const MAX_PREFERENCES = 10;

/**
 * Extract user preferences from user message blocks.
 * Pattern matching for prefer/don't want/always use/never use/please use.
 */
export function extractPreferences(blocks: NormalizedBlock[]): string[] {
  const userBlocks = getUserBlocks(blocks);
  const preferences: string[] = [];
  const seen = new Set<string>();

  for (const block of userBlocks) {
    let foundInBlock = false;

    for (const pattern of PREFERENCE_PATTERNS) {
      if (preferences.length >= MAX_PREFERENCES) break;

      pattern.lastIndex = 0;
      const match = pattern.exec(block.content);
      if (match) {
        const pref = match[0].trim();
        if (!seen.has(pref) && pref.length > 5) {
          seen.add(pref);
          preferences.push(pref);
          foundInBlock = true;
        }
      }
    }

    // Cap: one preference per user block
    if (foundInBlock && preferences.length >= MAX_PREFERENCES) break;
  }

  return preferences;
}
