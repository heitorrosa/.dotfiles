// ~/.config/opencode/plugins/opencode-vcc/test/smoke.ts

import { getDb, closeDb } from "../storage/db.js";
import { indexMessage, search, getMessageCount } from "../search/bm25.js";
import { extractGoals } from "../extraction/goals.js";
import { extractFiles } from "../extraction/files.js";
import { extractCommits } from "../extraction/commits.js";
import { extractPreferences } from "../extraction/preferences.js";
import { extractBlockers } from "../extraction/blockers.js";
import { generateTranscript } from "../extraction/transcript.js";
import { normalizeMessages } from "../utils/normalize.js";
import { filterBlocks } from "../utils/filter.js";
import { mergeSections } from "../utils/merge.js";
import type { VCCSections } from "../utils/merge.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

// Test 1: DB initialization
console.log("--- Storage ---");
const db = getDb();
// Clean up any prior test data
db.run("DELETE FROM vcc_messages WHERE session_id = 'test-smoke'");
assert(db !== null, "Database initialized");
const version = db.query("SELECT MAX(version) as v FROM vcc_schema_version").get() as any;
assert(version.v === 1, `Schema version is 1 (got ${version.v})`);

// Test 2: FTS5 indexing and search
console.log("\n--- BM25 Search ---");
indexMessage("test-smoke", "m1", "user", "Fix the login bug in auth.ts", "2026-05-30T10:00:00Z");
indexMessage("test-smoke", "m2", "assistant", "I edited auth.ts to fix the login issue", "2026-05-30T10:01:00Z");
indexMessage("test-smoke", "m3", "user", "Now implement the dashboard feature", "2026-05-30T10:02:00Z");
const count = getMessageCount("test-smoke");
assert(count === 3, `Indexed 3 messages (got ${count})`);

const results = search("fix login bug");
assert(results.length >= 1, `Search returned results (got ${results.length})`);
assert(results[0].content.includes("auth.ts"), "Top result mentions auth.ts");

// Test 3: Goal extraction
console.log("\n--- Goal Extraction ---");
const { goals, scopeChanges } = extractGoals([
  { role: "user", content: "Fix the login bug and implement dashboard" },
  { role: "user", content: "Actually, change of plan — just fix login first" },
]);
assert(goals.length >= 1, `Goals extracted (got ${goals.length})`);
assert(scopeChanges.length >= 1, `Scope changes detected (got ${scopeChanges.length})`);

// Test 4: File extraction
console.log("\n--- File Extraction ---");
const fileResult = extractFiles([
  { role: "tool_call", content: '{"path":"src/auth.ts"}', toolName: "read" },
  { role: "tool_call", content: '{"path":"src/auth.ts"}', toolName: "edit" },
]);
assert(fileResult.files.length >= 1, `Files extracted (got ${fileResult.files.length})`);

// Test 5: Commit extraction
console.log("\n--- Commit Extraction ---");
const commits = extractCommits([
  { role: "tool_call", content: 'git commit -m "fix login bug"', toolName: "bash" },
  { role: "tool_result", content: "[main abc1234] fix login bug" },
]);
assert(commits.length === 1, `Commit extracted (got ${commits.length})`);
assert(commits[0].hash === "abc1234", `Hash extracted (got ${commits[0].hash})`);

// Test 6: Preference extraction
console.log("\n--- Preference Extraction ---");
const prefs = extractPreferences([
  { role: "user", content: "Please use TypeScript instead of JavaScript" },
  { role: "user", content: "Don't use any" },
]);
assert(prefs.length >= 1, `Preferences extracted (got ${prefs.length})`);

// Test 7: Blocker extraction
console.log("\n--- Blocker Extraction ---");
const blockers = extractBlockers([
  { role: "assistant", content: "The build is failing with error in module.ts" },
]);
assert(blockers.length >= 1, `Blockers extracted (got ${blockers.length})`);

// Test 8: Transcript
console.log("\n--- Transcript ---");
const transcript = generateTranscript([
  { role: "user", content: "Fix the bug" },
  { role: "assistant", content: "I'll fix it now" },
  { role: "tool_call", content: '{"file":"test.ts"}', toolName: "edit" },
]);
assert(transcript.length > 0, `Transcript generated (length: ${transcript.length})`);

// Test 9: Merge
console.log("\n--- Merge ---");
const prev: VCCSections = {
  goals: ["fix login"],
  scopeChanges: [],
  files: [{ path: "a.ts", operation: "write" }],
  commits: [],
  preferences: ["use TS"],
  blockers: [],
  transcript: "old",
};
const curr: VCCSections = {
  goals: ["fix login", "add dashboard"],
  scopeChanges: ["change of plan"],
  files: [{ path: "b.ts", operation: "write" }],
  commits: [{ hash: "abc", message: "fix" }],
  preferences: ["use TS"],
  blockers: ["build failing"],
  transcript: "new",
};
const merged = mergeSections(prev, curr);
assert(merged.goals.length === 2, `Merged goals (got ${merged.goals.length})`);
assert(merged.files.length === 2, `Merged files (got ${merged.files.length})`);
assert(merged.preferences.length === 1, `Deduped preferences (got ${merged.preferences.length})`);
assert(merged.transcript === "new", "Transcript replaced (not merged)");

// Cleanup
closeDb();
console.log("\n✅ All smoke tests passed!");
