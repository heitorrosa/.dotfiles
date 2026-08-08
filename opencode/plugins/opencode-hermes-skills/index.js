// skill-engine/index.js
// Provides custom skill/skill_list/skill_analytics tools with BM25 search
// and usage telemetry. Overrides native frozen skill cache.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { BM25Index } from './bm25-index.js';
import { getTelemetry } from './skill-telemetry.js';

// Cache: Map<name, { name, description, path, content, dir }>
let skillCache = new Map();
let lastRefreshTime = 0;
const DEBOUNCE_MS = 30000;

// Cache stability: the <available_skills> XML injected into the SYSTEM PROMPT
// must be byte-stable within a session or provider prefix-cache hits die.
// session.idle fires after EVERY assistant turn; refreshing on idle meant any
// skill_create/skill_update mid-session changed the system prompt on the next
// request. We now freeze the rendered XML per sessionID: new sessions get a
// fresh list, existing sessions keep the exact bytes they started with.
let xmlCache = new Map(); // sessionID -> rendered <available_skills> XML
let xmlCacheRefresh = 0; // last time the global list was scanned
const XML_CACHE_MAX = 64;

// BM25 index and telemetry (initialized on first refresh)
let bm25 = null;
let telemetry = null;

// --- Utility ---

/**
 * Parse YAML frontmatter from skill content.
 * FIXED (BUG-007): Handle multiline YAML values using | and > syntax.
 * Previously: Only captured single-line values, breaking on multiline descriptions.
 * Fix: Detect | (literal block) and > (folded block) indicators and collect
 * indented continuation lines until a non-indented line or end of frontmatter.
 */
function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result = {};
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;

    const key = line.slice(0, colonIdx).trim();
    if (key !== 'name' && key !== 'description') continue;

    let value = line.slice(colonIdx + 1).trim();

    // FIXED (BUG-007): Handle multiline YAML syntax
    if (value === '|' || value === '>') {
      // Literal or folded block — collect indented continuation lines
      const isLiteral = value === '|';
      const blockLines = [];
      i++; // move to first continuation line
      while (i < lines.length) {
        const contLine = lines[i];
        // Empty lines are included in literal blocks, skipped in folded
        if (contLine.trim() === '') {
          if (isLiteral) blockLines.push('');
          i++;
          continue;
        }
        // Check if line is indented (continuation of block)
        if (/^\s+/.test(contLine)) {
          blockLines.push(isLiteral ? contLine.trimEnd() : contLine.trim());
          i++;
        } else {
          break; // non-indented line = end of block
        }
      }
      value = isLiteral ? blockLines.join('\n') : blockLines.join(' ');
      i--; // back up one since outer loop will increment
    }

    // FIXED (BUG-013): Strip surrounding quotes from values
    value = value.replace(/^['"]|['"]$/g, '').trim();

    if (value) result[key] = value;
  }

  return result.name ? result : null;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shouldRefresh() {
  const now = Date.now();
  if (now - lastRefreshTime < DEBOUNCE_MS) return false;
  lastRefreshTime = now;
  return true;
}

// --- Directory Scanning ---

function findSkillDirsRecursive(dir, results, currentDepth, maxDepth) {
  if (currentDepth >= maxDepth) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const candidates = [
        path.join(fullPath, '.opencode', 'skills'),
        path.join(fullPath, '.opencode', 'skill'),
        path.join(fullPath, 'skills'),
        path.join(fullPath, 'skill'),
      ];
      for (const skillsDir of candidates) {
        if (fs.existsSync(skillsDir)) results.push(skillsDir);
      }
      findSkillDirsRecursive(fullPath, results, currentDepth + 1, maxDepth);
    }
  } catch (e) { /* skip */ }
}

function getSkillDirs(ctxDir) {
  const dirs = [];
  dirs.push(path.join(os.homedir(), '.config', 'opencode', 'skills'));
  if (ctxDir) {
    for (const sub of ['.opencode/skills', '.opencode/skill', 'skills', 'skill']) {
      const dir = path.join(ctxDir, sub);
      if (fs.existsSync(dir)) dirs.push(dir);
    }
  }
  const cacheBase = path.join(os.homedir(), '.cache', 'opencode', 'packages');
  try { findSkillDirsRecursive(cacheBase, dirs, 0, 8); } catch (e) { /* no cache */ }
  return dirs;
}

function scanSkillDirs(ctxDir) {
  const dirs = getSkillDirs(ctxDir);
  const skills = new Map();
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(dir, entry.name, 'SKILL.md');
        try {
          if (!fs.existsSync(skillPath)) continue;
          const content = fs.readFileSync(skillPath, 'utf8');
          const parsed = parseSkillFrontmatter(content);
          if (parsed) {
            const skillName = parsed.name || entry.name;
            if (!skills.has(skillName)) {
              skills.set(skillName, {
                name: skillName,
                description: parsed.description || 'No description provided',
                path: skillPath,
                content: content,
                dir: path.dirname(skillPath),
              });
            }
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  return skills;
}

// --- Bundled Files Discovery ---

function discoverBundledFiles(skillDir) {
  const files = [];
  const subdirs = ['scripts', 'references', 'assets'];
  for (const sub of subdirs) {
    const subPath = path.join(skillDir, sub);
    try {
      if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
        const entries = fs.readdirSync(subPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) files.push(path.join(sub, entry.name));
        }
      }
    } catch (e) { /* skip */ }
  }
  try {
    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(js|ts|py|sh)$/.test(entry.name)) files.push(entry.name);
    }
  } catch (e) { /* skip */ }
  return files;
}

// --- XML/Description Generation ---

function generateSkillsXml(skills) {
  if (skills.size === 0) return '';
  let xml = '<available_skills>\n';
  for (const [name, skill] of skills) {
    xml += '  <skill>\n';
    xml += '    <name>' + escapeXml(skill.name) + '</name>\n';
    xml += '    <description>' + escapeXml(skill.description) + '</description>\n';
    xml += '  </skill>\n';
  }
  xml += '</available_skills>';
  return xml;
}

function generateToolDescription(skills) {
  let desc = `Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.

Use this tool to inject the skill's instructions and resources into current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill.

The skill name must match one of the skills listed in your system prompt.

## Available Skills
`;
  for (const [name, skill] of skills) {
    desc += `- **${name}**: ${skill.description}\n`;
  }
  return desc;
}

// --- Custom Tool Handlers ---

function handleSkillLoad(args) {
  const name = args?.name;
  if (!name) return 'Error: skill name is required. Use skill_list() to see available skills.';

  const skill = skillCache.get(name);
  if (!skill) {
    // Try BM25 search as fallback
    if (bm25) {
      const results = bm25.search(name, 3);
      if (results.length > 0) {
        const suggestions = results.map(r => r.name).join(', ');
        return `Skill "${name}" not found. Did you mean: ${suggestions}? Use skill_list("${name}") to search.`;
      }
    }
    const available = Array.from(skillCache.keys()).join(', ');
    return `Skill "${name}" not found. Available skills: ${available}`;
  }

  // FIXED (BUG-010): Single telemetry tracking point only (removed duplicate from tool.execute.after)
  if (telemetry) {
    try { telemetry.trackLoad(name, { context: 'manual' }); } catch (e) { /* degrade */ }
  }

  let content = `<skill_content name="${escapeXml(skill.name)}">\n`;
  content += skill.content + '\n\n';
  content += `Base directory: ${skill.dir}\n`;

  const bundled = discoverBundledFiles(skill.dir);
  if (bundled.length > 0) {
    content += '<skill_files>\n';
    for (const f of bundled) {
      content += `<file>${escapeXml(path.join(skill.dir, f))}</file>\n`;
    }
    content += '</skill_files>\n';
  }

  content += '</skill_content>';
  return content;
}

function handleSkillList(args) {
  const query = args?.query;

  // If query provided, use BM25 search
  if (query && bm25) {
    const results = bm25.search(query, 10);
    if (results.length === 0) return `No skills found matching "${query}".`;

    const lines = [`## Skills matching "${query}"`];
    for (const r of results) {
      const skill = skillCache.get(r.name);
      const desc = skill?.description || '';
      lines.push(`- **${r.name}** (score: ${r.score.toFixed(2)}): ${desc}`);
      if (r.snippet) lines.push(`  > ${r.snippet.slice(0, 120)}...`);
    }
    return lines.join('\n');
  }

  // No query: list all skills
  if (skillCache.size === 0) return 'No skills found.';
  const lines = ['## Available Skills'];
  for (const [name, skill] of skillCache) {
    lines.push(`- **${name}**: ${skill.description}`);
  }
  if (bm25) lines.push(`\n_Tip: Use skill_list("query") to search skills by keyword._`);
  return lines.join('\n');
}

function handleSkillAnalytics(args) {
  if (!telemetry) return 'Telemetry not available (SQLite initialization failed).';

  const skillName = args?.name;
  if (skillName) {
    const analytics = telemetry.getSkillAnalytics(skillName);
    if (!analytics || analytics.totalLoads === 0) {
      return `No telemetry data for "${skillName}".`;
    }
    const lines = [
      `## Analytics: ${analytics.name}`,
      `Total loads: ${analytics.totalLoads}`,
      `First seen: ${analytics.firstSeen}`,
      `Last seen: ${analytics.lastSeen}`,
      `Load contexts: ${JSON.stringify(analytics.loadContexts)}`,
    ];
    if (analytics.recentSessions.length > 0) {
      lines.push(`Recent sessions:`);
      for (const s of analytics.recentSessions) {
        lines.push(`  - ${s.session_id} at ${s.loaded_at}`);
      }
    }
    return lines.join('\n');
  }

  // No name: summary view
  return telemetry.getSummary();
}

// --- Refresh ---

function refreshSkills(ctxDir) {
  if (!shouldRefresh()) return skillCache;
  skillCache = scanSkillDirs(ctxDir);

  // Rebuild BM25 index
  if (!bm25) bm25 = new BM25Index();
  bm25.build(skillCache);

  // Take telemetry snapshot
  if (telemetry) {
    try { telemetry.takeSnapshot(skillCache); } catch (e) { /* degrade */ }
  }

  return skillCache;
}

// --- Main Export ---

export default async function(input) {
  const { project, directory } = input;
  const ctxDir = directory || project?.root;

  // Initialize telemetry (once)
  try { telemetry = getTelemetry(); } catch (e) { telemetry = null; }

  // Initial scan + index build
  refreshSkills(ctxDir);

  return {
    // Custom tools
    tool: {
      skill: {
        description: `Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.

Use this tool to inject the skill's instructions and resources into current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill.

The skill name must match one of the skills listed in your system prompt.

## Available Skills
${Array.from(skillCache.values()).map(s => `- **${s.name}**: ${s.description}`).join('\n')}`,
        parameters: {
          name: {
            type: 'string',
            description: 'The name of the skill from available_skills',
          },
        },
        execute: async (args) => handleSkillLoad(args),
      },
      skill_list: {
        description: `List all available skills or search them by keyword.

Use skill_list() with no arguments to list all skills.
Use skill_list("query") to search skills by keyword using BM25 ranking.

The search indexes skill names, descriptions, and full SKILL.md content.`,
        parameters: {
          query: {
            type: 'string',
            description: 'Optional search query. If omitted, lists all skills. If provided, returns BM25-ranked results matching the query.',
          },
        },
        execute: async (args) => handleSkillList(args),
      },
      skill_analytics: {
        description: `View skill usage analytics and telemetry data.

Call with no arguments for a summary of all skill usage.
Call with a skill name for detailed analytics on that specific skill.

Returns: load counts, usage trends, staleness, and session context.`,
        parameters: {
          name: {
            type: 'string',
            description: 'Optional skill name. If omitted, returns summary of all skills.',
          },
        },
        execute: async (args) => handleSkillAnalytics(args),
      },
    },

    // Hook: Override native skill tool definition with fresh description
    'tool.definition': async (toolInput, output) => {
      // FIXED (BUG-009): Normalize field names — use toolID consistently
      if (toolInput.toolID === 'skill') {
        output.description = generateToolDescription(skillCache);
      }
    },

    // Hook: Inject <available_skills> XML into system prompt
    'experimental.chat.system.transform': async (input, output) => {
      const sessionID = input?.sessionID || input?.sessionId || 'default';
      let xml = xmlCache.get(sessionID);
      if (xml === undefined) {
        // Refresh the global list lazily (debounced) so new skills appear for
        // NEW sessions, then freeze this session's rendering.
        if (Date.now() - xmlCacheRefresh > DEBOUNCE_MS) {
          refreshSkills(ctxDir);
          xmlCacheRefresh = Date.now();
        }
        xml = generateSkillsXml(skillCache);
        xmlCache.set(sessionID, xml);
        if (xmlCache.size > XML_CACHE_MAX) {
          const oldest = xmlCache.keys().next().value;
          if (oldest !== undefined) xmlCache.delete(oldest);
        }
      }
      if (xml) output.system.push(xml);
    },

    // Hook: Refresh on session idle — refresh the GLOBAL skill list (for new
    // sessions), but never touch the per-session frozen XML (cache stability).
    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        if (Date.now() - xmlCacheRefresh > DEBOUNCE_MS) {
          refreshSkills(ctxDir);
          xmlCacheRefresh = Date.now();
        }
        // Prune XML cache for dead sessions to bound memory.
        if (xmlCache.size > XML_CACHE_MAX * 4) {
          const keys = Array.from(xmlCache.keys()).slice(0, Math.floor(xmlCache.size / 2));
          for (const k of keys) xmlCache.delete(k);
        }
      }
    },

    // Hook: Refresh after skill operations and watch for skill installation
    'tool.execute.after': async (toolInput) => {
      const toolName = toolInput.tool || toolInput.toolID;

      // FIXED (BUG-008): Watch Bash tool for skill installation commands
      if (toolName === 'Bash' || toolName === 'bash') {
        const cmd = toolInput.args?.command || '';
        if (/npx\s+skills?\s+install|npm\s+run\s+skills?\s+install|skill[s]?\s+install/i.test(cmd)) {
          lastRefreshTime = 0;
          refreshSkills(ctxDir);
          return;
        }
      }

      // Refresh after direct skill operations
      if (['skill', 'skill_create', 'skill_update'].includes(toolName)) {
        lastRefreshTime = 0;
        refreshSkills(ctxDir);
      }

      // FIXED (BUG-010): Removed duplicate telemetry tracking from here.
      // Telemetry is only tracked in handleSkillLoad() for skill loads.
    },
  };
}
