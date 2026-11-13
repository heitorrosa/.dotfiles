import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAdmission } from "../src/admission.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "board-admission-"));
}

const event = (prompt) => ({
  tool: "subagent",
  sessionID: "ses_parent",
  root: "root1",
  input: { prompt },
});

test("manual admission refuses without a claimed worktree", async () => {
  const dir = tmp();
  const calls = { claim: 0, release: 0 };
  const tasks = {
    async admit() {
      return { ok: true, task: { id: "t1", worktree: null, workspace: "git" } };
    },
    async claim() {
      calls.claim += 1;
    },
    async release() {
      calls.release += 1;
    },
  };
  const admission = createAdmission({
    config: { admission_mode: "manual", canonical_dir: dir, root: "root1" },
    tasks,
  });

  const verdict = await admission.beforeTool(event("[t1;wt-t1]\ndo the thing"));
  assert.ok(verdict && verdict.block);
  assert.match(verdict.content, /manual admission requires board_task_claim/);
  assert.equal(calls.claim, 0);
  assert.equal(calls.release, 1);
});

test("manual admission uses the existing worktree and skips claim", async () => {
  const dir = tmp();
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "# brief");
  const calls = { claim: 0 };
  const task = {
    id: "t1",
    workspace: "read",
    brief,
    worktree: { id: "wt-t1", path: dir, mode: "read" },
  };
  const tasks = {
    async admit() {
      return { ok: true, task };
    },
    async claim() {
      calls.claim += 1;
    },
    async release() {},
  };
  const admission = createAdmission({
    config: { admission_mode: "manual", canonical_dir: dir, root: "root1" },
    tasks,
  });

  const input = { prompt: "[t1;wt-t1]\ndo the thing" };
  const verdict = await admission.beforeTool({ ...event(""), input });
  assert.equal(verdict, undefined);
  assert.equal(calls.claim, 0);
  assert.match(input.prompt, /^\[t1;wt-t1\]/);
  assert.match(input.prompt, new RegExp("WORKTREE DIR: " + dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
});

test("afterTool treats event.status completed as review even without a session id", async () => {
  const transitions = [];
  const tasks = {
    async bindSession() {
      throw new Error("should not bind without a session id");
    },
    async transition(root, id, status) {
      transitions.push([root, id, status]);
    },
    async release() {},
  };
  const admission = createAdmission({ config: { root: "root1" }, tasks });

  const result = await admission.afterTool({
    tool: "subagent",
    root: "root1",
    status: "completed",
    result: "finished with no parseable identifier",
    input: { prompt: "[t1;wt-t1] x" },
  });
  assert.equal(result, undefined);
  assert.deepEqual(transitions, [["root1", "t1", "review"]]);
});
