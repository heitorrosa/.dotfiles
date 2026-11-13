// Board re-bind for promoted forks. Mirrors the board plugin's on-disk layout:
//
//   <board>/bind.json             { "<sessionID>": "<root>", aliases?: {...} }
//   <board>/bind-ts.json          { "<sessionID>": <ms> }
//   <board>/<root>.json           { root, next_seq, messages, participants, dedupe }
//   <board>/<root>.cursors/<who>.json   { lastSeq, lastMentionSeq }
//   <board>/<root>.acks/<who>.json      { ackSeq, ts }
//   <board>/<root>.beat/<who>.json      { ts, seq }
//   <board>/<root>.tasks.json     { root, next_task, tasks:{}, order:[] }
//
// Every mutation is fail-open at the call site; each helper returns a plain
// status object so the tool result can report what actually happened.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function defaultBoardDir() {
  const env = String(process.env.OPENCODE_BOARD_DIR || "").trim();
  if (env) return env;
  return path.join(os.homedir(), ".local", "share", "opencode", "board");
}

export function sanitize(id) {
  const s = String(id || "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  return s || "default";
}

export function readJson(file, fallback = {}) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

let tmpSeq = 0;

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function newId(seq) {
  let rand = "";
  try { rand = crypto.randomBytes(3).toString("hex"); } catch { rand = Math.floor(Math.random() * 0xffffff).toString(16); }
  return `msg-${seq}-${rand}`;
}

/**
 * @param {{dir?:string, now?:(()=>number)}} [opts]
 */
export function createBoardBridge({ dir = defaultBoardDir(), now = Date.now } = {}) {
  const paths = {
    bind: path.join(dir, "bind.json"),
    bindTs: path.join(dir, "bind-ts.json"),
    board: (root) => path.join(dir, `${sanitize(root)}.json`),
    lock: (root) => path.join(dir, `${sanitize(root)}.lock`),
    cursor: (root, who) => path.join(dir, `${sanitize(root)}.cursors`, `${sanitize(who)}.json`),
    ack: (root, who) => path.join(dir, `${sanitize(root)}.acks`, `${sanitize(who)}.json`),
    beat: (root, who) => path.join(dir, `${sanitize(root)}.beat`, `${sanitize(who)}.json`),
    tasks: (root) => path.join(dir, `${sanitize(root)}.tasks.json`),
  };

  function readBind() {
    const b = readJson(paths.bind, {});
    return b && typeof b === "object" && !Array.isArray(b) ? b : {};
  }

  function writeBind(bind) {
    writeJsonAtomic(paths.bind, bind);
  }

  function readBoard(root) {
    const b = readJson(paths.board(root), null);
    if (!b || !Array.isArray(b.messages) || typeof b.next_seq !== "number") {
      return { root: sanitize(root), next_seq: 1, messages: [], participants: [], dedupe: {} };
    }
    if (!Array.isArray(b.participants)) b.participants = [];
    if (!b.dedupe || typeof b.dedupe !== "object") b.dedupe = {};
    return b;
  }

  /** mkdir lock, best effort; proceeds unlocked rather than failing a rebind. */
  function withLock(root, fn) {
    let held = false;
    for (let i = 0; i < 40; i++) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.mkdirSync(paths.lock(root));
        held = true;
        break;
      } catch {
        try {
          const st = fs.statSync(paths.lock(root));
          // Staleness uses wall time; `now` is only the message clock.
          if (Date.now() - st.mtimeMs > 5000) { try { fs.rmdirSync(paths.lock(root)); } catch { /* ignore */ } }
        } catch { /* ignore */ }
        sleep(50);
      }
    }
    try {
      return fn();
    } finally {
      if (held) { try { fs.rmdirSync(paths.lock(root)); } catch { /* ignore */ } }
    }
  }

  /** Copy the session→root bind entry from source to fork. */
  function copyBoardBind(sourceID, newID, { alias = true } = {}) {
    const bind = readBind();
    const root = bind[sanitize(sourceID)];
    if (!root || typeof root !== "string") return { ok: false, reason: "source not bound" };
    bind[sanitize(newID)] = root;
    // Reserved alias keys are ignored by old readers; opt-in only so the
    // fork never appears twice as a live lane in digests.
    if (alias) {
      const aliases = (bind.aliases && typeof bind.aliases === "object" && !Array.isArray(bind.aliases))
        ? bind.aliases : {};
      aliases[sanitize(sourceID)] = sanitize(newID);
      bind.aliases = aliases;
    }
    writeBind(bind);
    try {
      const ts = readJson(paths.bindTs, {});
      ts[sanitize(newID)] = now();
      writeJsonAtomic(paths.bindTs, ts);
    } catch { /* fail-open */ }
    return { ok: true, root: sanitize(root) };
  }

  /** Copy cursor + ack + beat so the fork does not replay old traffic. */
  function seedCursor(root, sourceID, newID) {
    const out = { cursor: false, ack: false, beat: false };
    if (!root) return out;
    try {
      const cur = readJson(paths.cursor(root, sourceID), null);
      if (cur && typeof cur === "object") {
        writeJsonAtomic(paths.cursor(root, newID), {
          lastSeq: Number(cur.lastSeq) || 0,
          lastMentionSeq: Number(cur.lastMentionSeq) || 0,
        });
        out.cursor = true;
      }
    } catch { /* fail-open */ }
    try {
      const ack = readJson(paths.ack(root, sourceID), null);
      if (ack && typeof ack === "object") {
        writeJsonAtomic(paths.ack(root, newID), {
          ackSeq: Number(ack.ackSeq) || 0,
          ts: now(),
        });
        out.ack = true;
      }
    } catch { /* fail-open */ }
    try {
      const beat = readJson(paths.beat(root, sourceID), null);
      if (beat && typeof beat === "object") {
        writeJsonAtomic(paths.beat(root, newID), { ts: now(), seq: Number(beat.seq) || 0 });
        out.beat = true;
      }
    } catch { /* fail-open */ }
    return out;
  }

  /** Point task.session_id at the fork; keep the source id as an alias. */
  function updateTaskSession(root, sourceID, newID, { taskId } = {}) {
    const file = paths.tasks ? paths.tasks(root) : null;
    if (!file) return { ok: false, reason: "no tasks path" };
    const state = readJson(file, null);
    if (!state || typeof state !== "object" || !state.tasks || typeof state.tasks !== "object") {
      return { ok: false, reason: "no task file" };
    }
    const source = sanitize(sourceID);
    const target = taskId ? String(taskId) : null;
    const updated = [];
    for (const [id, task] of Object.entries(state.tasks)) {
      if (!task || typeof task !== "object") continue;
      const matches = target ? id === target : String(task.session_id || "") === source;
      if (!matches) continue;
      const prev = Array.isArray(task.previous_session_ids) ? task.previous_session_ids.slice() : [];
      if (task.session_id && task.session_id !== newID && !prev.includes(task.session_id)) prev.push(task.session_id);
      task.previous_session_ids = prev;
      task.session_id = newID;
      task.updated_at = now();
      updated.push(id);
    }
    if (!updated.length) return { ok: false, reason: "no matching task" };
    writeJsonAtomic(file, state);
    return { ok: true, taskIds: updated };
  }

  /** Append one INFO message to the root board (locked, atomic). */
  function postInfo(root, from, body, { taskId } = {}) {
    return withLock(root, () => {
      const board = readBoard(root);
      const seq = Number(board.next_seq) || 1;
      const message = {
        id: newId(seq),
        seq,
        from: sanitize(from),
        to: "ALL",
        type: "INFO",
        body: String(body || "").slice(0, 4096),
        reply_to: null,
        ts: now(),
      };
      if (taskId) message.task_id = String(taskId);
      board.next_seq = seq + 1;
      board.messages.push(message);
      if (!board.participants.includes(message.from)) board.participants.push(message.from);
      writeJsonAtomic(paths.board(root), board);
      return { ok: true, message };
    });
  }

  /**
   * Full re-bind: bind entry, cursor/ack/beat, task session id, INFO post.
   * @returns {{ok:boolean, root?:string, cursor?:object, task?:object,
   *   message?:object|null, reason?:string}}
   */
  function rebind({ root, sourceID, newID, taskId, announce = true } = {}) {
    const source = String(sourceID || "");
    const target = String(newID || "");
    if (!source || !target) return { ok: false, reason: "missing session id" };
    let bindRoot = root ? sanitize(root) : null;
    if (!bindRoot) {
      const bind = readBind();
      bindRoot = bind[sanitize(source)] ? sanitize(bind[sanitize(source)]) : null;
    }
    const bound = copyBoardBind(source, target);
    if (!bound.ok) return { ok: false, reason: bound.reason };
    if (!bindRoot) bindRoot = bound.root;
    const cursor = seedCursor(bindRoot, source, target);
    const task = updateTaskSession(bindRoot, source, target, { taskId });
    let message = null;
    if (announce) {
      const label = task.ok && task.taskIds.length ? `[${task.taskIds[0]}]` : "[session]";
      try {
        const posted = postInfo(bindRoot, target, `${label} session promoted to ${target}`, {
          taskId: task.ok ? task.taskIds[0] : undefined,
        });
        message = posted.message || null;
      } catch { /* fail-open */ }
    }
    return { ok: true, root: bindRoot, cursor, task, message };
  }

  return {
    dir,
    paths,
    readBind,
    writeBind,
    readBoard,
    withLock,
    copyBoardBind,
    seedCursor,
    updateTaskSession,
    postInfo,
    rebind,
  };
}
