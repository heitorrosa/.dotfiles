// ~/.config/opencode/plugins/opencode-vcc/hooks/compacting.ts

import { normalizeMessages } from "../utils/normalize.js";
import { filterBlocks } from "../utils/filter.js";
import { extractGoals } from "../extraction/goals.js";
import { extractFiles } from "../extraction/files.js";
import { extractCommits } from "../extraction/commits.js";
import { extractPreferences } from "../extraction/preferences.js";
import { extractBlockers } from "../extraction/blockers.js";
import { generateTranscript } from "../extraction/transcript.js";
import { mergeSections } from "../utils/merge.js";
import { getDb } from "../storage/db.js";
import type { VCCSections } from "../utils/merge.js";

/**
 * experimental.session.compacting hook handler.
 *
 * CRITICAL: Only push to output.context[], NEVER replace output.prompt.
 * This preserves OpenCode's native compaction behavior while enriching it.
 *
 * SDK-independent: reads messages from SQLite (indexed by messages.transform)
 * instead of calling client.session.messages().
 */
export function createCompactingHook() {
  return async (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string }
  ) => {
    try {
      // 1. Read messages from SQLite (indexed by messages.transform hook)
      const db = getDb();
      const rows = db
        .query(
          `SELECT role, content, created_at FROM vcc_messages
           WHERE session_id = ?
           ORDER BY created_at ASC`
        )
        .all(input.sessionID) as { role: string; content: string; created_at: string }[];

      if (!rows || rows.length === 0) return;

      // 2. Convert SQLite rows to NormalizedBlock format
      const messages = rows.map((r) => ({
        info: { role: r.role, id: "", time: r.created_at },
        parts: [{ type: "text", text: r.content }],
      }));

      // 3. Normalize and filter
      const rawBlocks = normalizeMessages(messages);
      const blocks = filterBlocks(rawBlocks);

      if (blocks.length === 0) return;

      // 4. Run all extraction algorithms
      const { goals, scopeChanges } = extractGoals(blocks);
      const fileExtraction = extractFiles(blocks);
      const commits = extractCommits(blocks);
      const preferences = extractPreferences(blocks);
      const blockers = extractBlockers(blocks, goals);
      const transcript = generateTranscript(blocks);

      // 5. Merge with previous extraction (if exists)
      const prevRow = db
        .query("SELECT * FROM vcc_extractions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(input.sessionID) as any;

      const previous: VCCSections | null = prevRow
        ? {
            goals: JSON.parse(prevRow.goals_json ?? "[]"),
            scopeChanges: [],
            files: JSON.parse(prevRow.files_json ?? "[]"),
            commits: JSON.parse(prevRow.commits_json ?? "[]"),
            preferences: JSON.parse(prevRow.preferences_json ?? "[]"),
            blockers: JSON.parse(prevRow.blockers_json ?? "[]"),
            transcript: prevRow.transcript ?? "",
          }
        : null;

      const merged = mergeSections(previous, {
        goals,
        scopeChanges,
        files: fileExtraction.files,
        commits,
        preferences,
        blockers,
        transcript,
      });

      // 6. Store extraction for future merges
      db.run(
        `INSERT INTO vcc_extractions (session_id, goals_json, files_json, commits_json, preferences_json, blockers_json, transcript)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.sessionID,
          JSON.stringify(merged.goals),
          JSON.stringify(merged.files),
          JSON.stringify(merged.commits),
          JSON.stringify(merged.preferences),
          JSON.stringify(merged.blockers),
          merged.transcript,
        ]
      );

      // 7. Build context injection string
      const contextParts: string[] = [];

      if (merged.goals.length > 0) {
        contextParts.push(`## Session Goals\n${merged.goals.map((g) => `- ${g}`).join("\n")}`);
      }

      if (merged.scopeChanges.length > 0) {
        contextParts.push(`## Scope Changes\n${merged.scopeChanges.map((s) => `- ${s}`).join("\n")}`);
      }

      if (merged.files.length > 0) {
        const fileList = merged.files.map((f) => `- ${f.operation}: ${f.path}`).join("\n");
        contextParts.push(`## Files Modified\n${fileList}`);
      }

      if (merged.commits.length > 0) {
        const commitList = merged.commits.map((c) => `- ${c.hash ? c.hash.slice(0, 7) + " " : ""}${c.message}`).join("\n");
        contextParts.push(`## Commits\n${commitList}`);
      }

      if (merged.preferences.length > 0) {
        contextParts.push(`## User Preferences\n${merged.preferences.map((p) => `- ${p}`).join("\n")}`);
      }

      if (merged.blockers.length > 0) {
        contextParts.push(`## Outstanding Blockers\n${merged.blockers.map((b) => `- ${b}`).join("\n")}`);
      }

      if (merged.transcript) {
        contextParts.push(`## Brief Transcript\n${merged.transcript}`);
      }

      // 8. Inject into compaction context (PUSH, never replace)
      if (contextParts.length > 0) {
        output.context.push(
          `\n## VCC Extracted Context (from opencode-vcc plugin)\n\n${contextParts.join("\n\n")}`
        );
      }
    } catch (err) {
      // Plugin failure must never block compaction — silent
    }
  };
}
