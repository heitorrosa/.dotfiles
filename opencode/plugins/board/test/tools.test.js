import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerTools, worktreePermissions } from "../src/tools.js";

test("worktreePermissions has no blanket edit/write/patch deny", () => {
  for (const mode of ["git", "direct", "shadow"]) {
    const rules = worktreePermissions("/repo", mode, []);
    for (const action of ["edit", "write", "patch"]) {
      assert.ok(
        !rules.some((r) => r.action === action && r.resource === "*" && r.effect === "deny"),
        `${mode}: blanket ${action} deny must be gone`,
      );
    }
  }
  const read = worktreePermissions("/repo", "read", []);
  assert.ok(read.some((r) => r.action === "edit" && r.resource === "*" && r.effect === "deny"));
  const direct = worktreePermissions("/repo", "direct", ["src/a.js"]);
  assert.ok(direct.some((r) => r.action === "edit" && r.resource === "/repo/src/a.js" && r.effect === "allow"));
});

test("board_task_create persists brief_text and rejects absolute/traversal briefs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-brief-"));
  const tasksById = new Map();
  let seq = 0;
  const tasks = {
    async create(root, o) {
      const id = `t${++seq}`;
      const task = { id, header: `[${id};wt-${id}]`, status: "ready", brief: o.brief || "", worktree: null };
      tasksById.set(id, task);
      return task;
    },
    async setBrief(root, id, brief) {
      tasksById.get(id).brief = brief;
      return tasksById.get(id);
    },
    get(root, id) {
      return tasksById.get(id) || null;
    },
    list() {
      return [...tasksById.values()];
    },
  };
  const store = {
    dir,
    async withLock(_root, fn) {
      return fn();
    },
    readBoard: () => ({ messages: [], next_seq: 1, participants: [], dedupe: {} }),
    writeBoard() {},
    boardPath: (name) => path.join(dir, "board", `${name}.json`),
    readJson: () => ({}),
    writeJsonAtomic() {},
    isCallerAuthorized: () => true,
  };
  const tools = new Map();
  registerTools({ add: (def) => tools.set(def.name, def) }, {
    ctx: { session: { get: async () => ({}) } },
    store,
    tasks,
    config: { canonical_dir: dir },
  });
  const create = tools.get("board_task_create");

  const ok = await create.execute(
    { title: "T", brief: "briefs/t1.md", brief_text: "# hello" },
    { sessionID: "testsession" },
  );
  const abs1 = path.join(dir, "briefs", "testsession", "t1.md");
  assert.equal(JSON.parse(ok.content).brief, abs1);
  assert.equal(fs.readFileSync(abs1, "utf8"), "# hello");
  assert.equal(tasksById.get("t1").brief, abs1);

  const abs = await create.execute(
    { title: "T2", brief: path.join(dir, "nope.md"), brief_text: "# hi" },
    { sessionID: "testsession" },
  );
  const abs2 = JSON.parse(abs.content).brief;
  assert.equal(abs2, path.join(dir, "briefs", "testsession", "t2.md"));
  assert.equal(fs.readFileSync(abs2, "utf8"), "# hi");
  assert.equal(fs.existsSync(path.join(dir, "nope.md")), false);
});

function fakePostStore(dir, board) {
  return {
    dir,
    async withLock(_root, fn) {
      return fn();
    },
    readBoard: () => board,
    writeBoard() {},
    boardPath: (name) => path.join(dir, "board", `${name}.json`),
    readJson: () => ({}),
    writeJsonAtomic() {},
    isCallerAuthorized: () => true,
  };
}

function postTools(store, config, wake) {
  const tools = new Map();
  registerTools(
    { add: (def) => tools.set(def.name, def) },
    {
      ctx: { session: { get: async () => ({}) } },
      store,
      tasks: { list: () => [], get: () => null, addPost: async () => {} },
      config,
      wake,
    },
  );
  return tools;
}

test("board_post rate-limits a sender and returns normal error JSON", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-rate-"));
  const board = { messages: [], next_seq: 1, participants: [], dedupe: {} };
  const tools = postTools(fakePostStore(dir, board), { rate_limit_per_min: 6, rate_limit_burst: 3 });
  const post = tools.get("board_post");

  for (let i = 0; i < 3; i += 1) {
    const res = await post.execute(
      { to: "ALL", type: "INFO", body: `note ${i}` },
      { sessionID: "rate-session", messageID: `m${i}` },
    );
    assert.equal(JSON.parse(res.content).error, undefined, `post ${i} should succeed`);
  }

  const limited = await post.execute(
    { to: "ALL", type: "INFO", body: "note 3" },
    { sessionID: "rate-session", messageID: "m3" },
  );
  const parsed = JSON.parse(limited.content);
  assert.equal(parsed.error, "Conflict");
  assert.match(parsed.message, /Rate limit exceeded/);
  assert.equal(board.messages.length, 3);
});

test("board_post wakes a direct ASK target but not ALL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-wake-"));
  const board = { messages: [], next_seq: 1, participants: ["ses_target"], dedupe: {} };
  const woken = [];
  const tasks = {
    list: () => [],
    get: () => null,
    addPost: async () => {},
  };
  const tools = new Map();
  registerTools(
    { add: (def) => tools.set(def.name, def) },
    {
      ctx: { session: { get: async () => ({}) } },
      store: fakePostStore(dir, board),
      tasks,
      config: { rate_limit_per_min: 0 },
      wake: async (to, text) => woken.push([to, text]),
    },
  );
  const post = tools.get("board_post");

  await post.execute({ to: "ALL", type: "ASK", body: "anyone?" }, { sessionID: "s1", messageID: "a1" });
  assert.deepEqual(woken, []);

  await post.execute(
    { to: "ses_target", type: "ASK", body: "you?" },
    { sessionID: "s1", messageID: "a2" },
  );
  assert.deepEqual(woken, [["ses_target", "[board] direct ASK for your task"]]);
});
