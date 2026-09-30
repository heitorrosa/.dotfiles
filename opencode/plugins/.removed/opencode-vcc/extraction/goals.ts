// ~/.config/opencode/plugins/opencode-vcc/extraction/goals.ts

import type { NormalizedBlock } from "../utils/normalize.js";
import { getUserBlocks } from "../utils/filter.js";

const TASK_KEYWORDS = /\b(fix|implement|add|create|build|refactor|update|remove|delete|modify|write|debug|test|deploy|configure|setup|install|migrate|optimize|review|analyze|design|plan)\b/i;

const SCOPE_CHANGE_MARKERS = /\b(instead|actually|change of plan|pivot|wait no|never mind|forget that|let me rephrase|new approach|different strategy|on second thought)\b/i;

const MAX_GOAL_LINES = 6;
const MAX_SCOPE_CHANGES = 2;
const MAX_TOTAL_GOALS = 8;

export interface GoalExtraction {
  goals: string[];
  scopeChanges: string[];
}

/**
 * Extract session goals from user messages.
 * First user message → up to 6 goal lines, scope-change markers, cap at 8 total.
 */
export function extractGoals(blocks: NormalizedBlock[]): GoalExtraction {
  const userBlocks = getUserBlocks(blocks);
  const goals: string[] = [];
  const scopeChanges: string[] = [];

  if (userBlocks.length === 0) {
    return { goals, scopeChanges };
  }

  // Process first user message for primary goal
  const firstMessage = userBlocks[0].content;
  const lines = firstMessage.split("\n").filter((l) => l.trim().length > 0);

  let goalCount = 0;
  for (const line of lines) {
    if (goalCount >= MAX_GOAL_LINES) break;

    const trimmed = line.trim();
    if (TASK_KEYWORDS.test(trimmed)) {
      goals.push(trimmed);
      goalCount++;
    }
  }

  // If no task keywords found, use the first line as the goal
  if (goals.length === 0 && lines.length > 0) {
    goals.push(lines[0].trim().slice(0, 200));
  }

  // Scan subsequent user messages for scope changes
  let scopeCount = 0;
  for (let i = 1; i < userBlocks.length && scopeCount < MAX_SCOPE_CHANGES; i++) {
    const content = userBlocks[i].content;
    const contentLines = content.split("\n").filter((l) => l.trim().length > 0);

    for (const line of contentLines) {
      if (SCOPE_CHANGE_MARKERS.test(line)) {
        scopeChanges.push(line.trim().slice(0, 200));
        scopeCount++;
        break; // One scope change per user block
      }
    }
  }

  // Cap total
  const total = goals.length + scopeChanges.length;
  if (total > MAX_TOTAL_GOALS) {
    goals.length = Math.min(goals.length, MAX_TOTAL_GOALS - scopeChanges.length);
  }

  return { goals, scopeChanges };
}
