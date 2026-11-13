// Derived metrics. Authoritative state is the task record; these are views.

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asTaskList(tasks) {
  if (!tasks) return [];
  if (Array.isArray(tasks)) return tasks.filter(Boolean);
  if (Array.isArray(tasks.tasks)) return tasks.tasks.filter(Boolean);
  if (tasks.tasks && typeof tasks.tasks === "object") {
    const order = Array.isArray(tasks.order) ? tasks.order : Object.keys(tasks.tasks);
    const seen = new Set();
    const list = [];
    for (const id of order) {
      const task = tasks.tasks[id];
      if (task) {
        seen.add(id);
        list.push(task);
      }
    }
    for (const [id, task] of Object.entries(tasks.tasks)) {
      if (!seen.has(id) && task) list.push(task);
    }
    return list;
  }
  if (typeof tasks === "object") return Object.values(tasks).filter((v) => v && typeof v === "object" && v.id);
  return [];
}

/** Stable per-task metrics object. */
export function taskMetrics(task, at = Date.now()) {
  const t = task && typeof task === "object" ? task : {};
  const metrics = t.metrics && typeof t.metrics === "object" ? t.metrics : {};
  const msgs = metrics.msgs && typeof metrics.msgs === "object" ? metrics.msgs : {};
  const tokens = metrics.tokens && typeof metrics.tokens === "object" ? metrics.tokens : {};
  const start = num(t.started_at || t.created_at, 0) || null;
  const end = num(t.ended_at, 0) || null;
  const now = num(at, Date.now());
  const lastEvent = num(metrics.last_event_at, 0);
  const worktree = t.worktree && typeof t.worktree === "object" ? t.worktree : null;

  return {
    id: t.id || null,
    title: t.title || "",
    status: t.status || "unknown",
    agent: t.agent || "worker",
    attempts: num(t.attempts, 0),
    max_attempts: num(t.max_attempts, 0),
    elapsed_ms: start ? Math.max(0, (end || now) - start) : 0,
    steps: num(metrics.steps, 0),
    tool_calls: num(metrics.tool_calls, 0),
    rounds: num(metrics.rounds, num(t.rounds, 0)),
    stalls: num(metrics.stalls, 0),
    messages: {
      INFO: num(msgs.INFO, 0),
      ASK: num(msgs.ASK, 0),
      RESULT: num(msgs.RESULT, 0),
      HOLD: num(msgs.HOLD, 0),
      VETO: num(msgs.VETO, 0),
      WARN: num(msgs.WARN, 0),
    },
    tokens: {
      input: num(tokens.input, 0),
      output: num(tokens.output, 0),
      cache_read: num(tokens.cache_read, 0),
      cache_write: num(tokens.cache_write, 0),
    },
    cost: num(metrics.cost, num(t.cost, 0)),
    last_event_age_ms: lastEvent ? Math.max(0, now - lastEvent) : null,
    last_post_seq: num(t.last_post_seq, 0),
    last_post_at: num(t.last_post_at, 0) || null,
    session_id: t.session_id || null,
    worktree: worktree
      ? {
          id: worktree.id || null,
          path: worktree.path || null,
          branch: worktree.branch || null,
          removed: worktree.removed === true,
        }
      : null,
    stall_flags: Array.isArray(t.stall_flags) ? [...t.stall_flags] : [],
  };
}

/** Board-wide counts. Accepts Task[], {tasks, order}, or {[id]: Task}. */
export function boardMetrics(tasks, config = {}) {
  const list = asTaskList(tasks);
  const by_status = {};
  const by_agent = {};
  let unacked_asks = 0;
  let total_msgs = 0;
  let stalls = 0;

  for (const task of list) {
    const status = task.status || "unknown";
    by_status[status] = (by_status[status] || 0) + 1;
    const agent = task.agent || "worker";
    by_agent[agent] = (by_agent[agent] || 0) + 1;
    const metrics = task.metrics || {};
    const msgs = metrics.msgs || {};
    if (status === "waiting" || status === "blocked") unacked_asks += 1;
    total_msgs += num(msgs.INFO, 0) + num(msgs.ASK, 0) + num(msgs.RESULT, 0);
    stalls += num(metrics.stalls, 0);
  }

  const count = (statuses) => statuses.reduce((sum, s) => sum + (by_status[s] || 0), 0);
  const running = count(["dispatching", "running"]);
  const queue = count(["queued", "ready"]);
  const maxWorkers = num(config.max_workers, 0);

  return {
    total: list.length,
    by_status,
    by_agent,
    queue,
    ready: by_status.ready || 0,
    running,
    stalled: by_status.stalled || 0,
    waiting: by_status.waiting || 0,
    blocked: by_status.blocked || 0,
    review: by_status.review || 0,
    done: by_status.done || 0,
    failed: by_status.failed || 0,
    unacked_asks,
    total_stall_flags: stalls,
    msgs: total_msgs,
    free_slots: maxWorkers ? Math.max(0, maxWorkers - running) : null,
  };
}

function columnSpec(columns) {
  if (!columns || !columns.length) return [];
  return columns.map((col) => {
    if (typeof col === "string") return { key: col, label: col };
    return { key: col.key || col.id || String(col.label || ""), label: col.label || col.key || "" };
  });
}

function cellValue(row, key) {
  if (row == null) return "";
  if (typeof row !== "object") return String(row);
  const value = key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), row);
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Plain-text table, no dependencies. */
export function formatTable(rows, columns) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const cols = columnSpec(columns);
  if (!cols.length) return "";
  const cells = list.map((row) => cols.map((col) => cellValue(row, col.key)));
  const widths = cols.map((col, i) => {
    const longest = cells.reduce((max, row) => Math.max(max, byteSafeLength(row[i])), byteSafeLength(col.label));
    return Math.min(Math.max(longest, 1), 48);
  });

  const pad = (value, width) => {
    const text = clip(value, width);
    const gap = Math.max(0, width - byteSafeLength(text));
    return text + " ".repeat(gap);
  };

  const header = cols.map((col, i) => pad(col.label, widths[i])).join(" | ");
  const rule = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = cells.map((row) => row.map((value, i) => pad(value, widths[i])).join(" | "));
  return [header, rule, ...body].join("\n").replace(/ +$/gm, "");
}

function clip(value, max) {
  const text = String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ");
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "\u2026";
}

function byteSafeLength(value) {
  return String(value == null ? "" : value).length;
}
