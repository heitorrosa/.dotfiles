// Liveness: fan-in of session.* events into one in-memory map, stall rules,
// and rate-limited synthetic nudges. No @opencode/plugin import, no direct
// ctx.session calls: the only outbound channel is the injected `wake`.

import path from "node:path";
import { renderNudge } from "./digest.js";

const DEFAULTS = {
  root: null,
  stall_idle_ms: 300000,
  stall_board_ms: 600000,
  unattached_ms: 120000,
  nudge_after_ms: 180000,
  nudge_interval_ms: 60000,
  max_nudges: 3,
  loop_threshold: 5,
  no_progress_steps: 3,
  await_verdict_ms: 300000,
};

const ACTIVE = new Set(["dispatching", "running"]);

function eventParts(event) {
  const props = (event && (event.properties || event.data)) || event || {};
  return {
    props,
    type: (event && (event.type || event.event || event.name)) || props.type || "",
    sessionId:
      props.sessionID ||
      props.sessionId ||
      props.session_id ||
      (event && (event.sessionID || event.sessionId)) ||
      null,
  };
}

export function createLiveness({ store, tasks, config = {}, wake, now = Date.now, resolveRoot } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const sessions = new Map();
  let ticking = false;
  let stopped = false;
  let timer = null;

  // config.root is the explicit override; otherwise the root resolved from the
  // session bind at ingest time. Never invent a root.
  function rootFor(sessionId) {
    if (cfg.root) return cfg.root;
    if (typeof resolveRoot === "function") {
      try {
        return resolveRoot(sessionId) || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function rootOf(record) {
    return (record && record.root) || cfg.root || null;
  }

  function ensure(sessionId, taskId) {
    let record = sessions.get(sessionId);
    if (!record) {
      record = {
        sessionID: sessionId,
        taskId: taskId || null,
        root: rootFor(sessionId),
        worktreeId: null,
        started_at: 0,
        last_event_at: 0,
        last_step_at: 0,
        busy: false,
        attached: false,
        last_tool: null,
        same_tool_run: 0,
        tool_calls: 0,
        steps: 0,
        stepsWithoutTool: 0,
        tool_in_step: false,
        unread: 0,
        asks: 0,
        nudges: 0,
        last_nudge_at: 0,
        last_nudge_kind: null,
        escalated: false,
        fired: Object.create(null),
        tokens: {},
        cost: 0,
        taskStatus: "unknown",
        lastPostAt: 0,
      };
      sessions.set(sessionId, record);
    }
    if (taskId && !record.taskId) record.taskId = taskId;
    if (!record.root) record.root = rootFor(sessionId);
    return record;
  }

  /**
   * Seed a lane record from the task record on attach/bind, so the context
   * hook renders a board block before any session event arrives.
   */
  function seed(sessionId, patch = {}) {
    if (!sessionId) return null;
    const record = ensure(sessionId, patch.taskId);
    if (patch.taskId) record.taskId = String(patch.taskId);
    if (patch.root) record.root = String(patch.root);
    if (patch.worktreeId) record.worktreeId = String(patch.worktreeId);
    if (patch.attached != null) record.attached = Boolean(patch.attached);
    if (patch.status) record.taskStatus = String(patch.status);
    if (patch.lastPostAt != null) record.lastPostAt = Number(patch.lastPostAt) || 0;
    return record;
  }

  function touch(record, timestamp) {
    record.last_event_at = timestamp;
    // A new event is a fresh epoch: stalled flags may fire again.
    record.fired = Object.create(null);
  }

  function ingest(event) {
    if (stopped || !event) return;
    const { props, type, sessionId } = eventParts(event);
    if (!sessionId) return;
    const taskId = props.taskID || props.task_id || props.taskId || null;
    const record = ensure(sessionId, taskId);
    const timestamp = now();
    touch(record, timestamp);

    switch (type) {
      case "session.execution.started":
        record.busy = true;
        record.started_at = record.started_at || timestamp;
        record.stepsWithoutTool = 0;
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        record.busy = false;
        record.outcome = type;
        break;
      case "session.step.started":
        record.busy = true;
        record.steps += 1;
        record.last_step_at = timestamp;
        record.tool_in_step = false;
        break;
      case "session.step.ended":
      case "session.step.failed":
        record.last_step_at = timestamp;
        if (!record.tool_in_step) record.stepsWithoutTool += 1;
        record.tool_in_step = false;
        break;
      case "session.tool.called": {
        const tool = props.tool || props.name || props.toolName || props.tool_name || "unknown";
        if (record.last_tool === tool) record.same_tool_run += 1;
        else {
          record.last_tool = tool;
          record.same_tool_run = 1;
        }
        record.tool_calls += 1;
        record.tool_in_step = true;
        record.stepsWithoutTool = 0;
        break;
      }
      case "session.tool.success":
        record.same_tool_run = 0;
        break;
      case "session.tool.failed":
        record.same_tool_run += 1;
        break;
      case "session.inbox.delivered": {
        record.unread += 1;
        const messageType = String(
          props.messageType || props.kind || props.message_type || props.type || "",
        ).toUpperCase();
        if (messageType === "ASK") record.asks += 1;
        break;
      }
      case "session.idle":
        record.busy = false;
        record.idle_at = timestamp;
        break;
      case "session.usage.updated":
        if (props.tokens && typeof props.tokens === "object") {
          record.tokens = { ...record.tokens, ...props.tokens };
        }
        if (props.cost != null) record.cost = Number(props.cost) || 0;
        break;
      case "worktree.updated":
        if (props.attached != null) record.attached = Boolean(props.attached);
        if (props.path) record.worktree_path = props.path;
        break;
      case "board.task.attached":
      case "session.task.bound":
        record.attached = true;
        if (props.taskID || props.task_id) record.taskId = props.taskID || props.task_id;
        break;
      default:
        break;
    }

    if (props.attached === true) record.attached = true;
    if (props.header && typeof props.header === "string") {
      const match = /^\[([A-Za-z0-9_-]+);([A-Za-z0-9_-]+)\]/.exec(props.header.trim());
      if (match && !record.taskId) record.taskId = match[1];
    }
  }

  async function resolveTask(record) {
    if (!tasks) return null;
    const root = rootOf(record);
    if (!root) return null;
    try {
      if (record.taskId && typeof tasks.get === "function") {
        const task = await tasks.get(root, record.taskId);
        if (task) return task;
      }
      if (!record.taskId && typeof tasks.list === "function") {
        const list = (await tasks.list(root, {})) || [];
        const found = list.find((task) => task.session_id === record.sessionID);
        if (found) {
          record.taskId = found.id;
          return found;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  async function persist(record) {
    if (!store || !record.taskId) return;
    try {
      const dir = typeof store.metricsDir === "function" ? store.metricsDir(rootOf(record)) : null;
      if (!dir || typeof store.writeJsonAtomic !== "function") return;
      store.writeJsonAtomic(path.join(dir, `${record.taskId}.json`), {
        sessionID: record.sessionID,
        task_id: record.taskId,
        started_at: record.started_at,
        last_event_at: record.last_event_at,
        last_step_at: record.last_step_at,
        attached: record.attached,
        last_tool: record.last_tool,
        same_tool_run: record.same_tool_run,
        steps_without_tool: record.stepsWithoutTool,
        steps: record.steps,
        tool_calls: record.tool_calls,
        nudges: record.nudges,
        last_nudge_at: record.last_nudge_at,
        tokens: record.tokens,
        cost: record.cost,
        idle_at: record.idle_at || 0,
        stall_kind: record.stall_kind || null,
        stalled: record.escalated,
      });
    } catch {
      /* metrics persistence is best-effort */
    }
  }

  async function postWarn(record, kind) {
    if (!store || typeof store.withLock !== "function" || typeof store.readBoard !== "function" || typeof store.writeBoard !== "function") {
      return;
    }
    const root = rootOf(record);
    if (!root) return;
    try {
      await store.withLock(root, async () => {
        const board = (await store.readBoard(root)) || {};
        board.messages = Array.isArray(board.messages) ? board.messages : [];
        const seq = Number(board.next_seq) || 1;
        board.messages.push({
          id: `warn-${seq}-${record.taskId || "unbound"}`,
          seq,
          from: "board",
          to: "main",
          type: "ASK",
          body: `[board] STALL:${kind} task=${record.taskId || "?"}. ${record.nudges} nudges with no progress; awaiting a human/main decision.`,
          reply_to: null,
          ts: now(),
          task_id: record.taskId || undefined,
        });
        board.next_seq = seq + 1;
        await store.writeBoard(root, board);
      });
    } catch {
      /* warn post is best-effort */
    }
  }

  async function escalate(record, kind) {
    if (record.escalated) return;
    record.escalated = true;
    const root = rootOf(record);
    if (record.taskId && tasks && typeof tasks.transition === "function") {
      try {
        await tasks.transition(root, record.taskId, "stalled", { stall_kind: kind, stalled_at: now() });
      } catch {
        /* the record may already be terminal */
      }
    }
    if (record.taskId && tasks && typeof tasks.addPost === "function") {
      try {
        await tasks.addPost(root, record.taskId, { type: "ASK", seq: 0, at: now() });
      } catch {
        /* counter bump is best-effort */
      }
    }
    await postWarn(record, kind);
  }

  async function maybeNudge(record, kind) {
    const timestamp = now();
    // nudge_after_ms gates the first nudge for a lane; later nudges use the
    // per-lane interval below.
    if (
      record.nudges === 0 &&
      timestamp - (record.started_at || record.last_event_at || timestamp) < cfg.nudge_after_ms
    ) {
      return null;
    }
    if (record.nudges >= cfg.max_nudges) {
      await escalate(record, kind);
      return null;
    }
    if (record.last_nudge_at && timestamp - record.last_nudge_at < cfg.nudge_interval_ms) {
      return null; // one nudge per lane per 60s
    }
    record.nudges += 1;
    record.last_nudge_at = timestamp;
    record.last_nudge_kind = kind;

    const payload = {
      sessionID: record.sessionID,
      taskId: record.taskId,
      kind,
      header: record.taskId ? `[${record.taskId};wt-${record.taskId}]` : undefined,
      text: renderNudge(kind, {
        taskId: record.taskId,
        worktreeId: record.taskId ? `wt-${record.taskId}` : undefined,
        header: record.taskId ? `[${record.taskId};wt-${record.taskId}]` : undefined,
        tool: record.last_tool,
        steps: record.stepsWithoutTool,
        sinceSec: Math.round((timestamp - (record.lastPostAt || record.started_at || timestamp)) / 1000),
      }),
    };

    if (typeof wake === "function") {
      try {
        // Injected wake signature: wake(target, text). Prefer the stable task
        // id; the host resolves it to the lane's current session.
        await wake(record.taskId || record.sessionID, payload.text);
      } catch {
        /* a failed wake must not break the tick */
      }
    }
    await persist(record);
    return payload;
  }

  function flagsFor(record, task, timestamp) {
    // Only lanes with a task are stall-flag eligible; the main session has no taskId.
    if (!record.taskId) return [];
    const flags = [];
    const status = (task && task.status) || record.taskStatus || "unknown";
    if (record.busy && record.last_event_at && timestamp - record.last_event_at > cfg.stall_idle_ms) {
      flags.push("IDLE");
    }
    if (record.same_tool_run >= cfg.loop_threshold) flags.push("LOOP");
    else if (record.stepsWithoutTool >= cfg.no_progress_steps) flags.push("NO_PROGRESS");
    const lastPost = record.lastPostAt || (task && (task.last_post_at || task.started_at || task.created_at)) || 0;
    if (ACTIVE.has(status) && lastPost && timestamp - lastPost > cfg.stall_board_ms) flags.push("UNREPORTED");
    if (status === "review" && lastPost && timestamp - lastPost > cfg.await_verdict_ms) flags.push("AWAIT_VERDICT");
    if (
      ACTIVE.has(status) &&
      !record.attached &&
      record.started_at &&
      timestamp - record.started_at > cfg.unattached_ms
    ) {
      flags.push("UNATTACHED");
    }
    return flags;
  }

  async function tick() {
    if (ticking || stopped) return [];
    ticking = true;
    const nudges = [];
    try {
      for (const record of sessions.values()) {
        if (stopped) break;
        const task = await resolveTask(record);
        if (task) {
          record.taskStatus = task.status || record.taskStatus;
          record.taskId = task.id || record.taskId;
          record.lastPostAt = Number(task.last_post_at || 0) || record.lastPostAt;
          if (task.worktree && task.worktree.id) record.worktreeId = task.worktree.id;
          if (task.attached === true) record.attached = true;
        }
        const timestamp = now();
        if (task && task.status === "idle" && !record.escalated) {
          const last = record.last_event_at || task.idle_at || task.last_post_at || task.started_at || 0;
          if (last && timestamp - last > cfg.stall_idle_ms) {
            try {
              await tasks.transition(rootOf(record), task.id, "stalled", { stall_kind: "crashed", stalled_at: timestamp });
            } catch {}
            record.taskStatus = "stalled";
            record.escalated = true;
            await postWarn(record, "CRASHED");
            continue;
          }
        }
        for (const kind of flagsFor(record, task, timestamp)) {
          if (record.fired[kind]) continue; // idempotent within an event epoch
          record.fired[kind] = true;
          const payload = await maybeNudge(record, kind);
          if (payload) nudges.push(payload);
        }
      }
    } finally {
      ticking = false;
    }
    return nudges;
  }

  function snapshot(sessionId) {
    const record = sessions.get(sessionId);
    if (!record) return null;
    return {
      sessionID: record.sessionID,
      taskId: record.taskId || null,
      status: record.taskStatus || "unknown",
      attached: Boolean(record.attached),
      worktreeId: record.worktreeId || null,
      root: rootOf(record),
      lastPostAt: record.lastPostAt || 0,
      unread: record.unread || 0,
      asks: record.asks || 0,
      nudges: record.nudges || 0,
      lastNudgeAt: record.last_nudge_at || 0,
      startedAt: record.started_at || 0,
      lastEventAt: record.last_event_at || 0,
      idleAt: record.idle_at || 0,
    };
  }

  async function onSessionIdle(sessionId) {
    const record = sessions.get(sessionId);
    if (!record || !store || typeof store.readBoard !== "function") return null;
    const root = rootOf(record);
    if (!root) return null;
    let board;
    try {
      board = await store.readBoard(root);
    } catch {
      return null;
    }
    const messages = (board && board.messages) || [];
    const mine = messages.filter(
      (message) =>
        (record.taskId && message.task_id === record.taskId) ||
        message.from === sessionId ||
        message.session_id === sessionId,
    );
    const last = mine[mine.length - 1];
    if (!last) return null;

    const body = String(last.body || "");
    const isAsk = /(^|[\s:])ASK\b/.test(body);
    record.lastPostAt = Number(last.ts || 0) || record.lastPostAt;
    record.busy = false;

    const task = await resolveTask(record);
    const status = (task && task.status) || record.taskStatus;
    // The RESULT may not be the final post (a STATUS can follow it), so while
    // the task is still active look for any RESULT posted since it started.
    let result = /(^|[\s:])RESULT\b/.test(body) ? last : null;
    if (!result && (status === "dispatching" || status === "running")) {
      result =
        [...mine]
          .reverse()
          .find(
            (message) =>
              Number(message.ts || 0) >= (record.started_at || 0) &&
              /(^|[\s:])RESULT\b/.test(String(message.body || "")),
          ) || null;
    }
    const isResult = Boolean(result);

    if (record.taskId && tasks && typeof tasks.transition === "function") {
      try {
        if (result) {
          await tasks.transition(root, record.taskId, "review", {
            last_post_at: Number(result.ts || 0) || record.lastPostAt,
            last_post_seq: result.seq,
          });
          record.taskStatus = "review";
        } else if (isAsk) {
          await tasks.transition(root, record.taskId, "waiting", { last_post_at: record.lastPostAt, last_post_seq: last.seq });
          record.taskStatus = "waiting";
        } else if (status === "dispatching" || status === "running") {
          await tasks.transition(root, record.taskId, "idle", { last_post_at: record.lastPostAt, last_post_seq: last.seq, idle_at: now() });
          record.taskStatus = "idle";
          record.idle_at = now();
        }
      } catch {
        /* derived state only */
      }
    }
    await persist(record);
    return { kind: isResult ? "RESULT" : isAsk ? "ASK" : "INFO", seq: last.seq || 0 };
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setTimer(handle) {
    timer = handle;
    return timer;
  }

  return { ingest, tick, onSessionIdle, snapshot, seed, stop, setTimer };
}

export { DEFAULTS as LIVENESS_DEFAULTS };
