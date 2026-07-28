import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ─── Constants ────────────────────────────────────────────────────────────────

// OpenCode's native global skills directory — loaded automatically
const GLOBAL_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills")

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string
  description: string
  path: string
  createdAt?: string
}

// ─── SKILL.md Template ────────────────────────────────────────────────────────

function buildSkillContent(name: string, description: string, body: string): string {
  const date = new Date().toISOString().split("T")[0]
  return `---
name: ${name}
description: ${description}
license: MIT
compatibility: opencode
metadata:
  source: hermes-memory-plugin
  created: ${date}
---

${body.trim()}
`
}

// ─── SkillManager ─────────────────────────────────────────────────────────────

export class SkillManager {
  /**
   * Create a new skill SKILL.md in the global skills directory.
   * Returns the path to the created file.
   */
  create(name: string, description: string, body: string): string {
    const skillDir = join(GLOBAL_SKILLS_DIR, name)
    const skillFile = join(skillDir, "SKILL.md")

    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true })
    }

    // Don't overwrite — if it exists, delegate to update
    if (existsSync(skillFile)) {
      return this.update(name, body)
    }

    const content = buildSkillContent(name, description, body)
    writeFileSync(skillFile, content, "utf-8")
    return skillFile
  }

  /**
   * Append new learning/notes to an existing skill.
   * Returns the path to the updated file.
   */
  update(name: string, patch: string): string {
    const skillFile = join(GLOBAL_SKILLS_DIR, name, "SKILL.md")

    if (!existsSync(skillFile)) {
      throw new Error(`Skill '${name}' not found. Use skill_create first.`)
    }

    const date = new Date().toISOString().split("T")[0]
    const updateSection = `\n## Update [${date}]\n\n${patch.trim()}\n`

    const current = readFileSync(skillFile, "utf-8")
    writeFileSync(skillFile, current.trimEnd() + "\n" + updateSection, "utf-8")
    return skillFile
  }

  /**
   * List all skills in the global skills directory
   */
  list(): SkillInfo[] {
    if (!existsSync(GLOBAL_SKILLS_DIR)) return []

    const skills: SkillInfo[] = []

    try {
      const entries = readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = join(GLOBAL_SKILLS_DIR, entry.name, "SKILL.md")
        if (!existsSync(skillFile)) continue

        const content = readFileSync(skillFile, "utf-8")
        const description = this._extractDescription(content)

        skills.push({
          name: entry.name,
          description,
          path: skillFile,
        })
      }
    } catch {
      // ignore read errors
    }

    return skills
  }

  /**
   * Check if a skill with the given name exists
   */
  exists(name: string): boolean {
    return existsSync(join(GLOBAL_SKILLS_DIR, name, "SKILL.md"))
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _extractDescription(content: string): string {
    const match = /^description:\s*(.+)$/m.exec(content)
    return match ? match[1].trim() : "No description"
  }
}
