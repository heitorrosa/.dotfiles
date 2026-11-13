import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

test("defaults come from config.json with 5 workers", () => {
  assert.equal(DEFAULT_CONFIG.max_workers, 5);
  assert.equal(loadConfig({}).max_workers, 5);
});

test("state board dir defaults under ~/.local/share/opencode/board", () => {
  const prev = process.env.OPENCODE_BOARD_DIR;
  delete process.env.OPENCODE_BOARD_DIR;
  try {
    const config = loadConfig({});
    assert.equal(
      config.board_dir,
      path.join(os.homedir(), ".local", "share", "opencode", "board"),
    );
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_BOARD_DIR;
    else process.env.OPENCODE_BOARD_DIR = prev;
  }
});

test("ctx.options override and invalid numerics fall back", () => {
  const config = loadConfig({ options: { max_workers: "2", stall_idle_ms: "nope" } });
  assert.equal(config.max_workers, 2);
  assert.equal(config.stall_idle_ms, DEFAULT_CONFIG.stall_idle_ms);
});
