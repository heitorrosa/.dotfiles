// opencode-skill-refresh.js
// Silently refreshes skill metadata and provides custom skill/skill_list tools
// that override the native frozen cache.

import fs from 'fs';
import path from 'path';
import os from 'os';

// Cache: Map<name, { name, description, path, content, dir }>
let skillCache = new Map();
let lastRefreshTime = 0;
const DEBOUNCE_MS = 30000;

// --- Utility ---

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result = {};
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key === 'name' || key === 'description') {
        result[key] = value;
      }
    }
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
          if (entry.isFile()) {
            files.push(path.join(sub, entry.name));
          }
        }
      }
    } catch (e) { /* skip */ }
  }
  // Root-level script files
  try {
    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(js|ts|py|sh)$/.test(entry.name)) {
        files.push(entry.name);
      }
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

Load a specialized skill that provides domain-specific instructions and workflows.

When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.

The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.

Tool output includes a \`<skill_content name="...">\` block with the loaded content.

The following skills provide specialized sets of instructions for particular tasks
Invoke this tool to load a skill when a task matches one of the available skills listed below:

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
    const available = Array.from(skillCache.keys()).join(', ');
    return `Skill "${name}" not found. Available skills: ${available}`;
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

function handleSkillList() {
  if (skillCache.size === 0) return 'No skills found.';
  const lines = ['## Available Skills'];
  for (const [name, skill] of skillCache) {
    lines.push(`- **${name}**: ${skill.description}`);
  }
  return lines.join('\n');
}

// --- Refresh ---

function refreshSkills(ctxDir) {
  if (!shouldRefresh()) return skillCache;
  skillCache = scanSkillDirs(ctxDir);
  return skillCache;
}

// --- Main Export ---

export default async function(input) {
  const { project, directory } = input;
  const ctxDir = directory || project?.root;

  // Initial scan
  refreshSkills(ctxDir);

  return {
    // Custom tools: override native skill/skill_list
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
        description: 'List all skills that have been created by the Hermes memory plugin. Use this to see what workflows have been documented so far, or to check if a skill already exists before creating a new one.',
        parameters: {},
        execute: async () => handleSkillList(),
      },
    },

    // Hook: Override native skill tool definition with fresh description
    'tool.definition': async (toolInput, output) => {
      if (toolInput.toolID === 'skill') {
        output.description = generateToolDescription(skillCache);
      }
    },

    // Hook: Inject <available_skills> XML into system prompt
    'experimental.chat.system.transform': async (_input, output) => {
      const xml = generateSkillsXml(skillCache);
      if (xml) output.system.push(xml);
    },

    // Hook: Refresh on session idle
    event: async ({ event }) => {
      if (event.type === 'session.idle') refreshSkills(ctxDir);
    },

    // Hook: Refresh after skill operations
    'tool.execute.after': async (toolInput) => {
      if (['skill', 'skill_create', 'skill_update'].includes(toolInput.tool)) {
        lastRefreshTime = 0;
        refreshSkills(ctxDir);
      }
    },
  };
}
