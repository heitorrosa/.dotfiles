import test from "node:test";
import assert from "node:assert/strict";

import { createScheduler } from "../src/scheduler.js";
import { createLiveness } from "../src/liveness.js";
import { renderNudge } from "../src/digest.js";

test("tick promotes every root, then ticks liveness once", async () => {
  const promoted = [];
  const events = [];
  const scheduler = createScheduler({
    tasks: { promoteReady: async (root) => promoted.push(root) },
    liveness: { tick: async () => events.push("liveness") },
    roots: () => ["r1", "r2"],
  });

  assert.equal(await scheduler.tick(), true);
  assert.deepEqual(promoted, ["r1", "r2"]);
  assert.deepEqual(events, ["liveness"]);
});

test("tick tolerates missing promoteReady", async () => {
  let ticks = 0;
  const scheduler = createScheduler({
    tasks: {},
    liveness: { tick: async () => ticks++ },
    roots: () => ["r1"],
  });
  assert.equal(await scheduler.tick(), true);
  assert.equal(ticks, 1);
});

test("tick does not overlap", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const promoted = [];
  let livenessTicks = 0;
  const scheduler = createScheduler({
    tasks: {
      promoteReady: async (root) => {
        promoted.push(root);
        await gate;
      },
    },
    liveness: {
      tick: async () => {
        livenessTicks += 1;
      },
    },
    roots: () => ["r1"],
  });

  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(await second, false);
  assert.deepEqual(promoted, ["r1"]);
  assert.equal(livenessTicks, 0);

  release();
  assert.equal(await first, true);
  assert.equal(livenessTicks, 1);
});

test("start/stop are idempotent and the interval is unref'd", () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let created = 0;
  let cleared = 0;
  let unrefs = 0;
  const handle = { unref: () => unrefs++ };
  globalThis.setInterval = () => {
    created += 1;
    return handle;
  };
  globalThis.clearInterval = () => cleared++;

  try {
    const scheduler = createScheduler({ tasks: {}, liveness: {}, roots: () => [] });
    scheduler.start();
    scheduler.start();
    assert.equal(created, 1);
    assert.equal(unrefs, 1);

    scheduler.stop();
    scheduler.stop();
    assert.equal(cleared, 1);

    scheduler.start();
    assert.equal(created, 2);
    scheduler.stop();
    assert.equal(cleared, 2);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test("AWAIT_VERDICT fires once per epoch for a review task", async () => {
  let clock = 1_000_000;
  const woken = [];
  const task = { id: "t1", status: "review", last_post_at: clock - 10_000, session_id: "ses1" };
  const liveness = createLiveness({
    tasks: {
      get: async () => task,
      list: async () => [task],
      transition: async () => task,
    },
    config: {
      root: "root1",
      await_verdict_ms: 5_000,
      nudge_after_ms: 0,
      nudge_interval_ms: 0,
      max_nudges: 5,
    },
    wake: async (_target, text) => woken.push(text),
    now: () => clock,
  });

  liveness.seed("ses1", { taskId: "t1", lastPostAt: task.last_post_at, status: "review" });

  await liveness.tick();
  assert.equal(woken.length, 1);
  assert.match(woken[0], /AWAIT_VERDICT/);

  // Same epoch: the flag must not fire again.
  await liveness.tick();
  assert.equal(woken.length, 1);

  // A new event opens a fresh epoch, so it may fire again.
  liveness.ingest({ type: "session.step.started", properties: { sessionID: "ses1", taskID: "t1" } });
  clock += 1_000;
  await liveness.tick();
  assert.equal(woken.length, 2);
});

test("digest renders the AWAIT_VERDICT line", () => {
  assert.match(renderNudge("AWAIT_VERDICT", { taskId: "t1" }), /board_verdict/);
});
