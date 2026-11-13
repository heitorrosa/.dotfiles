// Scheduler: one 1s timer driving queued-task promotion and a liveness pass.
// Pure orchestration; all I/O stays in tasks/liveness, log is injected.

export function createScheduler({ tasks, liveness, config = {}, roots, log } = {}) {
  let timer = null;
  let running = false;

  function warn(what, e) {
    if (typeof log === "function") log(what, String((e && e.message) || e));
  }

  async function tick() {
    // A slow promote/liveness pass skips the next beat instead of stacking.
    if (running) return false;
    running = true;
    try {
      const list = typeof roots === "function" ? roots() || [] : [];
      if (tasks && typeof tasks.promoteReady === "function") {
        for (const root of list) {
          try {
            await tasks.promoteReady(root);
          } catch (e) {
            warn("promoteReady failed", e);
          }
        }
      }
      if (liveness && typeof liveness.tick === "function") {
        try {
          await liveness.tick();
        } catch (e) {
          warn("liveness.tick failed", e);
        }
      }
      return true;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return timer;
    timer = setInterval(() => {
      void tick().catch((e) => warn("scheduler tick failed", e));
    }, 1000);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
