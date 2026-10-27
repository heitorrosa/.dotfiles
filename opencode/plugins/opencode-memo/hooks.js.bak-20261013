// opencode-memo hooks (Bun, zero deps — fetch + node:crypto are platform).
// Enforcement-only glue plus the harness-side skill_create tool. `transform` is
// a pure string op (no MCP call); `onSessionStart` / `onAfterWrite` /
// skill_create talk to the remote MCP endpoint. The execute.before guard +
// context/compaction/execute.after hook bodies live in plugin.js.
// No background scheduling, no idle flush, no polling/daemon (M-030). Failures
// warn + go stale; the session NEVER fails because memory is down (M-026).
import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const endpoint = () => process.env.MEMO_ENDPOINT ?? "http://localhost:8000/mcp";
const token = () => process.env.MEMO_TOKEN ?? "";

// opencode's native global skills dir (where bare `skill`/skill_create resolve).
const defaultSkillsDir = () =>
  path.join(process.env.HOME ?? "~", ".config/opencode/skills");

const HERMES_BLOCK = new URL("./templates/hermes-block.md", import.meta.url);

// Last-resort orientation, used only if templates/hermes-block.md is unreadable,
// so the every-render reminder can never silently vanish.
const FALLBACK_BLOCK = [
  "# memo (opencode) — prose: prompts.json (memo://summary)",
  'skill_sync(harness:"opencode", known:<local name/hash list>)',
  "new skill: skill_create(name, description, body) -> writes " +
    "skills/<name>/SKILL.md + auto skill_put",
].join("\n");

/** Compaction addendum — persisted on both ends of a compaction. */
export const REMIND_PERSIST =
  "Persist critical facts with memory_save and reusable workflows with " +
  "skill_put before they are lost.";

// Guard reminders (queued by guardBefore, surfaced on the next context render).
const REMIND_SEARCH =
  "memo: no memory_search yet this session — search persistent memory before " +
  "acting (memory_search), and memory_save corrections or preferences as they land.";
const REMIND_SKILL =
  "memo: writing a SKILL.md with no skill_put this session — index it with " +
  "skill_put(name, description, body) so future sessions sync it back.";
export const REMIND_DRIFT = (name) =>
  `memo: local ${name}/SKILL.md differs from the indexed copy — re-run ` +
  `skill_sync (or skill_put) to converge before relying on it.`;

// MCP streamable-HTTP requires an `initialize` handshake; every later request
// carries the session id it returns. Lazily opened once, re-opened on expiry.
let _sid = null;
let _ready = false;
let _tail = Promise.resolve();  // rpc calls are serialized (see rpc)

async function rpcPost(method, params, sid) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token()}`,
  };
  if (sid) headers["mcp-session-id"] = sid;
  const r = await fetch(endpoint(), {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: r.status, sid: r.headers.get("mcp-session-id"), text: await r.text() };
}

async function openSession() {
  const r = await rpcPost("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "opencode-memo", version: "3.0.0" },
  }, null);
  if (r.status === 401) throw new Error("memo: unauthorized (check MEMO_TOKEN)");
  if (r.status !== 200) throw new Error(`memo: HTTP ${r.status}`);
  _sid = r.sid ?? null;
  _ready = true;
}

async function rpcCall(method, params) {
  if (!_ready) await openSession();
  let out = await rpcPost(method, params, _sid);
  if (out.status === 400 || out.status === 404) {  // missing/expired session
    await openSession();
    out = await rpcPost(method, params, _sid);
  }
  if (out.status === 401) throw new Error("memo: unauthorized (check MEMO_TOKEN)");
  if (out.status !== 200) throw new Error(`memo: HTTP ${out.status}`);
  return parseRpc(out.text);
}

/** Serialized MCP call. The memo streamable-HTTP server mishandles concurrent
 *  requests on one session (empty/crossed responses, occasional hang), so every
 *  call queues behind the previous one — never two in flight at once. */
function rpc(method, params) {
  const run = _tail.then(() => rpcCall(method, params), () => rpcCall(method, params));
  _tail = run.catch(() => {});
  return run;
}

/** Pull the JSON-RPC payload from either a raw JSON body or an SSE frame
 *  (`event: message\ndata: {...}`). */
function parseRpc(text) {
  const line = text.split(/\r?\n/).map((l) => l.trim())
    .find((l) => l.startsWith("{") || l.startsWith("data:"));
  const payload = line && line.startsWith("data:") ? line.slice(5).trim() : (line ?? text);
  return JSON.parse(payload);
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Canonical body hash: sha256 over the UTF-8 body with surrounding whitespace
 *  trimmed (memo/skills/crud.hash_body_normalized is `body.strip()`), so a
 *  hand-edited trailing newline is hash-invisible (no churn). */
const normHash = (body) => sha256(String(body).trimStart().replace(/\s+$/, ""));

/** The canonical recipe applied to a whole SKILL.md (frontmatter removed). */
export function skillBodyHash(text) {
  return normHash(String(text).split(/^---$/m).slice(2).join("---"));
}

function frontmatterVersion(text) {
  const parts = String(text).split(/^---$/m);
  const fm = parts.length >= 2 ? parts[1] : "";
  const m = fm.match(/^version:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

// ─── per-sync snapshot (.memo-sync.json) ─────────────────────────────────────
// Durable drift state, written BESIDE the skills dir (never inside it, so it
// can never collide with a skill name or a sync delta). Read only on
// sync/drift-check; no timers, no background polling (M-030 preserved).
// Also carries the server-minted agent_id: stored from every sync response and
// presented on every subsequent skill_sync (absent on first run -> omitted, the
// server mints; a re-mint overwrites — the old id is dead by definition).
const SNAPSHOT_NAME = ".memo-sync.json";
const snapshotPath = (skillsDir) => path.join(path.dirname(skillsDir), SNAPSHOT_NAME);

async function readSnapshot(skillsDir) {
  try {
    const snap = JSON.parse(await fs.readFile(snapshotPath(skillsDir), "utf8"));
    if (snap && typeof snap === "object" && snap.skills
        && typeof snap.skills === "object") return snap;
  } catch { /* missing/corrupt: treat as empty, the next sync rebuilds it */ }
  return { version: 1, synced_at: null, agent_id: null, skills: {} };
}

// Local skill dirs -> { name: {hash, version} } via the canonical recipe.
async function scanLocal(skillsDir) {
  const out = {};
  let names = [];
  try {
    names = await fs.readdir(skillsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const t = await fs.readFile(path.join(skillsDir, n, "SKILL.md"), "utf8");
      out[n] = { hash: skillBodyHash(t), version: frontmatterVersion(t) };
    } catch { /* missing/unreadable: treated as absent (locally-deleted) */ }
  }
  return out;
}

/** Per-skill classification BEFORE the MCP call (pure fs + snapshot, no
 *  network). Returns {known, deleted}:
 *   unchanged  -> local hash == snapshot hash: send the snapshot (server) hash
 *   dirty      -> send the current local hash; the server diffs and decides
 *   deleted    -> snapshot entry, file gone: nudge only, NEVER push a delete
 *   untracked  -> no snapshot entry: omitted, so the server sends it if it has
 *                 it and never deletes a local-only name (matches sync_files'
 *                 unknown-name handling). */
export async function classifySync(skillsDir, snapshot) {
  const local = await scanLocal(skillsDir);
  const known = [];
  const deleted = [];
  for (const [name, snap] of Object.entries(snapshot?.skills ?? {})) {
    const l = local[name];
    if (!l) { deleted.push(name); continue; }
    known.push({ name, hash: l.hash === snap.hash ? snap.hash : l.hash });
  }
  return { known, deleted };
}

function deletedNudge(deleted) {
  if (!deleted.length) return "";
  return `memo: skill file(s) gone locally but still tracked: ${deleted.join(", ")}. ` +
    "Local deletion is never pushed; if it was intended, tombstone them " +
    "explicitly (memory_delete/skill tombstone path), else the next sync restores them.";
}

/** Pure-fs drift check (local-vs-snapshot, NO MCP call). Server-vs-snapshot
 *  still needs the one lightweight skill_sync read; this covers the rest. */
export async function driftNudge(skillsDir) {
  const dir = skillsDir ?? defaultSkillsDir();
  const { deleted } = await classifySync(dir, await readSnapshot(dir));
  return deletedNudge(deleted);
}

// Post-apply snapshot: server-provided hash where a write just landed, the
// local recipe hash where the file is local-authoritative. The server-minted
// agent_id is stored too — a fresh id wins, a response without one keeps the
// prior (so a no-op sync never drops it).
async function writeSnapshot(skillsDir, delta, prevAgentId) {
  const writes = new Map();
  for (const f of delta.files_to_write ?? []) {
    writes.set(f.path.replace(/^skills\//, "").split("/")[0], f);
  }
  const local = await scanLocal(skillsDir);
  const skills = {};
  for (const [name, info] of Object.entries(local)) {
    const w = writes.get(name);
    skills[name] = { hash: w ? w.hash : info.hash, version: info.version };
  }
  const snap = { version: 1, synced_at: new Date().toISOString(),
    agent_id: delta.agent_id ?? prevAgentId ?? null, skills };
  try {
    await fs.writeFile(snapshotPath(skillsDir), JSON.stringify(snap, null, 2), "utf8");
  } catch { /* best-effort: a missing snapshot just re-classifies as untracked */ }
}

/** Apply a skill_sync file delta (deletes THEN writes) into `dir`. Shared by
 *  onSessionStart and the skill_create tool so the session view converges
 *  without duplicate delta logic. Classifies against the snapshot first (no
 *  MCP for local-vs-snapshot), then persists the post-apply snapshot.
 *  Returns {delta, deleted}; `deleted` is the locally-gone tracked names. */
async function syncApply(dir) {
  const snap = await readSnapshot(dir);
  const { known, deleted } = await classifySync(dir, snap);
  const args = { harness: "opencode", capabilities: ["persist"], known };
  if (snap.agent_id) args.agent_id = snap.agent_id;  // present the stored id
  const sync = await rpc("tools/call", { name: "skill_sync", arguments: args });
  const delta = JSON.parse(sync.result.content[0].text);
  for (const f of delta.files_to_delete ?? [])
    await fs.rm(path.join(dir, f.path.replace(/^skills\//, "")), { force: true });
  for (const f of delta.files_to_write ?? []) {
    const p = path.join(dir, f.path.replace(/^skills\//, ""));
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, f.content, "utf8");
  }
  await writeSnapshot(dir, delta, snap.agent_id);
  return { delta, deleted };
}

/** Read a local SKILL.md, parse its frontmatter, and upsert it via skill_put
 *  (source='local-hook'). Returns the parsed receipt, or null when the
 *  frontmatter lacks name/description. One push path for the tool + push leg. */
async function pushSkill(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const meta = Object.fromEntries(
    (text.split("---")[1] ?? "").split("\n").filter((l) => l.includes(":"))
      .map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const body = text.split(/^---$/m).slice(2).join("---").trimStart();
  if (!meta.name || !meta.description) return null;
  const res = await rpc("tools/call", { name: "skill_put",
    arguments: { name: meta.name, description: meta.description, body, source: "local-hook" } });
  try { return JSON.parse(res.result.content[0].text); } catch { return res; }
}

/** Pure string op: append the hermes block + frozen snapshots. No MCP call.
 *  The block falls back to FALLBACK_BLOCK so orientation is never empty. */
export async function transform(systemText, { memoryMd = "", userMd = "" } = {}) {
  let block = "";
  try {
    block = await fs.readFile(HERMES_BLOCK, "utf8");
  } catch {
    block = "";
  }
  return [systemText.trim(), block.trim() || FALLBACK_BLOCK,
    memoryMd.trim(), userMd.trim()].filter(Boolean).join("\n\n");
}

/** Session open: resource summary + skill_sync deltas (deletes THEN writes).
 *  Returns {summary, applied, nudge} or {stale:true, warning} — never throws. */
export async function onSessionStart({ skillsDir, memoryPath, userPath } = {}) {
  const dir = skillsDir ?? defaultSkillsDir();
  try {
    const [sum, { delta, deleted }] = await Promise.all([
      rpc("resources/read", { uri: "memo://summary" }),
      syncApply(dir),
    ]);
    const summary = sum.result.contents[0].text;
    if (memoryPath) await fs.writeFile(memoryPath, summary.slice(0, 4000), "utf8").catch(() => {});
    if (userPath) await fs.writeFile(userPath, summary.slice(0, 2200), "utf8").catch(() => {});
    return { summary, applied: (delta.files_to_write ?? []).length,
      nudge: deletedNudge(deleted) };
  } catch (e) {
    console.warn(`memo session start: ${e.message} — continuing with stale .md`);
    return { stale: true, warning: String(e.message ?? e) };
  }
}

// ─── Harness-side skill_create tool ───────────────────────────────────────────
/** Write <skills-dir>/<name>/SKILL.md locally, then auto-push it via skill_put
 *  and refresh the sync view (re-applying any pending delta). Fields mirror the
 *  server skill_put shape (name/description/body). No server-side tool exists —
 *  this is the plugin-side create path. */
export function createSkillCreateTool({ skillsDir } = {}) {
  return {
    name: "skill_create",
    description: `Create a reusable skill: write <skills-dir>/<name>/SKILL.md locally, then index it on the memo server.

Use after a workflow worth repeating (5+ tool calls, a non-obvious fix, a multi-step process likely needed again).
The file is written locally, pushed with skill_put, and the session skill view is refreshed — no separate skill_put call needed.`,
    input: {
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
          maxLength: 64,
          description: "Skill name: lowercase, hyphen-separated (e.g. 'deploy-to-aws')",
        },
        description: {
          type: "string",
          minLength: 10,
          maxLength: 200,
          description: "One-line description shown for skill selection (be specific)",
        },
        body: {
          type: "string",
          minLength: 50,
          description: "Full skill content in Markdown: steps, commands, pitfalls.",
        },
      },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },
    async execute(args) {
      const dir = skillsDir ?? defaultSkillsDir();
      const name = String(args?.name ?? "");
      const description = String(args?.description ?? "");
      const body = String(args?.body ?? "");
      const filePath = path.join(dir, name, "SKILL.md");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath,
        `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, "utf8");
      let receipt = null;
      try {
        receipt = await pushSkill(filePath);
        await syncApply(dir);
      } catch (e) {
        console.warn(`memo skill_create: ${e.message} — file written, push deferred`);
      }
      const where = receipt
        ? `indexed (v${receipt.version}, ${String(receipt.hash ?? "").slice(0, 12)})`
        : "written; server push deferred (offline)";
      return { content: `Skill '${name}' ${where} at ${filePath}.` };
    },
  };
}

// ─── execute.before guard: reminders, never blocks ────────────────────────────
// Memo's MCP tools arrive as `<server>_<tool>` (or `<server>.<tool>`); match on
// the suffix so the guard survives a server rename. `skill_create` is the
// harness-side tool this plugin registers (it auto-pushes, so it counts as a put).
const MEMORY_TOOLS = [
  "memory_search", "memory_save", "memory_delete",
  "skill_create", "skill_put", "skill_get", "skill_sync", "skill_install",
  "skill_update",
];

function memoTool(name) {
  return MEMORY_TOOLS.find(
    (t) => name === t || name.endsWith(`_${t}`) || name.endsWith(`.${t}`)) ?? null;
}

/** True for tools that load a skill body by name (drift check-on-use). */
function isSkillUse(tool) {
  const t = String(tool);
  return t === "skill" || t.endsWith("_skill") || t.endsWith(".skill");
}

/** Per-session guard state — plain data, owned by plugin.js. */
export function createGuard() {
  return { searched: false, put: false, nudged: new Set(), pending: [] };
}

/** Drift nudge (check-on-use). Local-vs-snapshot is a pure fs check (NO MCP);
 *  only when that agrees does it spend the ONE skill_get read to compare
 *  server-vs-snapshot. Queues a re-sync reminder on mismatch. Signal only —
 *  fire-and-forget, never blocks, never throws, never overwrites. */
async function checkDrift(name, skillsDir, g) {
  try {
    const dir = skillsDir ?? defaultSkillsDir();
    const snap = (await readSnapshot(dir))?.skills?.[name] ?? null;
    let localHash = null;
    try {
      localHash = skillBodyHash(
        await fs.readFile(path.join(dir, name, "SKILL.md"), "utf8"));
    } catch { /* no local copy -> treated as drift if the server has one */ }
    // A local file that differs from the durable snapshot is drift on its own.
    if (snap && localHash !== null && localHash !== snap.hash) {
      if (!g.nudged.has(`drift:${name}`)) {
        g.nudged.add(`drift:${name}`);
        g.pending.push(REMIND_DRIFT(name));
      }
      return;
    }
    const res = await rpc("tools/call", { name: "skill_get", arguments: { name } });
    const server = JSON.parse(res.result.content[0].text);
    // skill_get.hash is the RAW stored hash (crud.get), so compare through the
    // normalized recipe via the returned body — otherwise a whitespace-only
    // difference reads as drift on every use.
    const serverHash = typeof server?.body === "string" ? normHash(server.body) : server?.hash;
    if (serverHash && serverHash !== localHash
        && !g.nudged.has(`drift:${name}`)) {
      g.nudged.add(`drift:${name}`);
      g.pending.push(REMIND_DRIFT(name));
    }
  } catch { /* offline / missing / not_found: no signal, never throws */ }
}

function maybeDrift(event, g, skillsDir) {
  const name = String(event?.input?.name ?? event?.input?.skill ?? "").trim();
  if (name) checkDrift(name, skillsDir, g);
}

/** Records memory usage and queues at most one reminder per trigger per session.
 *  Never throws, never blocks, never mutates the tool input (M-026 preserved):
 *  the tool runs unchanged and the reminder surfaces on the next context render.
 *  On skill use it also fires a non-blocking drift check (see checkDrift). */
export function guardBefore(event, g, { skillsDir } = {}) {
  const tool = String(event?.tool ?? "");
  const hit = memoTool(tool);
  if (hit) {
    if (hit === "memory_search" || hit === "memory_save") g.searched = true;
    if (hit === "skill_put" || hit === "skill_create") g.put = true;
    if (hit === "skill_get") maybeDrift(event, g, skillsDir);
    return;
  }
  if (isSkillUse(tool)) maybeDrift(event, g, skillsDir);
  const input = event?.input ?? {};
  const p = String(input.path ?? input.filePath ?? "").replace(/\\/g, "/");
  if (/\/SKILL\.md$/i.test(p)) {
    if (!g.put && !g.nudged.has("skill")) {
      g.nudged.add("skill");
      g.pending.push(REMIND_SKILL);
    }
    return;
  }
  if (!g.searched && !g.nudged.has("search")) {
    g.nudged.add("search");
    g.pending.push(REMIND_SEARCH);
  }
}

// ─── execute.after: push leg for externally-written SKILL.md files ────────────
const _timers = new Map();

/** Map either a file-write path (string) or a native skill tool event
 *  ({tool:"skill_create"|"skill_update", input:{name}}) to a SKILL.md path.
 *  Restored from 216a806; separators are normalized so a forward-slash write
 *  matches on Windows. The path (or native event) IS the disk evidence. */
export function resolveSkillPath(event, skillsDir) {
  if (typeof event === "string") {
    return event.replace(/\\/g, "/").includes("/skills/") && event.endsWith("SKILL.md")
      ? event : null;
  }
  const tool = event?.tool;
  if ((tool === "skill_create" || tool === "skill_update") && event?.input?.name) {
    return path.join(skillsDir ?? defaultSkillsDir(), `${event.input.name}`, "SKILL.md");
  }
  return null;
}

/** After hook: skills/**\/SKILL.md writes AND native skill_create/skill_update
 *  tool events -> skill_put(source='local-hook'). Debounced 2s per resolved
 *  path; logs, never throws. */
export function onAfterWrite(event, { skillsDir } = {}) {
  const filePath = resolveSkillPath(event, skillsDir);
  if (!filePath) return;
  clearTimeout(_timers.get(filePath));
  _timers.set(filePath, setTimeout(async () => {
    try {
      await pushSkill(filePath);
    } catch (e) {
      console.warn(`memo after-write: ${e.message}`);
    }
  }, 2000));
}

// Constant-time local compare helper (re-exported for tests/consumers).
export function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
