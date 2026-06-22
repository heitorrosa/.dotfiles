# opencode-memory-nudge Plugin Design

## Problem Statement

The `hermes-memory` plugin injects memory at session start via `experimental.chat.system.transform` and appends a complexity alert on `session.idle`. However, it never actively nudges the agent **during** the conversation to call `memory_save()`. The agent must "remember" to persist knowledge on its own — which it frequently doesn't, creating intelligence gaps over time.

## Solution: Message-Level Nudging

Modeled on ACP's compression nudging pattern, `opencode-memory-nudge` injects reminders directly into the **message stream** via `experimental.chat.messages.transform`, not just the system prompt. This puts nudges in the conversation flow where the model actually processes them.

## Architecture

### Three Nudge Types

1. **Turn-Based Nudge** — Every N turns (default: 10), inject a gentle reminder to persist knowledge
2. **Signal-Based Nudge** — Detect persistable moments (corrections, workflows, environment facts) and inject targeted nudges
3. **Correction Detection** — Scan user messages for correction patterns and inject immediate high-priority nudges

### Hook Strategy

```
experimental.chat.messages.transform  → Inject nudges into conversation messages
experimental.chat.system.transform    → Add memory-awareness to system prompt
tool.execute.after                    → Track tool calls, detect signals
event                                 → Session lifecycle management
```

### Anchoring Mechanism (from ACP)

Nudges are appended to the **most recent message** (role determined by `nudgeForce` config) as `<system-reminder>` blocks. This ensures the model sees the nudge in the conversation flow, not buried in the system prompt.

**nudgeForce** controls injection target (mirrors ACP's config):
- `"soft"` (default): Inject into **assistant messages** — less intrusive, model sees hints in its own prior responses
- `"strong"`: Inject into **user messages** — more forceful, model sees nudges as part of the next user turn

**Implementation**: `injectNudgeIntoMessage()` finds the last text part of the target message and appends the nudge text. If no text part exists, it creates a synthetic one. Two helpers select the anchor: `findLastUserMessage()` (strong) and `findLastAssistantMessage()` (soft).

### Signal Detection

**Correction Patterns** (highest priority):
- "no", "actually", "wrong", "incorrect"
- "use X instead"
- "that's not/wrong/incorrect"
- "you should have"
- "don't use/do/run/call"

**Workflow Patterns**:
- "step N of/:"
- "phase N"
- "successfully completed/deployed/built/installed"

**Environment Patterns**:
- "deployment via/using/with/command"
- "build command/step/script"
- "runtime:"
- "package manager"
- "pnpm/bun/yarn/npm install/run/build"

### Session State Tracking

Each session maintains:
- `turnCount` — number of user messages
- `toolCallCount` — total tool invocations
- `lastNudgeTurn` — when the last turn nudge was injected
- `lastMemorySaveTurn` — when the agent last called `memory_save()`
- `signalNudgeSent` — dedupe set for signal nudges

### Configuration

```typescript
interface MemoryNudgeConfig {
  turnFrequency: number           // Nudge every N turns (default: 10)
  signalDetection: boolean        // Detect persistable signals (default: true)
  sessionEndNudge: boolean        // Nudge on session.idle (default: true)
  protectedTools: string[]        // Tools that don't trigger nudges
  minToolCallsBeforeNudge: number // Minimum tool calls before nudging starts (default: 5)
  nudgeForce: "soft" | "strong"   // Injection target: assistant (default) or user messages
}
```

### Nudge Text Templates

All nudges are wrapped in `<system-reminder>` tags and include specific guidance:

**Turn Nudge**:
```
[Hermes Memory Nudge] You've been working for a while. Pause and evaluate:
- Did the user correct you? → memory_save(type: "correction")
- Did you discover a project fact? → memory_save(type: "environment")
- Did you find a reusable workflow? → memory_save(type: "workflow")
- Did you learn a user preference? → memory_save(type: "user_preference")
Persist now — future sessions depend on it.
```

**Correction Nudge** (highest priority):
```
[Hermes Memory — Correction Detected] The user just corrected you. This is your highest-value signal.
Call memory_save(type: "correction", content: "...") NOW with the exact correction.
Do not defer — corrections are the most important thing to persist.
```

**Workflow Nudge**:
```
[Hermes Memory — Workflow Discovered] You just completed a multi-step process that worked.
Call memory_save(type: "workflow", content: "...") to document it for future sessions.
```

**Environment Nudge**:
```
[Hermes Memory — Environment Fact] You discovered a project-specific fact (path, command, config, dependency).
Call memory_save(type: "environment", content: "...") to record it.
```

## Key Differences from hermes-memory

| Aspect | hermes-memory | opencode-memory-nudge |
|--------|---------------|----------------------|
| **Injection Point** | System prompt only (session start) | Message stream (continuous) |
| **Nudge Frequency** | None (passive) | Every 10 turns + signal-based |
| **Signal Detection** | None | Correction/workflow/environment patterns |
| **Anchoring** | N/A | Appends to last user message |
| **Session Tracking** | Minimal | Full state (turns, tool calls, last save) |

## Implementation Details

### File Structure
```
~/.config/opencode/plugins/opencode-memory-nudge/
└── index.ts          # Single-file plugin (no package.json, matching local plugin pattern)
```

### Registration
Added to `opencode.json`:
```json
{
  "plugin": [
    "opencode-hermes-memory",
    "opencode-memory-nudge",
    ...
  ]
}
```

### Plugin Export Pattern
```typescript
export default async function (input: any) {
  const config = { ...DEFAULT_CONFIG }
  const sessions = new Map<string, SessionState>()
  const pendingSignalNudges = new Map<string, string>()
  
  return {
    "experimental.chat.messages.transform": async (input, output) => { ... },
    "experimental.chat.system.transform": async (input, output) => { ... },
    "tool.execute.after": async (input, output) => { ... },
    event: async ({ event }) => { ... },
  }
}
```

## Expected Behavior

1. **Session Start**: Plugin initializes, creates session state
2. **Turn 5+**: System prompt includes memory-awareness context
3. **Turn 10+**: First turn nudge injected (if no `memory_save` called yet)
4. **Correction Detected**: Immediate correction nudge injected into user message
5. **Workflow/Environment Signal**: Targeted nudge injected on next turn
6. **Session Idle**: Log session stats, clean up state

## Testing Checklist

- [ ] Turn nudge fires at turn 10 (with 5+ tool calls)
- [ ] Turn nudge respects `turnFrequency` config
- [ ] Correction pattern detected in user message
- [ ] Correction nudge injected immediately
- [ ] Workflow signal detected in tool output
- [ ] Environment signal detected in tool output
- [ ] Signal nudge deduped (not sent twice for same signal type)
- [ ] `memory_save()` call resets nudge timer
- [ ] Protected tools don't trigger signal detection
- [ ] Session state cleaned up on `session.idle`
- [ ] System prompt includes memory context after 5+ tool calls

## Future Enhancements

1. **Configurable via opencode.json** — Allow users to override defaults
2. **Smarter Signal Detection** — Use LLM to classify persistable moments
3. **Nudge Fatigue Prevention** — Reduce frequency if agent ignores nudges
4. **Session-End Flush** — Inject session-end nudge before idle (currently logs only)
5. **Analytics** — Track nudge effectiveness (how often agent saves after nudge)
