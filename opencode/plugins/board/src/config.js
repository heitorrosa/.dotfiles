// Board config resolution: shipped defaults in ../config.json, then
// ctx.options, then the board directory env/home fallback.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAG = "[board]";

export const DEFAULT_CONFIG = {
  max_workers: 5,
  max_attempts: 2,
  stall_idle_ms: 300000,
  stall_board_ms: 600000,
  unattached_ms: 120000,
  admission_mode: "auto",
  nudge_mode: "quiet",
  nudge_after_ms: 180000,
  worktree_base: null,
  auto_remove_done: false,
  kill_stalled: false,
  worker_agent: "worker",
  await_verdict_ms: 300000,
  cadence_every_ms: 120000,
  cadence_every_calls: 2,
  rate_limit_per_min: 6,
  rate_limit_burst: 3,
  wake_cooldown_ms: 60000,
};

const NUMERIC = [
  "max_workers",
  "max_attempts",
  "stall_idle_ms",
  "stall_board_ms",
  "unattached_ms",
  "nudge_after_ms",
  "await_verdict_ms",
  "cadence_every_ms",
  "cadence_every_calls",
  "rate_limit_per_min",
  "rate_limit_burst",
  "wake_cooldown_ms",
];

function log(...a) {
  try {
    console.log(TAG, ...a);
  } catch {
    /* fail-open */
  }
}

function readConfigFile() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log("ignoring config.json: not a JSON object");
      return {};
    }
    return parsed;
  } catch (e) {
    if (!e || e.code !== "ENOENT") log("ignoring config.json:", String((e && e.message) || e));
    return {};
  }
}

export function loadConfig(ctx) {
  const options = ctx && ctx.options && typeof ctx.options === "object" ? ctx.options : {};
  const merged = { ...DEFAULT_CONFIG, ...readConfigFile(), ...options };

  for (const key of NUMERIC) {
    const n = Number(merged[key]);
    if (!Number.isFinite(n) || n < 0) {
      log("invalid numeric config", key + "=" + String(merged[key]) + ", using", DEFAULT_CONFIG[key]);
      merged[key] = DEFAULT_CONFIG[key];
    } else {
      merged[key] = n;
    }
  }

  const boardDir =
    options.board_dir ||
    process.env.OPENCODE_BOARD_DIR ||
    path.join(os.homedir(), ".local", "share", "opencode", "board");
  return { ...merged, board_dir: boardDir };
}
