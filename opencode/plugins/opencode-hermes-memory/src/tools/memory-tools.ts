import { tool } from "@opencode-ai/plugin"
import type { MemoryManager, MemoryType } from "../memory-manager.ts"

/**
 * Create memory-related custom tools for the agent.
 * These give the agent the ability to actively save and recall cross-session knowledge.
 */
export function createMemoryTools(memoryManager: MemoryManager): Record<string, ReturnType<typeof tool>> {
  return {
    /**
     * memory_save — Save a fact, preference, or correction to persistent memory
     */
    memory_save: tool({
      description: `Save important information to persistent memory that will be available in ALL future sessions.

Use this proactively for:
- **environment**: Project-specific facts (build commands, deploy steps, file structure, API patterns)
- **user_preference**: Coding style, language choices, formatting rules, what the user likes/dislikes
- **correction**: Things you did wrong that were corrected — so you never repeat the mistake
- **workflow**: Non-obvious multi-step processes or workarounds you discovered

Examples:
- "Project uses Bun runtime, not Node.js — always use \`bun\` not \`npm\`" (environment)
- "User prefers functional React components with named exports" (user_preference)
- "Do NOT use axios — project uses native fetch API" (correction)
- "Deploy process: bun build → sst deploy --stage prod → verify CloudFront" (workflow)`,
      args: {
        content: tool.schema
          .string()
          .min(10)
          .describe("The fact or preference to remember, as a clear statement"),
        type: tool.schema
          .enum(["environment", "user_preference", "correction", "workflow"])
          .describe(
            "Category: environment (project facts), user_preference (coding style), correction (mistakes to avoid), workflow (processes)"
          ),
      },
      async execute(args) {
        const content = args.content as string
        const type = args.type as MemoryType
        memoryManager.appendEntry(content, type)
        return `Memory saved [${type}]: "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}". This will be available in all future sessions.`
      },
    }),

    /**
     * memory_stats — Check current memory file sizes and entry counts
     */
    memory_stats: tool({
      description: `Check current memory file sizes and entry counts. Use this to know when to consolidate — MEMORY.md limit is 4,000 chars, USER.md is 2,200.`,
      args: {},
      async execute() {
        const mem = memoryManager.readMemory()
        const user = memoryManager.readUserProfile()
        const memEntries = (mem.match(/\n- /g) || []).length
        const userEntries = (user.match(/\n- /g) || []).length
        const memPct = Math.round((mem.length / 4000) * 100)
        const userPct = Math.round((user.length / 2200) * 100)
        return [
          `## Memory Stats`,
          `MEMORY.md: ${mem.length}/4000 chars (${memPct}%) — ${memEntries} entries`,
          `USER.md: ${user.length}/2200 chars (${userPct}%) — ${userEntries} entries`,
          memPct > 80 ? `⚠️ MEMORY.md above 80% — consider consolidating with memory_consolidate` : ``,
          userPct > 80 ? `⚠️ USER.md above 80% — consider consolidating` : ``,
        ].filter(Boolean).join("\n")
      },
    }),

    /**
     * memory_consolidate — Rewrite MEMORY.md with consolidated/merged entries
     */
    memory_consolidate: tool({
      description: `Rewrite MEMORY.md with consolidated, merged, or trimmed entries. Use when memory_stats shows >80% capacity.

Read the current entries first with memory_search, decide what to merge or drop (never drop corrections), then pass the full rewritten content.

The content MUST include the section headers (## Environment & Project Facts, ## Learned Workflows, ## Corrections) and start with "# Memory".`,
      args: {
        content: tool.schema
          .string()
          .min(50)
          .describe("The full consolidated MEMORY.md content, including section headers and title"),
      },
      async execute(args) {
        const content = args.content as string
        memoryManager.writeMemory(content)
        const entries = (content.match(/\n- /g) || []).length
        return `Memory consolidated: ${content.length}/4000 chars, ${entries} entries. This will be visible in the system prompt on the NEXT session start.`
      },
    }),

    /**
     * memory_search — Search persistent memory for relevant facts
     */
    memory_search: tool({
      description: `Search persistent memory for facts relevant to your current task.

Use this when you want to check if you've previously learned something about:
- A specific tool, library, or framework used in the project
- The user's preferences for a particular coding pattern
- A workflow or deployment process
- A correction or mistake to avoid

Returns matching memory entries if found.`,
      args: {
        query: tool.schema
          .string()
          .min(2)
          .describe("Keywords or topic to search for in persistent memory"),
      },
      async execute(args) {
        const { results, bm25 } = memoryManager.search(args.query as string)
        if (bm25 && bm25.length > 0) {
          const scored = bm25
            .map(h => `  [${h.score.toFixed(2)}] ${h.snippet || h.name}`)
            .join("\n")
          return `${results}\n\nBM25 scores:\n${scored}`
        }
        return results
      },
    }),
  }
}
