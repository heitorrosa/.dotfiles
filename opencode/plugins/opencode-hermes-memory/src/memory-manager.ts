import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { BM25Index } from "./bm25-local.js"

// ─── Constants ────────────────────────────────────────────────────────────────

const HERMES_DIR = join(homedir(), ".config", "opencode", "hermes-memory")
const MEMORY_FILE = join(HERMES_DIR, "memory.md")
const USER_FILE = join(HERMES_DIR, "user.md")

// Token budget: ~4 chars per token
const MEMORY_MAX_CHARS = 4000 // ~1000 tokens
const USER_MAX_CHARS = 2200 // ~550 tokens

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryType = "environment" | "user_preference" | "correction" | "workflow"

// ─── MemoryManager ───────────────────────────────────────────────────────────

export class MemoryManager {
  private _bm25Index: BM25Index | null = null
  private _bm25Ready = false

  /**
   * Read the current memory.md content
   */
  readMemory(): string {
    if (!existsSync(MEMORY_FILE)) return ""
    return readFileSync(MEMORY_FILE, "utf-8")
  }

  /**
   * Read the current user.md content
   */
  readUserProfile(): string {
    if (!existsSync(USER_FILE)) return ""
    return readFileSync(USER_FILE, "utf-8")
  }

  /**
   * Append a new entry to the appropriate memory file based on type
   */
  appendEntry(content: string, type: MemoryType): void {
    const timestamp = new Date().toISOString().split("T")[0]
    const entry = `- [${timestamp}] ${content.trim()}`

    if (type === "user_preference") {
      this._appendToSection(USER_FILE, "## Coding Preferences", entry, USER_MAX_CHARS)
    } else if (type === "environment") {
      this._appendToSection(MEMORY_FILE, "## Environment & Project Facts", entry, MEMORY_MAX_CHARS)
    } else if (type === "workflow") {
      this._appendToSection(MEMORY_FILE, "## Learned Workflows", entry, MEMORY_MAX_CHARS)
    } else if (type === "correction") {
      this._appendToSection(MEMORY_FILE, "## Corrections (things to avoid)", entry, MEMORY_MAX_CHARS)
    }

    // Update timestamp at the top
    this._updateTimestamp(type === "user_preference" ? USER_FILE : MEMORY_FILE)
  }

  /**
   * Search persistent memory for relevant facts (BM25 ranked)
   */
  search(query: string): { results: string; bm25?: { name: string; score: number; snippet: string }[] } {
    // Lazy-build BM25 index on first search
    if (!this._bm25Ready) {
      try { this._buildBM25Index() } catch { /* fall through to substring */ }
    }

    // Try BM25 search
    if (this._bm25Ready && this._bm25Index) {
      try {
        const hits = this._bm25Index.search(query, 10)
        if (hits.length > 0) {
          // Group by category prefix (name format: "category:lineIndex")
          const byCategory = new Map<string, string[]>()
          for (const hit of hits) {
            const colonIdx = hit.name.indexOf(":")
            const cat = colonIdx > 0 ? hit.name.slice(0, colonIdx) : "memory"
            const lines = byCategory.get(cat) || []
            lines.push(hit.snippet || hit.name.split(":")[1])
            byCategory.set(cat, lines)
          }
          const formatted = [...byCategory.entries()]
            .map(([cat, lines]) => `[${cat}]\n${lines.join("\n")}`)
            .join("\n\n")
          return { results: formatted, bm25: hits }
        }
      } catch { /* fall through to substring */ }
    }

    // Fallback: substring matching
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const allContent = [this.readMemory(), this.readUserProfile()].join("\n\n")
    const lines = allContent.split("\n")
    const matches: string[] = []
    for (const line of lines) {
      if (line.startsWith("#") || line.startsWith("_") || line.trim() === "") continue
      const lower = line.toLowerCase()
      if (terms.some(t => lower.includes(t))) matches.push(line.trim())
    }
    if (matches.length === 0) return { results: "No matching memories found." }
    return { results: matches.slice(0, 15).join("\n") }
  }

  /**
   * Overwrite MEMORY.md with new content (for consolidation)
   */
  writeMemory(content: string): void {
    writeFileSync(MEMORY_FILE, content, "utf-8")
    this.rebuildBM25Index()
  }

  /**
   * Build the BM25 index from memory files. Each bullet line is a document.
   */
  private _buildBM25Index(): void {
    const memoryContent = this.readMemory()
    const userContent = this.readUserProfile()
    const docMap = new Map<string, { name: string; description: string; content: string; dir: string }>()

    const parseFile = (content: string, source: string) => {
      let currentSection = source
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("## ")) {
          currentSection = trimmed.replace(/^##\s+/, "")
        } else if (trimmed.startsWith("- ")) {
          const key = `${currentSection}:${docMap.size}`
          docMap.set(key, { name: key, description: currentSection, content: trimmed, dir: "" })
        }
      }
    }

    if (memoryContent) parseFile(memoryContent, "memory")
    if (userContent) parseFile(userContent, "user")

    if (docMap.size === 0) return

    this._bm25Index = new BM25Index()
    this._bm25Index.build(docMap)
    this._bm25Ready = true
  }

  /**
   * Rebuild the BM25 index (called after writes)
   */
  rebuildBM25Index(): void {
    this._bm25Ready = false
    this._bm25Index = null
    try { this._buildBM25Index() } catch { /* index will stay unavailable */ }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _appendToSection(filePath: string, sectionHeader: string, entry: string, maxChars: number): void {
    let content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : ""

    const sectionIdx = content.indexOf(sectionHeader)
    if (sectionIdx === -1) {
      // Section not found, append to end
      content = content.trimEnd() + "\n\n" + sectionHeader + "\n" + entry + "\n"
    } else {
      // Find the end of this section (next ## or end of file)
      const afterSection = sectionIdx + sectionHeader.length
      const nextSection = content.indexOf("\n##", afterSection)
      if (nextSection === -1) {
        // Last section - append at end
        content = content.trimEnd() + "\n" + entry + "\n"
      } else {
        // Insert before next section
        content = content.slice(0, nextSection) + "\n" + entry + content.slice(nextSection)
      }
    }

    // Trim if over budget
    if (content.length > maxChars) {
      content = this._trimOldestEntries(content, maxChars)
    }

    writeFileSync(filePath, content, "utf-8")
  }

  private _updateTimestamp(filePath: string): void {
    if (!existsSync(filePath)) return
    let content = readFileSync(filePath, "utf-8")
    const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"

    // Update or insert the _Last updated_ line
    if (content.includes("_Last updated:")) {
      content = content.replace(/_Last updated:.*_/, `_Last updated: ${ts}_`)
    } else {
      // Insert after first # heading
      content = content.replace(/^(# .+\n)/, `$1\n_Last updated: ${ts}_\n`)
    }
    writeFileSync(filePath, content, "utf-8")
  }

  /**
   * Remove the oldest bullet entries from the file to stay under maxChars.
   * Matches dated entries first (- [YYYY-MM-DD]), then undated entries (- text).
   */
  private _trimOldestEntries(content: string, maxChars: number): string {
    while (content.length > maxChars) {
      // Try dated entries first (oldest by date)
      const dated = /\n- \[\d{4}-\d{2}-\d{2}\] .+/.exec(content)
      // Also match undated bullet entries (legacy entries without dates)
      const undated = /\n- [^\n]+/.exec(content)

      // Remove whichever appears first (top of file = oldest)
      const match = dated && undated
        ? dated.index < undated.index ? dated : undated
        : dated || undated

      if (!match) break
      content = content.slice(0, match.index) + content.slice(match.index + match[0].length)
    }
    return content
  }
}
