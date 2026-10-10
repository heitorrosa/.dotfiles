// memory plugin — persistent memory + auto-skill creation for OpenCode.
//
// What setup() wires up, in order:
//   1. registers the memory_* and skill_* tools
//   2. pushes a frozen MEMORY.md/USER.md snapshot into the system prompt
//   3. blocks direct edits of memory.md/user.md (use memory_save instead)
//   4. carries the memory-state summary across compaction

import { Plugin } from "@opencode/plugin"
import { MemoryManager } from "./memory-manager.ts"
import { SkillManager } from "./skill-manager.ts"
import { createMemoryTools } from "./tools/memory-tools.ts"
import { createSkillTools } from "./tools/skill-tools.ts"

// Tools that write files — these are the only ones the edit guard checks.
const GUARDED_EDIT_TOOLS = new Set(["edit", "write", "patch"])
// memory.md / user.md (either name, any path separator)
const MEMORY_FILE_PATTERN = /\/(memory|user)\.md$/i

const memoryManager = new MemoryManager()
const skillManager = new SkillManager()

export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    const allTools = [...createMemoryTools(memoryManager), ...createSkillTools(skillManager)]

    // Frozen memory snapshot — built once per SESSION and kept byte-stable for the
    // rest of that session (prompt-cache stability). Design intent (Hermes prompt
    // assembly): snapshot frozen at session start, mid-session writes appear on the
    // NEXT session. Map keyed by sessionID.
    const snapshotCache = new Map<string, string>()
    const SNAPSHOT_CACHE_MAX = 64

    function buildMemorySummary(title: string): string {
      const memoryContent = memoryManager.readMemory()
      const userProfile = memoryManager.readUserProfile()
      return [
        title,
        "",
        "## Semantic Memory (MEMORY.md)",
        memoryContent.trim() || "(empty)",
        "",
        "## User Profile (USER.md)",
        userProfile.trim() || "(empty)",
      ].join("\n")
    }

    function getFrozenSnapshot(sessionID: string): string {
      const key = sessionID || "default"
      const cached = snapshotCache.get(key)
      if (cached !== undefined) return cached
      const snapshot = [
        buildMemorySummary("# Hermes Memory State"),
        "",
        "## Retrieval Reminder",
        'Before acting on any task, use memory_search(query: "keywords") to check past knowledge.',
        "After completing complex tasks (5+ tool calls), consider skill_create() for reusable workflows.",
      ].join("\n")
      snapshotCache.set(key, snapshot)
      // Bound memory usage: drop oldest entries beyond the cap.
      if (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
        const oldest = snapshotCache.keys().next().value
        if (oldest !== undefined) snapshotCache.delete(oldest)
      }
      return snapshot
    }

    // ─── 1. TOOLS ─────────────────────────────────────────────────────────
    await ctx.tool.transform((editor) => {
      for (const tool of allTools) editor.add(tool)
    })

    // ─── 2. SYSTEM PROMPT SNAPSHOT ────────────────────────────────────────
    // The frozen MEMORY.md/USER.md snapshot is pushed byte-stable for
    // prompt-cache hits.
    await ctx.session.hook("context", (event) => {
      const sessionID = String(event.sessionID || "default")
      event.system.push({ type: "text", text: getFrozenSnapshot(sessionID) })
    })

    // ─── 3. FILE-EDIT GUARD ───────────────────────────────────────────────
    // Block direct edits/writes to memory.md and user.md BEFORE they run.
    await ctx.tool.hook("execute.before", (event) => {
      const toolName = event.tool
      if (GUARDED_EDIT_TOOLS.has(toolName)) {
        const input = (event.input ?? {}) as { path?: unknown; filePath?: unknown }
        const filePath = String(input.path || input.filePath || "").replace(/\\/g, "/")
        if (MEMORY_FILE_PATTERN.test(filePath)) {
          throw new Error(
            `BLOCKED: Cannot edit ${filePath} directly. Use memory_save() or memory_search() instead.`
          )
        }
      }
    })

    // ─── 4. COMPACTION ────────────────────────────────────────────────────
    // Record the compaction result to skip the model summary, carrying the
    // memory-state summary forward.
    await ctx.session.hook("compaction", (event) => {
      try {
        event.result = {
          summary:
            `## Session State Summary\n${buildMemorySummary("# Session Context")}\n\n` +
            `Persist critical facts to MEMORY.md or USER.md using memory_save before they are lost.`,
        }
      } catch {
        // leave event.result unset → normal model compaction proceeds
      }
    })
  },
})
