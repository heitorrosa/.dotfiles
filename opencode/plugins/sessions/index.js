// sessions plugin — session lifecycle for the swarm.
//
// Tools: session_list, session_read, session_metrics, session_prompt,
// session_fork. session_prompt is external-only: a subagent (a session with a
// parent) must be prompted through subagent(sessionID=...), never here. Fork
// pointers live in plugin storage ("sessions/forks") or a
// JSON sidecar; promotion re-binds the fork to the swarm board without ever
// touching opencode.db.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPointerStore, forksFallbackPath, isForkTarget } from "./lib/pointer.js";
import { renderSessionRead, unwrapSession, unwrapList, snippet } from "./lib/read.js";
import { sessionMetrics, formatMetrics } from "./lib/metrics.js";
import { createBoardBridge, defaultBoardDir, sanitize } from "./lib/board.js";

const PLUGIN_ID = "sessions";
const PROMOTE_AGENT = "build";

let PluginApi = null;
try {
  const mod = await import("@opencode/plugin");
  PluginApi = (mod && (mod.Plugin || mod.default)) || null;
} catch {
  // Tests and source checks import this module without the host package.
}

function define(spec) {
  if (PluginApi && typeof PluginApi.define === "function") return PluginApi.define(spec);
  return spec;
}

function nowMs() {
  return Date.now();
}

function str(value) {
  return value === undefined || value === null ? "" : String(value);
}

function ok(content) {
  return { content };
}

export function errContent(message, detail) {
  return JSON.stringify({ error: String(message), ...(detail ? { detail } : {}) }, null, 2);
}

function idOf(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  const inner = unwrapSession(value);
  return str(inner.id || inner.sessionID || inner.session?.id) || null;
}

// ── fork via CLI ────────────────────────────────────────────────────────────

export function forkArgs(sessionID, before = null) {
  return [
    "api",
    "post",
    `/api/session/${sessionID}/fork`,
    "--data",
    JSON.stringify({ before: before ?? null }),
  ];
}

export function parseForkOutput(text) {
  const raw = str(text).trim();
  if (!raw) return null;
  const tryParse = (value) => {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return null;
      const id = parsed.id
        || (parsed.data && (parsed.data.id || parsed.data.sessionID))
        || parsed.sessionID
        || (parsed.session && parsed.session.id);
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(raw);
  if (direct) return direct;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const inner = tryParse(raw.slice(start, end + 1));
    if (inner) return inner;
  }
  const m = raw.match(/"id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * Resolve the opencode CLI to an executable Node can spawn with shell:false.
 * A `.cmd`/`.bat` shim needs `cmd.exe /c`; a `.exe` runs directly. Only the
 * command path is quoted by cmd — argv stays separate.
 * @returns {{file:string, prefix:string[], via:string}}
 */
export function resolveCliCommand(cli, platform = process.platform) {
  const explicit = str(cli).trim();
  if (explicit) {
    if (platform === "win32" && /\.(cmd|bat)$/i.test(explicit)) {
      return { file: process.env.ComSpec || "cmd.exe", prefix: ["/c", explicit], via: "cmd" };
    }
    return { file: explicit, prefix: [], via: "direct" };
  }
  if (platform !== "win32") return { file: "opencode", prefix: [], via: "direct" };

  const exe = findOnPath(["opencode.exe", "opencode"]);
  if (exe && /\.exe$/i.test(exe)) return { file: exe, prefix: [], via: "exe" };

  const cmd = findOnPath(["opencode.cmd", "opencode.bat"]) || "opencode.cmd";
  return { file: process.env.ComSpec || "cmd.exe", prefix: ["/c", cmd], via: "cmd" };
}

/**
 * Fallback fork path: one CLI subprocess, no DB writes.
 * @param {string} sessionID
 * @param {null|string} before
 * @param {{spawnFn?:Function, cli?:string, timeoutMs?:number, platform?:string}} [opts]
 * @returns {Promise<string>} new session id
 */
export function forkViaCli(sessionID, before = null, opts = {}) {
  const spawnFn = typeof opts.spawnFn === "function" ? opts.spawnFn : spawn;
  const resolved = resolveCliCommand(opts.cli, opts.platform);
  const timeoutMs = Number(opts.timeoutMs) || 60_000;
  const args = [...resolved.prefix, ...forkArgs(sessionID, before)];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(resolved.file, args, { shell: false, windowsHide: true });
    } catch (err) {
      reject(new Error(`fork spawn failed: ${err && err.message ? err.message : err}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try { child && child.kill && child.kill(); } catch { /* ignore */ }
        finish(reject, new Error(`fork timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : null;
    if (timer && typeof timer.unref === "function") timer.unref();

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 1_000_000) stdout += String(chunk);
      });
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 100_000) stderr += String(chunk);
      });
    }
    if (typeof child.on === "function") {
      child.on("error", (err) => finish(reject, err));
      child.on("close", (code) => {
        const id = parseForkOutput(stdout);
        if (id) return finish(resolve, id);
        const detail = snippet(stderr || stdout, 300);
        finish(reject, new Error(`fork failed (exit ${code})${detail ? `: ${detail}` : ""}`));
      });
    } else {
      finish(reject, new Error("fork spawn returned no child process handle"));
    }
  });
}

// ── promotion ───────────────────────────────────────────────────────────────

async function switchAgent(ctx, sessionID, agent) {
  const api = ctx.session || {};
  try {
    if (typeof api.switchAgent === "function") {
      await api.switchAgent({ sessionID, agent });
      return true;
    }
    if (typeof api.update === "function") {
      await api.update({ sessionID, agent });
      return true;
    }
  } catch { /* fail-open: promotion still proceeds */ }
  return false;
}

export async function promoteFork(ctx, { sourceID, newID, directory, title, agent, rebind = true } = {}) {
  const result = { updated: false, moved: false, agent: null, rebind: null };
  const api = ctx.session || {};

  if (typeof api.update === "function") {
    try {
      const patch = { sessionID: newID };
      if (title) patch.title = String(title);
      await api.update(patch);
      result.updated = true;
    } catch { /* fail-open */ }
  }

  const wantedAgent = agent || PROMOTE_AGENT;
  if (await switchAgent(ctx, newID, wantedAgent)) result.agent = wantedAgent;

  if (directory && typeof api.move === "function") {
    try {
      await api.move({ sessionID: newID, directory: path.resolve(String(directory)) });
      result.moved = true;
    } catch { /* fail-open */ }
  }

  if (rebind) {
    try {
      const bridge = ctx.__sessionsBoard;
      result.rebind = bridge ? bridge.rebind({ sourceID, newID }) : null;
    } catch (err) {
      result.rebind = { ok: false, reason: str(err && err.message) };
    }
  }
  return result;
}

// ── tools ───────────────────────────────────────────────────────────────────

function listRow(session, pointerMap) {
  const s = unwrapSession(session);
  const id = str(s.id || s.sessionID);
  const tokens = s.tokens && typeof s.tokens === "object" ? s.tokens : {};
  const time = s.time && typeof s.time === "object" ? s.time : {};
  const ts = Number(time.updated || time.created) || null;
  return {
    sessionID: id,
    title: s.title ? String(s.title) : null,
    agent: s.agent || null,
    parentID: s.parentID || null,
    directory: s.directory || null,
    updated: ts,
    tokens: Number(tokens.input || 0) + Number(tokens.output || 0),
    cost: Number(s.cost || 0),
    // A fork target is a promoted primary session, not a child lane.
    promoted: isForkTarget(pointerMap, id),
  };
}

function renderListRow(row) {
  const age = row.updated ? `${Math.max(0, Math.round((nowMs() - row.updated) / 60000))}m` : "-";
  const bits = [
    row.sessionID,
    (row.agent || "?").padEnd(8),
    age.padStart(4),
    row.promoted ? "promoted" : "        ",
    row.title ? `"${snippet(row.title, 60)}"` : "",
    row.directory ? `dir=${row.directory}` : "",
    row.tokens ? `tok=${row.tokens}` : "",
    row.cost ? `$${row.cost.toFixed(4)}` : "",
  ].filter(Boolean);
  return bits.join("  ");
}

function makeTools({ ctx, pointers, config, spawnFn }) {
  const tools = [];

  tools.push({
    name: "session_list",
    description:
      "List sessions as compact rows (id, agent, age, title, directory, tokens, cost)." +
      " Promoted forks are reported as primary sessions, not children." +
      " Read-only.",
    input: {
      type: "object",
      properties: {
        parentID: { type: "string", description: "Only children of this session id" },
        directory: { type: "string", description: "Filter by working directory" },
        search: { type: "string", description: "Substring match on title/id" },
        limit: { type: "number", description: "Rows to return (default 20, max 50)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const api = ctx.session || {};
      if (typeof api.list !== "function") return ok(errContent("session.list is unavailable in this host"));
      const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
      const query = {
        parentID: args.parentID || undefined,
        directory: args.directory || undefined,
        search: args.search || undefined,
        limit,
        cursor: args.cursor || undefined,
      };
      const raw = await api.list(query);
      const pointerMap = await pointers.load();
      let rows = unwrapList(raw).map((s) => listRow(s, pointerMap));
      if (query.parentID) {
        // Promoted forks do not belong in a child listing; neither does the
        // parent itself if a host ignores the filter.
        rows = rows.filter((r) => r.parentID === query.parentID && !isForkTarget(pointerMap, r.sessionID));
      }
      if (query.directory) rows = rows.filter((r) => r.directory === query.directory);
      rows = rows.slice(0, limit);
      const head = `sessions ${rows.length}${query.parentID ? ` (parent ${query.parentID})` : ""}`;
      return ok([head, ...rows.map(renderListRow)].join("\n"));
    },
  });

  tools.push({
    name: "session_read",
    description:
      "Summarize a session: message roles, text snippets, tool names and key args." +
      " File bodies are elided unless include_body is true (byte-capped)." +
      " Fork ids resolve to the promoted session.",
    input: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Session id (fork ids resolve through the pointer map)" },
        limit: { type: "number", description: "Messages to show from the tail (default 20, max 100)" },
        include_tools: { type: "boolean", description: "Include tool call rows (default true)" },
        include_body: { type: "boolean", description: "Include full text/file bodies (byte-capped)" },
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const api = ctx.session || {};
      const wanted = str(args.sessionID).trim();
      if (!wanted) return ok(errContent("sessionID is required"));
      const resolved = await pointers.resolve(wanted);
      const sessionID = resolved.sessionID;
      let session = null;
      try {
        if (typeof api.get === "function") session = await api.get({ sessionID });
      } catch (err) {
        return ok(errContent(`session.get failed: ${err && err.message ? err.message : err}`));
      }
      if (!session) return ok(errContent(`session not found: ${sessionID}`));
      let contextData = null;
      if (typeof api.context === "function") {
        try { contextData = await api.context({ sessionID }); } catch { contextData = null; }
      }
      const inner = unwrapSession(contextData || session);
      const messages = Array.isArray(inner.messages)
        ? inner.messages
        : (contextData ? unwrapList(contextData) : Array.isArray(session.messages) ? session.messages : []);
      const out = renderSessionRead(
        { session, messages, context: contextData },
        {
          sessionID,
          limit: args.limit,
          includeTools: args.include_tools !== false,
          includeBody: Boolean(args.include_body),
        },
      );
      const head = resolved.changed ? `resolved ${wanted} -> ${sessionID}\n` : "";
      return ok(head + out.content);
    },
  });

  tools.push({
    name: "session_metrics",
    description:
      "Token, cost, timing, busy/idle and outcome metrics for one session." +
      " Fork ids resolve through the pointer map. Read-only.",
    input: {
      type: "object",
      properties: { sessionID: { type: "string", description: "Session id" } },
      required: ["sessionID"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const api = ctx.session || {};
      const wanted = str(args.sessionID).trim();
      if (!wanted) return ok(errContent("sessionID is required"));
      if (typeof api.get !== "function") return ok(errContent("session.get is unavailable in this host"));
      const resolved = await pointers.resolve(wanted);
      let session = null;
      try {
        session = await api.get({ sessionID: resolved.sessionID });
      } catch (err) {
        return ok(errContent(`session.get failed: ${err && err.message ? err.message : err}`));
      }
      if (!session) return ok(errContent(`session not found: ${resolved.sessionID}`));
      let messages = null;
      if (typeof api.context === "function") {
        try {
          const c = unwrapSession(await api.context({ sessionID: resolved.sessionID }));
          if (Array.isArray(c.messages)) messages = c.messages;
        } catch { /* optional */ }
      }
      const metrics = sessionMetrics(session, { sessionID: resolved.sessionID, messages });
      const head = resolved.changed ? `resolved ${wanted} -> ${resolved.sessionID}\n` : "";
      return ok(head + formatMetrics(metrics) + "\n" + JSON.stringify(metrics));
    },
  });

  tools.push({
    name: "session_prompt",
    description:
      "Send one prompt to an external session. Never use for a subagent; use" +
      " subagent(sessionID=...) instead. Fork ids resolve to the promoted session." +
      " delivery is passed through to the host.",
    input: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Session id (fork ids resolve)" },
        text: { type: "string", description: "Prompt text" },
        delivery: { type: "string", description: "Optional host delivery mode" },
      },
      required: ["sessionID", "text"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const api = ctx.session || {};
      const wanted = str(args.sessionID).trim();
      const text = str(args.text).trim();
      if (!wanted) return ok(errContent("sessionID is required"));
      if (!text) return ok(errContent("text is required"));
      if (typeof api.prompt !== "function") return ok(errContent("session.prompt is unavailable in this host"));
      const resolved = await pointers.resolve(wanted);
      if (typeof api.get !== "function") return ok(errContent("session.get failed: session.get is unavailable in this host"));
      let target;
      try {
        target = unwrapSession(await api.get({ sessionID: resolved.sessionID }));
      } catch (err) {
        return ok(errContent(`session.get failed: ${err && err.message ? err.message : err}`));
      }
      if (target.parentID || target.parent_id) {
        return ok(errContent("session_prompt is for external agents only; use subagent(sessionID=...) for a subagent"));
      }
      const input = { sessionID: resolved.sessionID, text };
      if (args.delivery) input.delivery = String(args.delivery);
      try {
        await api.prompt(input);
      } catch (err) {
        return ok(errContent(`session.prompt failed: ${err && err.message ? err.message : err}`));
      }
      return ok(JSON.stringify({
        sessionID: resolved.sessionID,
        ...(resolved.changed ? { requested: wanted } : {}),
        delivered: true,
        delivery: args.delivery || null,
      }));
    },
  });

  tools.push({
    name: "session_fork",
    description:
      "Fork a session at a point (before=null means now). Registers the fork pointer" +
      " both ways so the old id keeps working. With promote=true it also retitles," +
      " switches to the build agent, optionally moves directory, and re-binds the" +
      " fork to the swarm board (bind entry, cursor/ack seed, task session_id, INFO)." +
      " Never writes opencode.db: uses ctx.session.fork when present, else the CLI.",
    input: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Source session id" },
        before: { type: ["string", "null"], description: "Message id to fork before, or null for now" },
        promote: { type: "boolean", description: "Promote the fork to a primary session (default false)" },
        directory: { type: "string", description: "Move the fork to this directory (promotion only)" },
        title: { type: "string", description: "Title for the fork (promotion only)" },
        agent: { type: "string", description: `Agent after promotion (default ${PROMOTE_AGENT})` },
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const api = ctx.session || {};
      const wanted = str(args.sessionID).trim();
      if (!wanted) return ok(errContent("sessionID is required"));
      const resolved = await pointers.resolve(wanted);
      const sourceID = resolved.sessionID;
      const before = args.before === undefined ? null : args.before;
      const promote = Boolean(args.promote);

      let newID = null;
      let via = "api";
      if (typeof api.fork === "function") {
        try {
          newID = idOf(await api.fork({ sessionID: sourceID, before }));
        } catch (err) {
          return ok(errContent(`session.fork failed: ${err && err.message ? err.message : err}`));
        }
      } else {
        via = "cli";
        try {
          newID = await forkViaCli(sourceID, before, { spawnFn, cli: config.cli, timeoutMs: config.fork_timeout_ms });
        } catch (err) {
          return ok(errContent(`fork failed: ${err && err.message ? err.message : err}`));
        }
      }
      if (!newID) return ok(errContent("fork returned no session id"));

      await pointers.register(sourceID, newID);

      let promotion = null;
      if (promote) {
        promotion = await promoteFork(ctx, {
          sourceID,
          newID,
          directory: args.directory,
          title: args.title,
          agent: args.agent,
          rebind: config.rebind_on_fork !== false,
        });
      }

      return ok(JSON.stringify({
        source: sourceID,
        id: newID,
        via,
        ...(resolved.changed ? { requested: wanted } : {}),
        ...(promotion ? { promotion } : {}),
        pointer: pointers.mode,
      }, null, 2));
    },
  });

  return tools;
}

/** Internal wake: inject a synthetic user message without a model turn. */
export async function wake(ctx, sessionID, text) {
  const api = ctx.session || {};
  if (typeof api.synthetic !== "function") return { ok: false, reason: "synthetic unavailable" };
  try {
    await api.synthetic({ sessionID, text: String(text || "") });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: str(err && err.message) };
  }
}

/**
 * Normalize the host "fork" hook payload. The hook runs for the NEW session:
 * `sessionID` is the fork's id, and the source arrives as a sibling field or
 * as the parent on the session record. Returns `{ sourceID: null }` when the
 * source cannot be established, so callers skip instead of guessing.
 */
export async function forkEventIds(ctx, event) {
  if (!event || typeof event !== "object") return { sourceID: null, newID: null };
  const newID = str(
    event.newSessionID || event.forkSessionID || event.forkID || event.session?.id
      || event.data?.id || event.sessionID,
  ) || null;
  let sourceID = str(
    event.sourceSessionID || event.source || event.parentID
      || event.data?.parentID || event.data?.sourceSessionID,
  ) || null;

  if (!sourceID && newID && typeof ctx?.session?.get === "function") {
    try {
      const inner = unwrapSession(await ctx.session.get({ sessionID: newID }));
      sourceID = str(inner.parentID || inner.parent?.id || inner.sourceID) || null;
    } catch { sourceID = null; }
  }
  if (!sourceID || sourceID === newID) return { sourceID: null, newID };
  return { sourceID, newID };
}

async function registerTools(ctx, tools) {
  const addOne = (editor, tool) => {
    if (!editor) return false;
    if (typeof editor.add === "function") { editor.add(tool); return true; }
    if (typeof editor.define === "function") { editor.define(tool); return true; }
    if (typeof editor.register === "function") { editor.register(tool); return true; }
    return false;
  };
  const toolApi = ctx.tool || {};
  if (typeof toolApi.transform === "function") {
    await toolApi.transform((editor) => {
      for (const tool of tools) addOne(editor, tool);
    });
    return tools.map((t) => t.name);
  }
  if (typeof toolApi.add === "function") {
    for (const tool of tools) toolApi.add(tool);
    return tools.map((t) => t.name);
  }
  if (typeof ctx.addTool === "function") {
    for (const tool of tools) ctx.addTool(tool);
    return tools.map((t) => t.name);
  }
  throw new Error("host exposes no tool registration API (expected ctx.tool.transform)");
}

/**
 * Build the sessions plugin against a ctx. Exported for tests.
 * @param {object} ctx host context
 * @param {object} [deps] { storage, storageKey?, forksPath?, boardDir?, spawnFn?, config?, now? }
 */
export async function setupSessions(ctx, deps = {}) {
  const config = {
    board_dir: deps.boardDir || defaultBoardDir(),
    promote_agent: PROMOTE_AGENT,
    rebind_on_fork: true,
    cli: undefined,
    fork_timeout_ms: 60_000,
    ...(deps.config || {}),
  };

  const pointers = createPointerStore({
    storage: deps.storage !== undefined ? deps.storage : ctx.storage,
    file: deps.forksPath || forksFallbackPath(),
  });
  const board = createBoardBridge({ dir: config.board_dir, now: deps.now || nowMs });
  // promoteFork needs the bridge without threading it through every call.
  ctx.__sessionsBoard = board;

  const tools = makeTools({ ctx, pointers, config, spawnFn: deps.spawnFn });
  const names = await registerTools(ctx, tools);

  const seenForks = new Set();
  const cleanups = [];

  if (typeof ctx.session?.hook === "function") {
    const onFork = async (event) => {
      try {
        const { sourceID, newID } = await forkEventIds(ctx, event);
        if (!sourceID || !newID) return;
        const key = `${sourceID}->${newID}`;
        if (seenForks.has(key)) return;
        seenForks.add(key);
        await pointers.register(sourceID, newID);
        if (config.rebind_on_fork === false) return;
        const bind = board.readBind();
        if (!bind[sanitize(sourceID)]) return;
        board.rebind({ sourceID, newID });
      } catch { /* fail-open: a fork event never breaks the host */ }
    };
    try {
      const off = await ctx.session.hook("fork", onFork);
      if (typeof off === "function") cleanups.push(off);
    } catch { /* host without fork hook */ }
  }

  return {
    id: PLUGIN_ID,
    tools: names,
    pointers,
    board,
    config,
    async cleanup() {
      for (const fn of cleanups) {
        try { fn(); } catch { /* ignore */ }
      }
      try { delete ctx.__sessionsBoard; } catch { /* ignore */ }
    },
  };
}

export default define({
  id: PLUGIN_ID,
  async setup(ctx) {
    return setupSessions(ctx);
  },
});
