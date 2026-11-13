// Card-style session reading: roles, snippets, tool names and key args.
// Full text only when include_body is set, and always under a byte cap.

export const DEFAULTS = {
  limit: 20,
  snippetChars: 140,
  argChars: 90,
  maxBytes: 12_000,
  maxBodyBytes: 24_000,
};

export function bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

export function snippet(text, max = DEFAULTS.snippetChars) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/** Hard byte cap; returns {text, truncated}. */
export function clamp(text, maxBytes = DEFAULTS.maxBytes) {
  const str = String(text == null ? "" : text);
  if (bytes(str) <= maxBytes) return { text: str, truncated: false };
  let out = "";
  let used = 0;
  for (const ch of str) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes - 40) break;
    out += ch;
    used += n;
  }
  return { text: `${out}\n…[truncated ${bytes(str) - used} bytes]`, truncated: true };
}

export function unwrapSession(value) {
  if (!value || typeof value !== "object") return {};
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) return value.data;
  return value;
}

export function unwrapList(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "sessions", "items", "results"]) {
    if (Array.isArray(value[key])) return value[key];
    if (value[key] && typeof value[key] === "object") {
      const inner = unwrapList(value[key]);
      if (inner.length) return inner;
    }
  }
  return [];
}

export function partsOf(message) {
  if (!message || typeof message !== "object") return [];
  if (Array.isArray(message.parts)) return message.parts;
  if (Array.isArray(message.content)) return message.content;
  return [];
}

export function roleOf(message) {
  const inner = message && message.info && typeof message.info === "object" ? message.info : message;
  return String((inner && (inner.role || inner.type)) || "message");
}

export function timestampOf(message) {
  const inner = message && message.info && typeof message.info === "object" ? message.info : message;
  const t = inner && (inner.time || inner.created || inner.ts);
  if (typeof t === "number") return t;
  if (t && typeof t === "object") {
    const n = t.created ?? t.completed ?? t.updated;
    if (typeof n === "number") return n;
  }
  return null;
}

function toolName(part) {
  return String(
    part.tool || part.name || part.toolName
      || (part.state && (part.state.tool || part.state.name)) || "tool",
  );
}

function toolInput(part) {
  const raw = part.input || part.args || (part.state && part.state.input) || null;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function toolOutput(part) {
  if (typeof part.output === "string") return part.output;
  if (typeof part.result === "string") return part.result;
  const st = part.state && typeof part.state === "object" ? part.state : null;
  if (st && typeof st.output === "string") return st.output;
  return null;
}

function toolStatus(part) {
  const st = part.state && typeof part.state === "object" ? part.state : {};
  return String(part.status || st.status || "unknown");
}

const BODY_TOOLS = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);
const READ_TOOLS = new Set(["read", "read_file", "view", "cat"]);

/**
 * Compact description of a tool part. Never returns file bodies unless
 * include_body; for read tools the output is always elided.
 */
export function describeToolPart(part, opts = {}) {
  const includeBody = Boolean(opts.includeBody);
  const argCap = opts.argChars ?? DEFAULTS.argChars;
  const name = toolName(part);
  const input = toolInput(part);
  const output = toolOutput(part);
  const row = { kind: "tool", tool: name, status: toolStatus(part) };

  if (input) {
    const args = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") {
        const bodyish = /content|oldString|newString|text|diff|patch/i.test(key);
        if (bodyish && !includeBody) args[key] = `<${bytes(value)}B>`;
        else args[key] = snippet(value, bodyish ? argCap * 4 : argCap);
      } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
        args[key] = value;
      } else if (Array.isArray(value)) {
        args[key] = `[${value.length}]`;
      } else if (value && typeof value === "object") {
        args[key] = `{${Object.keys(value).slice(0, 6).join(",")}}`;
      }
    }
    row.args = args;
  }

  if (output != null) {
    const elide = !includeBody || READ_TOOLS.has(name) || BODY_TOOLS.has(name);
    row.output = elide ? `<${bytes(output)}B output elided>` : snippet(output, argCap * 4);
    row.output_bytes = bytes(output);
  }
  return row;
}

export function summarizeMessage(message, opts = {}) {
  const limitParts = opts.partsPerMessage ?? 8;
  const rows = [];
  let total = 0;
  for (const part of partsOf(message)) {
    const type = String(part && part.type ? part.type : "");
    if (type === "reasoning" || type === "step-start" || type === "step-finish") continue;
    if (type === "text" && typeof part.text === "string") {
      total += bytes(part.text);
      if (rows.length < limitParts) rows.push({ kind: "text", snippet: snippet(part.text, opts.snippetChars) });
      continue;
    }
    if (type === "file") {
      rows.push({ kind: "file", path: part.path || part.filename || (part.source && part.source.path) || "?" });
      continue;
    }
    if (type === "patch") {
      const files = Array.isArray(part.files) ? part.files.length : 0;
      rows.push({ kind: "patch", files });
      continue;
    }
    if (type === "tool" || part.tool || part.toolName || (part.state && part.state.tool)) {
      if (rows.length < limitParts) rows.push(describeToolPart(part, opts));
    }
  }
  return { role: roleOf(message), at: timestampOf(message), parts: rows, chars: total };
}

function renderSnippetRow(row) {
  if (!row) return "";
  if (row.kind === "text") return `text: ${row.snippet}`;
  if (row.kind === "file") return `file: ${row.path}`;
  if (row.kind === "patch") return `patch: ${row.files} file(s)`;
  if (row.kind === "tool") {
    const args = row.args ? Object.entries(row.args).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    const out = row.output ? ` -> ${row.output}` : "";
    return `tool:${row.tool}${args ? `(${args})` : ""}${out}`;
  }
  return "";
}

/**
 * Render a session read result.
 * @returns {{content:string, stats:object}}
 */
export function renderSessionRead({ session, messages, context } = {}, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULTS.limit, 100));
  const includeTools = opts.includeTools !== false;
  const includeBody = Boolean(opts.includeBody);
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const s = unwrapSession(session);

  const list = unwrapList(messages);
  const total = list.length;
  const slice = total > limit ? list.slice(total - limit) : list;

  const lines = [];
  const id = s.id || s.sessionID || opts.sessionID || "?";
  lines.push(`session ${id}`);
  const meta = [
    s.title ? `title=${snippet(s.title, 80)}` : "",
    s.agent ? `agent=${s.agent}` : "",
    s.parentID ? `parent=${s.parentID}` : "",
    s.directory ? `dir=${s.directory}` : "",
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join("  "));
  lines.push(`messages ${total}${total > slice.length ? ` (showing last ${slice.length})` : ""}`);

  let shown = 0;
  for (const message of slice) {
    const summary = summarizeMessage(message, { ...opts, includeBody });
    const visible = includeTools
      ? summary.parts
      : summary.parts.filter((p) => p.kind === "text" || p.kind === "file");
    shown += 1;
    lines.push(`[${shown}] ${summary.role}`);
    for (const row of visible) {
      const text = renderSnippetRow(row);
      if (text) lines.push(`    ${text}`);
    }
  }

  if (context) {
    const c = unwrapSession(context);
    const ctxList = unwrapList(c.messages || c);
    if (ctxList.length && !total) {
      lines.push(`context messages ${ctxList.length}`);
    }
  }

  const capped = clamp(lines.join("\n"), maxBytes);
  return {
    content: capped.text,
    stats: { messages: total, shown, truncated: capped.truncated, includeBody },
  };
}
