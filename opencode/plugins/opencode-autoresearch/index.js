// opencode-autoresearch — V2 port (Maleick/AutoResearch v3.14.2 adapt-in-place)
// V1 shape was `export async function server()` + `export default {id,server}`
// (src/index.ts) registering commandFiles[] via config.command + skills paths.
// V2 shape: `import {Plugin} from "@opencode/plugin"` + `Plugin.define({id,
// setup})`. Slash commands are NOT plugin-registrable in v2 — the v2
// mechanism is markdown files in commands/ (see commands/autoresearch.md +
// commands/autoresearch/*.md, incl. digest orphan registered here by file).
// Skills resolve via skills/autoresearch/ (SKILL.md + references/ + hermes/).
import fs from "node:fs";
import path from "node:path";
import { Plugin } from "@opencode/plugin";

// Byte-identical to V1 CONTEXT_INJECTION (incl. leading newline).
const CONTEXT_INJECTION = `
## Autoresearch Mode (ACTIVE)

You are in autoresearch mode.

### Loop Rules
- **LOOP FOREVER** - Never ask "should I continue?"
- **Primary metric is king** - Improved → keep, worse/equal → discard
- Run experiments, log results, keep winners, discard losers
- NEVER STOP until interrupted

### Experiment Instructions
- Read autoresearch.md, autoresearch.jsonl, experiments/worklog.md for context
- If autoresearch.ideas.md exists, use it for inspiration
- User messages during experiments are steers — finish current experiment, then incorporate the idea in the next experiment
`;

const SENTINEL = ".autoresearch-off";
const MARKER = "autoresearch.md";
const STATE = "autoresearch.jsonl";
const MALEICK_STATE = ".autoresearch/state.json"; // Maleick v3.14.2 run checkpoint (schema preserved as-is)
const MALEICK_GOAL = ".autoresearch/goal.md";
const MAX_BACKUPS = 5;

// Flat layout first, then legacy pi-autoresearch `.auto/` layout (paths.ts compat),
// then Maleick `.autoresearch/` layout (state.json + goal.md, constants.ts
// STATE_DEFAULT/GOAL_DEFAULT). Hooks mapping:
// init.sh (SessionStart checklist) -> context hook below (checklist runs when a
// managed run is active); status.sh (read-only state print) -> covered by
// /autoresearch:digest command file; stop.sh (background stop flag) -> manual
// `autoresearch stop` / resolve via CLI; verify-package.sh -> release-time only,
// not wired at runtime. All fail-open.

// Flat layout first, then legacy pi-autoresearch `.auto/` layout (paths.ts compat),
// then Maleick `.autoresearch/` layout.
function findRoot(directory) {
  try {
    if (fs.existsSync(path.join(directory, MARKER))) return directory;
    const auto = path.join(directory, ".auto");
    if (fs.existsSync(path.join(auto, MARKER))) return auto;
    if (fs.existsSync(path.join(directory, MALEICK_STATE))) return directory;
    if (fs.existsSync(path.join(directory, MALEICK_GOAL))) return directory;
  } catch {}
  return null;
}

async function sessionDir(ctx, sessionID) {
  try {
    const raw = await ctx.session.get({ sessionID });
    const s = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
    const dir = s?.location?.directory ?? s?.directory;
    if (typeof dir === "string" && dir) return dir;
  } catch {}
  return null;
}

// Rolling backup of autoresearch.jsonl, keep last 5 (.bak.YYYYMMDD_HHMMSS). Never throws.
function backupState(root) {
  try {
    if (!fs.existsSync(path.join(root, STATE))) return;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "_")
      .slice(0, 15);
    fs.copyFileSync(path.join(root, STATE), path.join(root, `${STATE}.bak.${stamp}`));
    const old = fs
      .readdirSync(root)
      .filter((f) => f.startsWith(`${STATE}.bak.`))
      .sort();
    while (old.length > MAX_BACKUPS) fs.rmSync(path.join(root, old.shift()), { force: true });
  } catch {}
}

export default Plugin.define({
  id: "opencode-autoresearch",
  async setup(ctx) {
    // 1:1 V1 parity — inject loop rules when in an autoresearch session, skip on sentinel.
    await ctx.session.hook("context", async (event) => {
      try {
        const dir = await sessionDir(ctx, event.sessionID);
        if (!dir) return;
        const root = findRoot(dir);
        if (!root) return;
        if (fs.existsSync(path.join(root, SENTINEL))) return;
        event.system.push({ type: "text", text: CONTEXT_INJECTION });
      } catch {}
    });
    // V2 equivalent of pi-autoresearch before_agent_start (no such hook in v2
    // SessionHooks; `prompt` fires per inbound message before the agent loop):
    // safety-net state backup so the loop can always recover. The SKILL.md
    // backup_before_confirm protocol covers interactive ops; this covers the rest.
    await ctx.session.hook("prompt", async (event) => {
      try {
        const dir = await sessionDir(ctx, event.sessionID);
        if (!dir) return;
        const root = findRoot(dir);
        if (!root) return;
        if (fs.existsSync(path.join(root, SENTINEL))) return;
        backupState(root);
      } catch {}
    });
  },
});
