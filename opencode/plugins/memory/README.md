# opencode-hermes-memory

> The more you use OpenCode, the smarter it gets.

A persistent memory and auto-skill creation plugin for [OpenCode](https://opencode.ai), inspired by [HermesAgent](https://hermes-agent.nousresearch.com)'s "use it more, get more" philosophy.

## What it does

Every session, OpenCode starts fresh — no memory of past projects, preferences, or workflows. This plugin changes that by adding **three layers of persistent intelligence**:

### Layer 1 — Persistent Memory (injected into every session)
Facts the agent learns are saved to markdown files and **automatically injected into the system prompt** of every future session:
- `~/.config/opencode/hermes-memory/memory.md` — Environment facts, workflows, corrections (~1000 tokens)
- `~/.config/opencode/hermes-memory/user.md` — Your coding preferences and style (~500 tokens)

### Layer 2 — Auto-Skill Creation
When the agent completes a complex workflow, it can document it as a `SKILL.md` file. OpenCode loads these automatically in future sessions via the native `skill` tool:
- `~/.config/opencode/skills/{name}/SKILL.md`

### Layer 3 — Complexity Detection
The plugin tracks tool calls per session. When a session is complex enough (5+ tool calls, errors recovered, etc.), the agent is reminded to create a skill for future reuse.

## How the agent learns

The agent gets 5 new tools:

| Tool | When to use |
|------|-------------|
| `memory_save` | Save facts, preferences, corrections, workflows |
| `memory_search` | Recall specific knowledge from past sessions |
| `skill_create` | Document a complex workflow as a reusable Skill |
| `skill_update` | Add new learnings to an existing Skill |
| `skill_list` | See all documented skills |

The agent is instructed (via system prompt injection) to call `memory_save` proactively:
- When the user corrects a mistake → save as `correction`
- When you discover project quirks → save as `environment`  
- When user states preferences → save as `user_preference`
- When you complete a multi-step workflow → use `skill_create`

## Installation

### Option 1: npm package (recommended, coming soon)

```json
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-hermes-memory"]
}
```

OpenCode will automatically install it via Bun at startup.

### Option 2: Local development

Clone this repo to `~/.config/opencode/custom/opencode-hermes-memory/` and create a loader:

```typescript
// ~/.config/opencode/plugins/hermes-memory.ts
export { HermesMemoryPlugin } from "../custom/opencode-hermes-memory/src/index.ts"
```

## Storage layout

```
~/.config/opencode/
├── hermes-memory/
│   ├── memory.md       ← Environment facts, workflows, corrections
│   └── user.md         ← Your coding preferences and style
├── skills/
│   ├── deploy-to-aws/
│   │   └── SKILL.md    ← Auto-created by agent
│   └── database-migration/
│       └── SKILL.md
└── plugins/
    └── hermes-memory.ts  ← Local loader (dev only)
```

## How it compares to HermesAgent

| HermesAgent | opencode-hermes-memory |
|-------------|----------------------|
| `MEMORY.md` + `USER.md` | `memory.md` + `user.md` (same concept) |
| Frozen snapshot in system prompt | `experimental.chat.system.transform` injection |
| Agent calls `memory` tool | Agent calls `memory_save` tool |
| `SKILL.md` auto-creation | `skill_create` tool → OpenCode native Skills |
| Skill patch/improve | `skill_update` tool |
| Session search (SQLite FTS5) | Phase 3 (planned) |
| GEPA self-evolution | Phase 4 (planned) |

## Configuration

No configuration required. Works out of the box.

Optional: control skill permissions in `opencode.json`:
```json
{
  "permission": {
    "skill": {
      "*": "allow"
    }
  }
}
```

## Architecture

```
OpenCode Agent
    │ calls memory_save / skill_create
    ▼
Plugin (hermes-memory.ts)
    ├── experimental.chat.system.transform → injects memory into system prompt
    ├── tool.execute.after → tracks session complexity
    ├── experimental.session.compacting → preserves memory on compaction
    ├── event(session.idle) → logs complexity, cleanup
    └── tools: memory_save, memory_search, skill_create, skill_update, skill_list
    │
    ▼
Storage (plain markdown files, no database)
    ├── ~/.config/opencode/hermes-memory/memory.md
    ├── ~/.config/opencode/hermes-memory/user.md
    └── ~/.config/opencode/skills/{name}/SKILL.md
```

## License

MIT
