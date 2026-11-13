// Task records, admission, slots and transitions.
// ESM, Node built-ins only. No plugin imports.

import { headerFor, parseHeader, sanitize, taskId, worktreeIdFor } from "./ids.js";

export const STATUSES = [
  "queued",
  "ready",
  "dispatching",
  "running",
  "idle",
  "waiting",
  "blocked",
  "review",
  "done",
  "failed",
  "stalled",
  "dropped",
  "cancelled",
];

export const WORKSPACES = ["git", "read", "direct", "shadow"];

const TERMINAL = new Set(["done", "failed", "dropped", "cancelled"]);
const SLOT_STATUSES = new Set(["dispatching", "running"]);
const MSG_TYPES = ["INFO", "ASK", "RESULT", "HOLD", "VETO"];

function zeroMetrics(now) {
  return {
    msgs: { INFO: 0, ASK: 0, RESULT: 0, HOLD: 0, VETO: 0 },
    steps: 0,
    tool_calls: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    stalls: 0,
    rounds: 0,
    last_event_at: now,
  };
}

function doneDeps(state, deps) {
  return (deps || []).every((id) => {
    const dep = state.tasks[id];
    return Boolean(dep) && dep.status === "done";
  });
}

export class TaskService {
  constructor({ store, config = {}, worktrees, now = Date.now } = {}) {
    this.store = store;
    this.config = config || {};
    this.worktrees = worktrees || null;
    this.now = now;
  }

  get maxWorkers() {
    const n = Number(this.config.max_workers);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
  }

  async _mutate(root, fn) {
    return this.store.withLock(root, async () => {
      const state = this.store.readTasks(root);
      const result = await fn(state);
      this.store.writeTasks(root, state);
      return result;
    });
  }

  async create(
    root,
    {
      title,
      deps = [],
      brief = "",
      agent = "worker",
      max_attempts = 2,
      files_touched = [],
      workspace = "git",
      shell = false,
    } = {},
  ) {
    const at = this.now();
    const maxAttempts = Number.isFinite(Number(max_attempts))
      ? Math.max(1, Math.floor(Number(max_attempts)))
      : 2;
    const depList = Array.isArray(deps) ? deps.map(String) : [];
    const files = Array.isArray(files_touched) ? files_touched.map(String) : [];
    const mode = WORKSPACES.includes(workspace) ? workspace : "git";

    return this._mutate(root, async (state) => {
      let id = taskId(at);
      let salt = 0;
      while (state.tasks[id]) {
        salt += 1;
        id = taskId(at + salt);
        if (salt > 1000) {
          id = `${taskId(at)}-${state.next_task.toString(36)}`;
          break;
        }
      }
      const wid = worktreeIdFor(id);
      const status = doneDeps(state, depList) ? "ready" : "queued";
      const briefPath =
        typeof brief === "string" && brief.trim() !== ""
          ? brief
          : `.opencode/swarm/briefs/${sanitize(root)}/${id}.md`;

      const task = {
        id,
        root,
        title: typeof title === "string" && title.trim() !== "" ? title.trim() : id,
        status,
        deps: depList,
        agent,
        files_touched: files,
        workspace: mode,
        shell: Boolean(shell),
        worktree: null,
        header: headerFor(id, wid),
        brief: briefPath,
        session_id: null,
        attached: false,
        attempts: 0,
        max_attempts: maxAttempts,
        deadline_at: null,
        created_at: at,
        updated_at: at,
        started_at: null,
        ended_at: null,
        last_post_seq: 0,
        last_post_at: 0,
        last_read_seq: 0,
        rounds: 0,
        metrics: zeroMetrics(at),
      };

      state.tasks[id] = task;
      state.order.push(id);
      state.next_task = (Number(state.next_task) || state.next_seq || 1) + 1;
      state.next_seq = Math.max(Number(state.next_seq) || 1, state.next_task);
      return task;
    });
  }

  async setBrief(root, id, brief) {
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      task.brief = brief;
      task.updated_at = this.now();
      return task;
    });
  }

  get(root, id) {
    const state = this.store.readTasks(root);
    return state.tasks[id] || null;
  }

  list(root, filter = {}) {
    const state = this.store.readTasks(root);
    const rows = state.order.map((id) => state.tasks[id]).filter(Boolean);
    const entries = Object.entries(filter || {}).filter(
      ([, value]) => value !== undefined && value !== null,
    );
    if (entries.length === 0) return rows;
    return rows.filter((task) =>
      entries.every(([key, value]) => {
        if (key === "status") {
          return Array.isArray(value) ? value.includes(task.status) : task.status === value;
        }
        if (key === "text") {
          const needle = String(value).toLowerCase();
          return `${task.id} ${task.title}`.toLowerCase().includes(needle);
        }
        return task[key] === value;
      }),
    );
  }

  runningCount(root) {
    const state = this.store.readTasks(root);
    let count = 0;
    for (const id of state.order) {
      const task = state.tasks[id];
      if (task && SLOT_STATUSES.has(task.status)) count += 1;
    }
    return count;
  }

  async claim(root, id, opts = {}) {
    if (!this.worktrees) throw new Error("TaskService.claim requires worktrees");
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      if (task.worktree && task.worktree.path && !task.worktree.removed) {
        return task;
      }
      const wid = task.worktree?.id || worktreeIdFor(task.id);
      const declared = WORKSPACES.includes(task.workspace) ? task.workspace : "git";
      const mode = WORKSPACES.includes(opts.workspace) ? opts.workspace : declared;
      const baseDir =
        opts.baseDir ||
        this.config.canonical_dir ||
        this.config.checkout ||
        process.cwd();
      const at = this.now();

      // read/direct borrow the canonical checkout: no host worktree, no move.
      if (mode === "read" || mode === "direct") {
        task.worktree = {
          id: wid,
          path: baseDir,
          mode,
          owned: false,
          removed: false,
        };
        task.updated_at = at;
        return task;
      }

      const shadow = mode === "shadow" && typeof this.worktrees.createShadow === "function";
      const created = shadow
        ? await this.worktrees.createShadow(wid, { canonicalDir: baseDir, directory: opts.directory })
        : await this.worktrees.create(wid, this.config.worktree_base);
      if (!created || !created.directory) {
        throw new Error(`worktree creation failed for ${task.id}`);
      }
      task.worktree = {
        id: wid,
        path: created.directory,
        branch: created.branch || `swarm/${task.id}`,
        base: created.base || this.config.worktree_base || "HEAD",
        mode,
        owned: mode === "git",
        removed: false,
      };
      task.updated_at = at;
      return task;
    });
  }

  /**
   * Serialized admission. Validates, checks deps + free slot, reserves the
   * slot by marking `dispatching`. Worktree creation is left to claim.
   */
  async admit(root, header, callerSessionId) {
    const parsed = parseHeader(header);
    if (!parsed.ok) return { ok: false, reason: "invalid header" };
    if (!this.store.isCallerAuthorized(root, callerSessionId)) {
      return { ok: false, reason: "caller not allowed" };
    }

    return this.store.withLock(root, async () => {
      const state = this.store.readTasks(root);
      const task = state.tasks[parsed.taskId];
      if (!task) return { ok: false, reason: "unknown task" };
      if (parsed.worktreeId !== (task.worktree?.id || worktreeIdFor(task.id))) {
        return { ok: false, reason: "header does not match task" };
      }
      if (task.status !== "ready") {
        return { ok: false, reason: `task not ready (${task.status})` };
      }
      if (!doneDeps(state, task.deps)) {
        return { ok: false, reason: "deps not done" };
      }
      if (this.runningCountIn(state) >= this.maxWorkers) {
        return { ok: false, reason: "queue full, wait for a RESULT" };
      }

      const at = this.now();
      task.status = "dispatching";
      task.updated_at = at;
      task.metrics.last_event_at = at;
      this.store.writeTasks(root, state);
      return { ok: true, task };
    });
  }

  runningCountIn(state) {
    let count = 0;
    for (const id of state.order) {
      const task = state.tasks[id];
      if (task && SLOT_STATUSES.has(task.status)) count += 1;
    }
    return count;
  }

  async bindSession(root, id, sessionId) {
    if (!sessionId) return this.get(root, id);
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      if (TERMINAL.has(task.status)) return task;
      if (!SLOT_STATUSES.has(task.status)) return task;
      task.session_id = String(sessionId);
      task.status = "running";
      if (!task.started_at) task.started_at = this.now();
      task.updated_at = this.now();
      return task;
    });
  }

  /**
   * Idempotent for the same session id. Binds an unbound child from the
   * dispatch lease; refuses to steal a different session.
   */
  async attach(root, id, sessionId) {
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      if (task.session_id === sessionId) return task;
      if (task.session_id && task.session_id !== sessionId) return task;
      if (TERMINAL.has(task.status)) return task;

      const at = this.now();
      task.session_id = String(sessionId);
      task.status = "running";
      task.attached = true;
      if (!task.started_at) task.started_at = at;
      task.updated_at = at;
      task.metrics.last_event_at = at;
      return task;
    });
  }

  async transition(root, id, status, patch = {}) {
    if (!STATUSES.includes(status)) {
      throw new Error(`invalid task status '${status}'`);
    }
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      const at = this.now();
      const merged = { ...task, ...patch, id: task.id, root: task.root };
      merged.status = status;
      merged.updated_at = at;
      if (status === "running" && !merged.started_at) merged.started_at = at;
      if (TERMINAL.has(status)) merged.ended_at = merged.ended_at || at;
      if (status === "ready" || status === "queued") {
        merged.ended_at = null;
        merged.attached = false;
      }
      merged.metrics = merged.metrics || zeroMetrics(at);
      merged.metrics.last_event_at = at;
      state.tasks[id] = merged;
      return merged;
    });
  }

  /** Frees a slot after a failed dispatch, incrementing attempts. */
  async release(root, id) {
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      if (!SLOT_STATUSES.has(task.status)) return task;
      const at = this.now();
      task.attempts = (Number(task.attempts) || 0) + 1;
      task.session_id = null;
      task.attached = false;
      task.status =
        task.attempts >= (Number(task.max_attempts) || 2) ? "failed" : "ready";
      task.updated_at = at;
      task.metrics.last_event_at = at;
      if (task.status === "failed") task.ended_at = at;
      else task.ended_at = null;
      return task;
    });
  }

  async promoteReady(root) {
    const promoted = [];
    await this._mutate(root, async (state) => {
      const at = this.now();
      for (const id of state.order) {
        const task = state.tasks[id];
        if (!task || task.status !== "queued") continue;
        if (!doneDeps(state, task.deps)) continue;
        task.status = "ready";
        task.updated_at = at;
        task.metrics.last_event_at = at;
        promoted.push(task.id);
      }
      return promoted;
    });
    return promoted;
  }

  async addPost(root, id, { type = "INFO", seq = 0, at } = {}) {
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      const when = Number.isFinite(at) ? at : this.now();
      const kind = MSG_TYPES.includes(type) ? type : "INFO";
      task.metrics = task.metrics || zeroMetrics(when);
      task.metrics.msgs = task.metrics.msgs || {
        INFO: 0,
        ASK: 0,
        RESULT: 0,
        HOLD: 0,
        VETO: 0,
      };
      task.metrics.msgs[kind] = (Number(task.metrics.msgs[kind]) || 0) + 1;
      task.last_post_seq = Math.max(Number(task.last_post_seq) || 0, Number(seq) || 0);
      task.last_post_at = when;
      task.metrics.last_event_at = when;
      task.updated_at = when;
      return task;
    });
  }

  async addRound(root, id) {
    return this._mutate(root, async (state) => {
      const task = state.tasks[id];
      if (!task) return null;
      const at = this.now();
      task.rounds = (Number(task.rounds) || 0) + 1;
      task.metrics = task.metrics || zeroMetrics(at);
      task.metrics.rounds = (Number(task.metrics.rounds) || 0) + 1;
      task.metrics.last_event_at = at;
      task.updated_at = at;
      return task;
    });
  }

  metrics(root, id) {
    const task = this.get(root, id);
    if (!task) return null;
    return {
      task_id: task.id,
      status: task.status,
      ...task.metrics,
      msgs: { ...task.metrics.msgs },
      tokens: { ...task.metrics.tokens },
    };
  }
}
