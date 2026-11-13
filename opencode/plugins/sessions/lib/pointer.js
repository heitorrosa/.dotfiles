// Fork pointer registry for the sessions plugin.
//
// A fork is a new session id whose history is a copy of the source. The
// registry is a flat, bidirectional string map:
//
//   { "<source>": "<fork>", "<fork>": "<source>" }
//
// `resolve()` walks forward pointers until it hits a visited id, so the
// reverse edge (which is what makes `original id acts as a pointer` work)
// terminates the walk instead of looping.
//
// Storage order: plugin storage key "sessions/forks" when the host exposes a
// usable ctx.storage, else a JSON sidecar under the OpenCode data dir.
// Never writes opencode.db.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STORAGE_KEY = "sessions/forks";
export const MAX_POINTER_DEPTH = 16;
export const FORK_MARK = "fork:";

/**
 * Direction marker. The two-way map is symmetric, so the fork direction is
 * recorded as a reserved entry `fork:<newID> -> "<oldID>"`. Session ids never
 * contain ":", so `resolve()` can never walk into one, and a reverse edge is
 * only followed when the marker names the current session as its source.
 */
export function isForkTarget(map, id) {
  const src = map && map[`${FORK_MARK}${id}`];
  return typeof src === "string" && Boolean(src);
}

/** <data-dir>/opencode/sessions-forks.json (default fallback sidecar). */
export function forksFallbackPath() {
  const xdg = String(process.env.XDG_DATA_HOME || "").trim();
  const base = xdg || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode", "sessions-forks.json");
}

let tmpSeq = 0;

export function readJsonFile(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

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

/** Accept an object, a JSON string, or `{value}`-shaped storage envelopes. */
export function asMap(value) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.value !== undefined && !Object.keys(v).some((k) => k.startsWith("ses"))) {
      return asMap(v.value);
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof k === "string" && k && typeof val === "string" && val) out[k] = val;
    }
    return out;
  }
  return {};
}

/**
 * @param {object} opts
 * @param {{get?:Function,set?:Function,delete?:Function}} [opts.storage] host storage
 * @param {string} [opts.file] fallback sidecar path
 */
export function createPointerStore({ storage, file = forksFallbackPath() } = {}) {
  const hasStorage = Boolean(
    storage && typeof storage.get === "function" && typeof storage.set === "function",
  );
  let mode = hasStorage ? "storage" : "file";

  async function load() {
    if (hasStorage) {
      try {
        const got = await storage.get(STORAGE_KEY);
        if (got !== undefined && got !== null) return asMap(got);
      } catch { /* fall through to sidecar */ }
    }
    return asMap(readJsonFile(file, {}));
  }

  async function save(map) {
    const value = asMap(map);
    if (hasStorage) {
      try {
        await storage.set(STORAGE_KEY, value);
        mode = "storage";
        return mode;
      } catch { /* fall back to sidecar */ }
    }
    writeJsonAtomic(file, value);
    mode = "file";
    return mode;
  }

  /** Register a fork in both directions. Returns the stored map. */
  async function register(sourceID, newID) {
    const source = String(sourceID || "");
    const next = String(newID || "");
    if (!source || !next || source === next) return load();
    const map = await load();
    map[source] = next;
    map[next] = source;
    map[`${FORK_MARK}${next}`] = source;
    await save(map);
    return map;
  }

  /**
   * Follow pointers until stable. Returns the canonical session id.
   * @returns {Promise<{sessionID:string, source:string, chain:string[],
   *   changed:boolean, truncated:boolean}>}
   */
  async function resolve(id, { max = MAX_POINTER_DEPTH } = {}) {
    const source = String(id || "");
    if (!source) return { sessionID: "", source, chain: [], changed: false, truncated: false };
    const map = await load();
    const seen = new Set([source]);
    const chain = [source];
    let cur = source;
    for (let i = 0; i < max; i++) {
      const next = map[cur];
      if (typeof next !== "string" || !next || seen.has(next)) break;
      // Follow only a real fork edge: the marker on `next` must name `cur`.
      if (map[`${FORK_MARK}${next}`] !== cur) break;
      seen.add(next);
      chain.push(next);
      cur = next;
    }
    return {
      sessionID: cur,
      source,
      chain,
      changed: cur !== source,
      truncated: chain.length > max,
    };
  }

  async function unlink(id) {
    const key = String(id || "");
    if (!key) return load();
    const map = await load();
    delete map[key];
    delete map[`${FORK_MARK}${key}`];
    await save(map);
    return map;
  }

  return {
    get mode() { return mode; },
    file,
    load,
    save,
    register,
    resolve,
    unlink,
    isForkTarget: (map, id) => isForkTarget(map, id),
  };
}
