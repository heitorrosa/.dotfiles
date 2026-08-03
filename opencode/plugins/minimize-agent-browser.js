// minimize-agent-browser.js — opencode plugin
// Keeps the agent Thorium (chrome-devtools-mcp "User Data Agent" profile)
// minimized so it doesn't disturb the user's main browser.
//
// v3: default export, NO async work at init (v1/v2 crashed opencode startup),
// returns a plugin object; watcher is spawned from the session.created event
// hook via child_process (fire-and-forget, detached, never throws).

const WATCHER_SCRIPT = "C:\\Users\\Administrator\\.config\\opencode\\scripts\\ensure-minimize-agent.ps1";

async function spawnWatcher() {
  try {
    const { spawn } = await import("node:child_process");
    const proc = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", WATCHER_SCRIPT],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    proc.unref();
  } catch (_) {
    // never let a watcher failure break opencode
  }
}

export default async function () {
  return {
    event: async ({ event }) => {
      if (event?.type === "session.created") {
        await spawnWatcher();
      }
    },
  };
}
