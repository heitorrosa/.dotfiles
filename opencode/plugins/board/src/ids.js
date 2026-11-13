// Stable, filename-safe identifiers and the "[task;worktree]" header.
// ESM, Node built-ins only. No plugin imports.

const ID_RE = /^[A-Za-z0-9_-]+$/;
const HEADER_RE = /^\[([^;\[\]\s]*);([^;\[\]\s]*)\]\s?/;

/**
 * "t-<base36 timestamp>-<hex4>"
 * The random suffix keeps ids unique inside one millisecond.
 */
export function taskId(now = Date.now(), rand = Math.random) {
  const stamp = Math.floor(Number(now) || 0).toString(36);
  let n = 0;
  try {
    n = Math.floor((Number(rand()) || 0) * 0x10000);
  } catch {
    n = 0;
  }
  const hex = (n & 0xffff).toString(16).padStart(4, "0");
  return `t-${stamp}-${hex}`;
}

export function worktreeIdFor(taskIdValue) {
  return `wt-${String(taskIdValue ?? "")}`;
}

export function headerFor(taskIdValue, worktreeId) {
  return `[${String(taskIdValue ?? "")};${String(worktreeId ?? "")}]`;
}

/**
 * Parse the first non-empty line as a header.
 * -> { ok, taskId, worktreeId, rest }
 * `rest` is everything after the header line (never includes it).
 */
export function parseHeader(text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const lines = raw.split(/\r?\n/);
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first === -1) {
    return { ok: false, taskId: null, worktreeId: null, rest: "" };
  }
  const line = lines[first].trim();
  const match = HEADER_RE.exec(line);
  const rest = lines.slice(first + 1).join("\n");
  if (!match) {
    return { ok: false, taskId: null, worktreeId: null, rest: raw };
  }
  const taskIdValue = match[1];
  const worktreeId = match[2];
  if (
    !taskIdValue ||
    !worktreeId ||
    !ID_RE.test(taskIdValue) ||
    !ID_RE.test(worktreeId)
  ) {
    return { ok: false, taskId: null, worktreeId: null, rest: raw };
  }
  return { ok: true, taskId: taskIdValue, worktreeId, rest };
}

/**
 * Reduce a value to a safe path/name fragment: [A-Za-z0-9_-], capped at max.
 */
export function sanitize(value, max = 128) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 128;
  const clean = String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, limit);
  return clean || "default";
}
