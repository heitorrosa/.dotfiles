// ~/.config/opencode/plugins/opencode-vcc/extraction/commits.ts

import type { NormalizedBlock } from "../utils/normalize.js";
import { getToolBlocks } from "../utils/filter.js";

const COMMIT_MSG_REGEX = /git\s+commit\s+(?:-[a-z]+\s+)*-m\s+["'](.+?)["']/g;
const COMMIT_HASH_REGEX = /\b([0-9a-f]{7,40})\b/;

export interface CommitRecord {
  hash: string;
  message: string;
}

/**
 * Extract git commits from tool blocks.
 * Regex for git commit -m "..." patterns, extracts hash from following tool_result.
 */
export function extractCommits(blocks: NormalizedBlock[]): CommitRecord[] {
  const toolBlocks = getToolBlocks(blocks);
  const commits: CommitRecord[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < toolBlocks.length; i++) {
    const block = toolBlocks[i];

    // Find commit messages in tool calls
    if (block.role === "tool_call") {
      let match;
      COMMIT_MSG_REGEX.lastIndex = 0;
      while ((match = COMMIT_MSG_REGEX.exec(block.content)) !== null) {
        const message = match[1];

        // Look for hash in the following tool_result
        let hash = "";
        if (i + 1 < toolBlocks.length && toolBlocks[i + 1].role === "tool_result") {
          const hashMatch = COMMIT_HASH_REGEX.exec(toolBlocks[i + 1].content);
          if (hashMatch) hash = hashMatch[1];
        }

        const key = `${message}::${hash}`;
        if (!seen.has(key)) {
          seen.add(key);
          commits.push({ hash, message });
        }
      }
    }
  }

  return commits;
}
