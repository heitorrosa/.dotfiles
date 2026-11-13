// Board persistence: board messages, task state, locks and atomic JSON I/O.
// ESM, Node built-ins only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitize } from "./ids.js";

const LOCK_WAIT_MS = 20;
const LOCK_RETRIES = 250;
const LOCK_STALE_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blankBoard(root) {
  return { root, next_seq: 1, messages: [], participants: [], dedupe: {} };
}

function blankTasks(root) {
  return { root, next_seq: 1, tasks: {}, order: [] };
}

function normalizeBoard(root, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return blankBoard(root);
  }
  const board = value;
  if (!Array.isArray(board.messages)) board.messages = [];
  if (typeof board.next_seq !== "number" || !Number.isFinite(board.next_seq)) {
    board.next_seq = 1;
  }
  if (!Array.isArray(board.participants)) board.participants = [];
  if (!board.dedupe || typeof board.dedupe !== "object") board.dedupe = {};
  board.root = root;
  return board;
}

function normalizeTasks(root, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return blankTasks(root);
  }
  const state = value;
  if (!state.tasks || typeof state.tasks !== "object" || Array.isArray(state.tasks)) {
    state.tasks = {};
  }
  if (!Array.isArray(state.order)) state.order = Object.keys(state.tasks);
  // Drop stale order entries, append tasks missing from order.
  state.order = state.order.filter((id) => state.tasks[id]);
  for (const id of Object.keys(state.tasks)) {
    if (!state.order.includes(id)) state.order.push(id);
  }
  if (typeof state.next_seq !== "number" || !Number.isFinite(state.next_seq)) {
    state.next_seq = 1;
  }
  if (typeof state.next_task !== "number" || !Number.isFinite(state.next_task)) {
    state.next_task = state.next_seq;
  }
  state.root = root;
  return state;
}

export class BoardStore {
  constructor({ dir } = {}) {
    this.dir =
      dir && typeof dir === "string"
        ? dir
        : path.join(os.homedir(), ".local", "share", "opencode", "board");
  }

  boardPath(root) {
    return path.join(this.dir, `${root}.json`);
  }

  tasksPath(root) {
    return path.join(this.dir, `${root}.tasks.json`);
  }

  metricsDir(root) {
    return path.join(this.dir, `${root}.metrics`);
  }

  forksPath() {
    return path.join(this.dir, "..", "sessions", "forks.json");
  }

  lockPath(root) {
    return path.join(this.dir, `${root}.lock`);
  }

  readText(p, fallback = null) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return fallback;
    }
  }

  readJson(p, fallback = null) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const value = JSON.parse(raw);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  writeJsonAtomic(p, value) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, p);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }
  }

  appendLine(p, value) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = typeof value === "string" ? value : JSON.stringify(value);
    fs.appendFileSync(p, `${line}\n`);
  }

  readBoard(root) {
    return normalizeBoard(root, this.readJson(this.boardPath(root), null));
  }

  writeBoard(root, board) {
    this.writeJsonAtomic(this.boardPath(root), board);
    return board;
  }

  readTasks(root) {
    return normalizeTasks(root, this.readJson(this.tasksPath(root), null));
  }

  writeTasks(root, state) {
    this.writeJsonAtomic(this.tasksPath(root), state);
    return state;
  }

  // Bind file lives next to the board files: { <sanitized session id>: <root> }.
  bindPath() {
    return path.join(path.dirname(this.boardPath("__bind__")), "bind.json");
  }

  readBind() {
    const value = this.readJson(this.bindPath(), {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  writeBind(bind) {
    this.writeJsonAtomic(this.bindPath(), bind);
  }

  // A caller may act on a root if it is the root session itself, or if it
  // holds a bind for that root (attached participants get one on attach).
  isCallerAuthorized(root, callerSessionId) {
    const caller = String(callerSessionId == null ? "" : callerSessionId);
    if (!caller) return true;
    if (caller === String(root)) return true;
    const entry = this.readBind()[sanitize(caller)];
    return Boolean(entry === root || (entry && typeof entry === "object" && entry.root === root));
  }

  /**
   * mkdir-based mutex per root. Stale locks (older than LOCK_STALE_MS) are
   * taken over. Returns the awaited result of fn.
   */
  async withLock(root, fn) {
    const dir = this.lockPath(root);
    fs.mkdirSync(this.dir, { recursive: true });

    let acquired = false;
    for (let attempt = 0; attempt < LOCK_RETRIES && !acquired; attempt++) {
      try {
        fs.mkdirSync(dir);
        acquired = true;
        break;
      } catch (err) {
        if (err && err.code === "ENOENT") {
          fs.mkdirSync(this.dir, { recursive: true });
        } else if (err && err.code !== "EEXIST") {
          throw err;
        }
      }

      try {
        const stat = fs.statSync(dir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* another process may have released it */
          }
          continue;
        }
      } catch {
        // Lock vanished; retry immediately.
        continue;
      }

      await sleep(LOCK_WAIT_MS);
    }

    if (!acquired) {
      const err = new Error(`lock busy for root '${root}'`);
      err.code = "ELOCKED";
      throw err;
    }

    try {
      return await fn();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* lock already gone */
      }
    }
  }
}
