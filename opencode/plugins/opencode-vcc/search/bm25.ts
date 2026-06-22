// ~/.config/opencode/plugins/opencode-vcc/search/bm25.ts

import { getDb } from "../storage/db.js";

const BM25_K = 1.2;
const BM25_B = 0.75;
const STOPWORDS = new Set([
  "a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of",
  "and", "or", "but", "not", "with", "this", "that", "from", "by",
  "as", "be", "was", "were", "are", "have", "has", "had", "do",
  "does", "did", "will", "would", "could", "should", "may", "might",
  "can", "shall", "i", "you", "he", "she", "we", "they", "me",
  "him", "her", "us", "them", "my", "your", "his", "its", "our",
  "their", "what", "which", "who", "whom", "where", "when", "why",
  "how", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "no", "nor", "too", "very", "just",
  "about", "above", "after", "again", "also", "am", "an", "any",
  "because", "been", "before", "being", "below", "between",
  "down", "during", "here", "if", "into", "only", "own", "same",
  "so", "than", "then", "there", "these", "through", "under",
  "until", "up", "while",
]);

export interface SearchResult {
  session_id: string;
  entry_id: string;
  role: string;
  content: string;
  created_at: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  sessionId?: string;
  regex?: boolean;
  offset?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function search(
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const { limit = 5, sessionId, regex = false, offset = 0 } = options;
  const db = getDb();

  // If regex mode, use FTS5's regex-like matching via LIKE
  if (regex) {
    const rows = db
      .query(
        `SELECT session_id, entry_id, role, content, created_at, 1.0 as score
         FROM vcc_messages
         WHERE content LIKE ?
         ${sessionId ? "AND session_id = ?" : ""}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(
        `%${query}%`,
        ...(sessionId ? [sessionId] : []),
        limit,
        offset
      ) as SearchResult[];
    return rows;
  }

  // BM25 search using FTS5's built-in rank
  // FTS5 bm25() returns negative scores (lower = better), we negate for display
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // Build FTS5 query with OR semantics
  const ftsQuery = tokens.map((t) => `"${t}"`).join(" OR ");

  const rows = db
    .query(
      `SELECT session_id, entry_id, role, content, created_at,
              -bm25(vcc_messages) as score
       FROM vcc_messages
       WHERE vcc_messages MATCH ?
       ${sessionId ? "AND session_id = ?" : ""}
       ORDER BY score DESC
       LIMIT ? OFFSET ?`
    )
    .all(ftsQuery, ...(sessionId ? [sessionId] : []), limit, offset) as SearchResult[];

  return rows;
}

export function indexMessage(
  sessionId: string,
  entryId: string,
  role: string,
  content: string,
  createdAt: string
): void {
  const db = getDb();
  db.run(
    `INSERT INTO vcc_messages (session_id, entry_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, entryId, role, content.slice(0, 10000), createdAt] // Cap content at 10KB
  );
}

export function getMessageCount(sessionId: string): number {
  const db = getDb();
  const row = db
    .query("SELECT COUNT(*) as cnt FROM vcc_messages WHERE session_id = ?")
    .get(sessionId) as { cnt: number };
  return row.cnt;
}
