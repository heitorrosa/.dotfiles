// ~/.config/opencode/plugins/opencode-vcc/hooks/messages.ts

import { getDb } from "../storage/db.js";
import { indexMessage } from "../search/bm25.js";

/**
 * experimental.chat.messages.transform hook handler.
 *
 * Two responsibilities:
 * 1. Index messages into FTS5 on every LLM call (side effect)
 * 2. Prepend VCC summary context after compaction detected
 *
 * CRITICAL: Only APPEND/PREPEND to output.messages, NEVER modify existing messages.
 */
export function createMessagesTransformHook() {
  return async (
    input: { sessionID?: string },
    output: {
      messages: { info: any; parts: any[] }[];
    }
  ) => {
    try {
      if (!output.messages || output.messages.length === 0) return;

      const sessionId = input.sessionID || "unknown";

      // 1. Index all messages into FTS5 (side effect for vcc_recall)
      for (const msg of output.messages) {
        const role = msg.info?.role || "unknown";
        const msgId = msg.info?.id || `msg-${Date.now()}`;

        for (const part of msg.parts || []) {
          if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
            indexMessage(sessionId, msgId, role, part.text, new Date().toISOString());
          }
        }
      }

      // 2. Detect compaction and inject VCC context
      const hasCompaction = output.messages.some((m) =>
        m.parts?.some((p: any) => p.type === "text" && typeof p.text === "string" && p.text.includes("compacted"))
      );

      if (!hasCompaction) return;

      // Get the most recent extraction for context continuity
      const db = getDb();
      const latestExtraction = db
        .query("SELECT * FROM vcc_extractions ORDER BY created_at DESC LIMIT 1")
        .get() as any;

      if (!latestExtraction) return;

      // Build VCC context message
      const sections: string[] = [];
      const goals = JSON.parse(latestExtraction.goals_json ?? "[]");
      if (goals.length) sections.push(`Goals: ${goals.join("; ")}`);

      const files = JSON.parse(latestExtraction.files_json ?? "[]");
      if (files.length) {
        const fileList = files.slice(0, 10).map((f: any) => f.path).join(", ");
        sections.push(`Active files: ${fileList}`);
      }

      const blockers = JSON.parse(latestExtraction.blockers_json ?? "[]");
      if (blockers.length) sections.push(`Blockers: ${blockers.join("; ")}`);

      if (sections.length === 0) return;

      // Append VCC context as a system-level note
      const vccMessage = {
        info: {
          role: "system",
          id: `vcc-context-${Date.now()}`,
        },
        parts: [
          {
            type: "text",
            text: `[VCC Context — from previous compaction]\n${sections.join("\n")}`,
          },
        ],
      };

      // Prepend (insert at index 0)
      output.messages.unshift(vccMessage);
    } catch (err) {
      // Must never block message flow — silent
    }
  };
}
