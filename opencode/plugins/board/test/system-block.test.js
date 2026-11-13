// System block must carry stable identity only, so the prompt cache survives
// every model step. Volatile state belongs to board_digest/board_read.
import assert from "node:assert/strict";
import test from "node:test";
import { renderBoardBlock } from "../src/digest.js";

const identity = { root: "swarm-build", taskId: "t-1", worktreeId: "wt-t-1" };

test("volatile state does not change the rendered block", () => {
  const a = renderBoardBlock({ ...identity, status: "running", unread: 0, asks: 0, attempts: 1, attached: true, nextPost: "STATUS", lanes: [{ taskId: "t-2", status: "running" }] });
  const b = renderBoardBlock({ ...identity, status: "done", unread: 9, asks: 3, attempts: 5, attached: false, nextPost: "RESULT", lanes: [] });
  assert.equal(a, b);
  assert.equal(renderBoardBlock({ ...identity }), a);
});

test("identity still renders", () => {
  const out = renderBoardBlock(identity);
  assert.match(out, /task=t-1/);
  assert.match(out, /worktree=wt-t-1/);
  assert.match(out, /root=swarm-build/);
  assert.ok(out.startsWith("<board>"));
  assert.ok(out.endsWith("</board>"));
  assert.ok(Buffer.byteLength(out, "utf8") <= 1024);
});

test("absent identity renders a stable minimal block", () => {
  const out = renderBoardBlock({});
  assert.match(out, /task=unbound/);
  assert.ok(Buffer.byteLength(out, "utf8") <= 1024);
});
