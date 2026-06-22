import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.config', 'opencode', 'skill-telemetry.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  session_id TEXT,
  loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  load_context TEXT,
  duration_ms INTEGER,
  query TEXT,
  score REAL
);

CREATE TABLE IF NOT EXISTS skill_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  skill_count INTEGER,
  skill_names TEXT,
  total_loads INTEGER
);

CREATE INDEX IF NOT EXISTS idx_usage_skill ON skill_usage(skill_name);
CREATE INDEX IF NOT EXISTS idx_usage_time ON skill_usage(loaded_at);
`;

let singletonInstance = null;

class SkillTelemetry {
  constructor(dbPath = DB_PATH) {
    this.dbPath = dbPath;
    this.db = null;
    try {
      this.db = new Database(dbPath);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec(SCHEMA);
    } catch (err) {
      console.error('[SkillTelemetry] Failed to open DB:', err.message);
      this.db = null;
    }
  }

  trackLoad(skillName, { sessionId, context, query, score } = {}) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO skill_usage (skill_name, session_id, load_context, query, score)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(skillName, sessionId || null, context || 'manual', query || null, score || null);
    } catch (err) {
      console.error('[SkillTelemetry] trackLoad failed:', err.message);
    }
  }

  getSkillAnalytics(skillName) {
    if (!this.db) return null;
    try {
      const row = this.db.prepare(`
        SELECT
          skill_name AS name,
          COUNT(*) AS totalLoads,
          MIN(loaded_at) AS firstSeen,
          MAX(loaded_at) AS lastSeen
        FROM skill_usage
        WHERE skill_name = ?
      `).get(skillName);

      if (!row) return { name: skillName, totalLoads: 0, firstSeen: null, lastSeen: null, loadContexts: {}, recentSessions: [] };

      const contexts = this.db.prepare(`
        SELECT load_context, COUNT(*) AS count
        FROM skill_usage
        WHERE skill_name = ?
        GROUP BY load_context
      `).all(skillName);

      const loadContexts = {};
      for (const c of contexts) {
        loadContexts[c.load_context] = c.count;
      }

      const recentSessions = this.db.prepare(`
        SELECT session_id, loaded_at
        FROM skill_usage
        WHERE skill_name = ? AND session_id IS NOT NULL
        ORDER BY loaded_at DESC
        LIMIT 10
      `).all(skillName);

      return {
        name: row.name,
        totalLoads: row.totalLoads,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        loadContexts,
        recentSessions,
      };
    } catch (err) {
      console.error('[SkillTelemetry] getSkillAnalytics failed:', err.message);
      return null;
    }
  }

  getAllAnalytics() {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(`
        SELECT
          skill_name AS name,
          COUNT(*) AS totalLoads,
          MAX(loaded_at) AS lastSeen
        FROM skill_usage
        GROUP BY skill_name
        ORDER BY totalLoads DESC
      `).all();

      for (const row of rows) {
        const contexts = this.db.prepare(`
          SELECT load_context, COUNT(*) AS count
          FROM skill_usage
          WHERE skill_name = ?
          GROUP BY load_context
        `).all(row.name);
        row.loadContexts = {};
        for (const c of contexts) {
          row.loadContexts[c.load_context] = c.count;
        }
      }

      return rows;
    } catch (err) {
      console.error('[SkillTelemetry] getAllAnalytics failed:', err.message);
      return [];
    }
  }

  getSummary() {
    if (!this.db) return '[SkillTelemetry] DB unavailable';
    try {
      const totalSkills = this.db.prepare('SELECT COUNT(DISTINCT skill_name) AS count FROM skill_usage').get();
      const totalLoads = this.db.prepare('SELECT COUNT(*) AS count FROM skill_usage').get();
      const totalSessions = this.db.prepare('SELECT COUNT(DISTINCT session_id) AS count FROM skill_usage WHERE session_id IS NOT NULL').get();

      const topUsed = this.db.prepare(`
        SELECT skill_name, COUNT(*) AS count
        FROM skill_usage
        GROUP BY skill_name
        ORDER BY count DESC
        LIMIT 5
      `).all();

      const stale = this.db.prepare(`
        SELECT skill_name, MAX(loaded_at) AS lastSeen
        FROM skill_usage
        GROUP BY skill_name
        HAVING JULIANDAY('now') - JULIANDAY(MAX(loaded_at)) > 30
        ORDER BY lastSeen ASC
      `).all();

      const leastUsed = this.db.prepare(`
        SELECT skill_name, COUNT(*) AS count
        FROM skill_usage
        GROUP BY skill_name
        HAVING COUNT(*) <= 3
        ORDER BY count ASC
      `).all();

      const lines = [
        `Skills tracked: ${totalSkills.count}`,
        `Total loads: ${totalLoads.count}`,
        `Sessions tracked: ${totalSessions.count}`,
        '',
        `Top 5 most used: ${topUsed.map(s => `${s.skill_name} (${s.count})`).join(', ') || 'none'}`,
        '',
        `Stale (not loaded in 30+ days): ${stale.map(s => `${s.skill_name} (last: ${s.lastSeen})`).join(', ') || 'none'}`,
        '',
        `Least used (<=3 loads): ${leastUsed.map(s => `${s.skill_name} (${s.count})`).join(', ') || 'none'}`,
      ];

      return lines.join('\n');
    } catch (err) {
      console.error('[SkillTelemetry] getSummary failed:', err.message);
      return '[SkillTelemetry] Summary unavailable';
    }
  }

  takeSnapshot(skillMap) {
    if (!this.db) return;
    try {
      const names = Array.isArray(skillMap)
        ? skillMap
        : (skillMap instanceof Map ? Array.from(skillMap.keys()) : Object.keys(skillMap || {}));

      const totalLoads = this.db.prepare('SELECT COUNT(*) AS count FROM skill_usage').get();

      this.db.prepare(`
        INSERT INTO skill_snapshots (skill_count, skill_names, total_loads)
        VALUES (?, ?, ?)
      `).run(names.length, JSON.stringify(names), totalLoads.count);
    } catch (err) {
      console.error('[SkillTelemetry] takeSnapshot failed:', err.message);
    }
  }

  getUsageTrend(skillName) {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(`
        SELECT DATE(loaded_at) AS date, COUNT(*) AS count
        FROM skill_usage
        WHERE skill_name = ?
          AND loaded_at >= datetime('now', '-30 days')
        GROUP BY DATE(loaded_at)
        ORDER BY date ASC
      `).all(skillName);
      return rows;
    } catch (err) {
      console.error('[SkillTelemetry] getUsageTrend failed:', err.message);
      return [];
    }
  }

  getLeastUsed(threshold = 3) {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(`
        SELECT skill_name, COUNT(*) AS count
        FROM skill_usage
        GROUP BY skill_name
        HAVING COUNT(*) < ?
        ORDER BY count ASC
      `).all(threshold);
      return rows;
    } catch (err) {
      console.error('[SkillTelemetry] getLeastUsed failed:', err.message);
      return [];
    }
  }

  getStaleSkills(daysThreshold = 30) {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(`
        SELECT skill_name, MAX(loaded_at) AS lastSeen
        FROM skill_usage
        GROUP BY skill_name
        HAVING JULIANDAY('now') - JULIANDAY(MAX(loaded_at)) > ?
        ORDER BY lastSeen ASC
      `).all(daysThreshold);
      return rows;
    } catch (err) {
      console.error('[SkillTelemetry] getStaleSkills failed:', err.message);
      return [];
    }
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        console.error('[SkillTelemetry] close failed:', err.message);
      }
      this.db = null;
    }
  }
}

function getTelemetry() {
  if (!singletonInstance) {
    singletonInstance = new SkillTelemetry();
  }
  return singletonInstance;
}

export { SkillTelemetry, getTelemetry };
