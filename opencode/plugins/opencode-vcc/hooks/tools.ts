// ~/.config/opencode/plugins/opencode-vcc/hooks/tools.ts

import { search, getMessageCount } from "../search/bm25.js";
import { getDb } from "../storage/db.js";

/**
 * vcc_recall: Search historical messages and summaries across sessions.
 * Uses BM25 search on indexed messages via FTS5.
 */
export const vcc_recall = {
  description:
    "Search historical conversation messages and VCC summaries across sessions using BM25 text search. Use when you need to recall context from earlier in this session or previous sessions.",
  args: {
    query: { type: "string", description: "Search query (supports natural language or regex)" },
    sessionId: { type: "string", description: "Optional: restrict search to a specific session ID" },
    limit: { type: "number", description: "Max results to return (default: 5, max: 20)" },
    regex: { type: "boolean", description: "Treat query as regex pattern (default: false)" },
  },
  async execute(args: any, _ctx: any) {
    const limit = Math.min(args.limit ?? 5, 20);

    const results = search(args.query, {
      limit,
      sessionId: args.sessionId,
      regex: args.regex ?? false,
    });

    if (results.length === 0) {
      return `No results found for "${args.query}".`;
    }

    const formatted = results.map((r: any, i: number) => {
      const preview = r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content;
      return `### Result ${i + 1} (score: ${r.score.toFixed(2)})
**Session:** ${r.session_id} | **Role:** ${r.role} | **Time:** ${r.created_at}
${preview}`;
    });

    return `## VCC Recall: "${args.query}"\n\n${formatted.join("\n\n")}`;
  },
};

/**
 * vcc_compact: Manually trigger VCC extraction and compaction.
 */
export const vcc_compact = {
  description:
    "Manually trigger VCC session compaction. Extracts goals, files, commits, preferences, and blockers from the current conversation and stores a structured summary.",
  args: {
    sessionId: { type: "string", description: "Session ID to compact (defaults to current session)" },
  },
  async execute(args: any, ctx: any) {
    const sessionId = args.sessionId || ctx.sessionID || "unknown";
    const db = getDb();

    const existing = db
      .query("SELECT COUNT(*) as cnt FROM vcc_extractions WHERE session_id = ?")
      .get(sessionId) as { cnt: number };

    return `VCC compaction triggered for session ${sessionId}. ` +
      `Previous extractions: ${existing.cnt}. ` +
      `The compaction hook will run on the next automatic or manual compact.`;
  },
};

/**
 * vcc_preview: Show what VCC extraction would produce for current context.
 */
export const vcc_preview = {
  description:
    "Preview what VCC would extract from the current conversation. Shows goals, files, commits, preferences, and blockers without storing anything.",
  args: {},
  async execute(_args: any, ctx: any) {
    const db = getDb();
    const sessionId = ctx?.sessionID || "unknown";

    const row = db
      .query("SELECT * FROM vcc_extractions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as any;

    if (!row) {
      return "No VCC extraction found for this session yet. Extraction runs automatically during compaction.";
    }

    const sections: string[] = [];

    const goals = JSON.parse(row.goals_json ?? "[]");
    if (goals.length) sections.push(`## Goals\n${goals.map((g: string) => `- ${g}`).join("\n")}`);

    const files = JSON.parse(row.files_json ?? "[]");
    if (files.length) sections.push(`## Files\n${files.map((f: any) => `- ${f.operation}: ${f.path}`).join("\n")}`);

    const commits = JSON.parse(row.commits_json ?? "[]");
    if (commits.length) sections.push(`## Commits\n${commits.map((c: any) => `- ${c.hash?.slice(0, 7) ?? "?"} ${c.message}`).join("\n")}`);

    const prefs = JSON.parse(row.preferences_json ?? "[]");
    if (prefs.length) sections.push(`## Preferences\n${prefs.map((p: string) => `- ${p}`).join("\n")}`);

    const blockers = JSON.parse(row.blockers_json ?? "[]");
    if (blockers.length) sections.push(`## Blockers\n${blockers.map((b: string) => `- ${b}`).join("\n")}`);

    if (row.transcript) sections.push(`## Transcript\n${row.transcript}`);

    const msgCount = getMessageCount(sessionId);
    sections.push(`---\n*Indexed messages: ${msgCount} | Last extraction: ${row.created_at}*`);

    return sections.length > 1
      ? `# VCC Preview for session ${sessionId}\n\n${sections.join("\n\n")}`
      : `No extraction data found for session ${sessionId}.`;
  },
};
