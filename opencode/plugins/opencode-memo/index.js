// opencode-memo plugin manifest + hook registration (Bun, zero deps).
// Talks to memo ONLY over its MCP endpoint — never opens the DB file (M-032).
// Config (env, with defaults): MEMO_ENDPOINT (default
// http://localhost:8000/mcp), MEMO_TOKEN (required for --http).
//
// No background scheduling, no idle flush, no polling (M-030):
//   0. tool transform        — registers the harness-side skill_create tool
//                               (writes SKILL.md locally, then auto-pushes)
//   1. session "context"      — frozen orientation block, byte-stable per
//                               session, re-pushed on EVERY render so it
//                               survives compaction; plus any reminder queued by (2)
//   2. tool "execute.before"  — reminder guards: records memory_search/skill_put
//                               use; queues a reminder when the agent acts
//                               without them; fires a non-blocking drift check
//                               on skill use (never blocks, never mutates input)
//   3. session "compaction"   — carries the memory block through compaction
//   4. tool "execute.after"   — disk-evident skill push: a **/SKILL.md write or
//                               a native skill_create/skill_update event pushes
//                               the skill via skill_put (restored from 216a806)
import { Plugin } from "@opencode/plugin";
import {
  transform, onSessionStart, onAfterWrite, createGuard, guardBefore,
  createSkillCreateTool, REMIND_PERSIST,
} from "./hooks.js";

export const name = "opencode-memo";
export const version = "3.0.0";

// Named re-exports stay for tests/consumers that import hooks directly.
export { transform, onSessionStart, onAfterWrite, guardBefore, createSkillCreateTool };

export const config = {
  endpoint: process.env.MEMO_ENDPOINT ?? "http://localhost:8000/mcp",
  tokenEnv: "MEMO_TOKEN",
};

const CACHE_MAX = 64;

export default Plugin.define({
  id: "opencode-memo",
  async setup(ctx) {
    // sid -> { promise, text }: one onSessionStart per session; `text` pins the
    // resolved bytes so concurrent renders (and the prompt cache) see identical
    // text — the frozen snapshot the enforcement contract depends on.
    const snapshots = new Map();
    // sid -> guard state (see guardBefore).
    const guards = new Map();

    function snapshot(sid) {
      let e = snapshots.get(sid);
      if (e) return e;
      e = { promise: null, text: null };
      e.promise = onSessionStart({})
        .then((r) => transform("", {
          memoryMd: [r?.summary, r?.nudge].filter(Boolean).join("\n\n") }));
      snapshots.set(sid, e);
      if (snapshots.size > CACHE_MAX) snapshots.delete(snapshots.keys().next().value);
      return e;
    }

    function guard(sid) {
      let g = guards.get(sid);
      if (g) return g;
      g = createGuard();
      guards.set(sid, g);
      if (guards.size > CACHE_MAX) guards.delete(guards.keys().next().value);
      return g;
    }

    // 0. Harness-side skill_create tool: writes <skills-dir>/<name>/SKILL.md
    // locally, then auto-pushes (skill_put) and refreshes the sync view.
    await ctx.tool.transform((editor) => {
      editor.add(createSkillCreateTool());
    });

    // 1. Every render: frozen orientation, then any reminders queued since the
    // last render (one-shot — cleared once surfaced).
    await ctx.session.hook("context", async (event) => {
      const sid = String(event.sessionID ?? "default");
      const e = snapshot(sid);
      if (e.text === null) e.text = await e.promise;
      event.system.push({ type: "text", text: e.text });
      const g = guard(sid);
      if (g.pending.length > 0) {
        event.system.push({ type: "text", text: g.pending.join("\n") });
        g.pending.length = 0;
      }
    });

    // 2. Reminder guards — record memory use, queue at most one reminder each,
    // fire the non-blocking drift check on skill use.
    await ctx.tool.hook("execute.before", (event) => {
      guardBefore(event, guard(String(event.sessionID ?? "default")), {});
    });

    // 3. Compaction: carry the memory block forward (mirrors the hermes plugin).
    await ctx.session.hook("compaction", async (event) => {
      const sid = String(event.sessionID ?? "default");
      const e = snapshots.get(sid);
      if (!e) return;
      try {
        if (e.text === null) e.text = await e.promise;
        event.result = {
          summary: `## Session State Summary\n${e.text}\n\n${REMIND_PERSIST}`,
        };
      } catch {
        // leave event.result unset -> normal model compaction proceeds
      }
    });

    // 4. Disk-evident push: after a **/SKILL.md write (write/edit/patch) or a
    // native skill_create/skill_update event, push the skill via skill_put.
    // Only deterministic disk evidence triggers it (resolveSkillPath gates the
    // path); never speculative, never background.
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return;
      const input = event.input ?? {};
      if (event.tool === "skill_create" || event.tool === "skill_update") {
        onAfterWrite({ tool: event.tool, input });
      } else if (event.tool === "write" || event.tool === "edit" || event.tool === "patch") {
        const p = input.path ?? input.filePath;
        if (p) onAfterWrite(String(p));
      }
    });
  },
});
