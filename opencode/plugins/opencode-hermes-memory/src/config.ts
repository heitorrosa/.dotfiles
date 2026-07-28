import type { MemoryNudgeConfig } from "./types.js"

// ─── Default Config ───────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: MemoryNudgeConfig = {
  nudgeFrequency: 10,
  signalDetection: true,
  sessionEndNudge: true,
  protectedTools: [
    "memory_save",
    "memory_search",
    "compress",
    "ctx_search",
    "ctx_stats",
    "skill_list",
    "skill",
  ],
  minToolCallsBeforeNudge: 5,
  nudgeForce: "soft",
}

// ─── Nudge Templates ──────────────────────────────────────────────────────────

export const PERIODIC_NUDGE = `<system-reminder>
[Hermes Memory Nudge] Pause and think — before continuing, check:
- **Retrieve first**: memory_search(query: "task keywords") — past decisions, corrections, workflows
- **Check skills**: skill_list("relevant keywords") — load with skill("name") if found
- **Then persist**: if you learned something, memory_save() or skill_create()
Do not reinvent known solutions. Retrieve before acting.
</system-reminder>`

export const RETRIEVAL_GAP_NUDGE = `<system-reminder>
[Hermes Memory — Retrieval Gap] {toolCalls} tool calls since last memory_search.
You may be reinventing known solutions. Call memory_search(query) now.
</system-reminder>`

export const SKILL_NUDGE = `<system-reminder>
[Hermes Memory — Skill Opportunity] You just completed a complex task.
- If this workflow may repeat: skill_create(name: "descriptive-name", description: "Use when [trigger]", content: "...")
- If you learned something new about an existing skill: skill_update(name: "skill-name", patch: "what you learned")
Future sessions will benefit from this knowledge.
</system-reminder>`

export const SIGNAL_CORRECTION_NUDGE = `<system-reminder>
[Hermes Memory — Correction Detected] The user just corrected you. This is your highest-value signal.
Call memory_save(type: "correction", content: "...") NOW with the exact correction.
Do not defer — corrections are the most important thing to persist.
</system-reminder>`

export const SIGNAL_WORKFLOW_NUDGE = `<system-reminder>
[Hermes Memory — Workflow Discovered] You just completed a multi-step process that worked.
Call memory_save(type: "workflow", content: "...") to document it for future sessions.
</system-reminder>`

export const SIGNAL_ENVIRONMENT_NUDGE = `<system-reminder>
[Hermes Memory — Environment Fact] You discovered a project-specific fact (path, command, config, dependency).
Call memory_save(type: "environment", content: "...") to record it.
</system-reminder>`
