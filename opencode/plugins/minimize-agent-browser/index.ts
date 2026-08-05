// minimize-agent-browser — opencode plugin
// Keeps the agent Thorium (chrome-devtools-mcp "User Data Agent" profile)
// minimized so it doesn't disturb the user's main browser.
//
// v6: matches the working local-plugin shape exactly (single default export
// `satisfies Plugin`, .ts, like opencode-hermes-vision). No async work at
// init. Watcher spawns from event hooks (fire-and-forget, detached, never
// throws). Re-arms on session.created AND session.idle — the ensure script
// is idempotent, so idle re-arms self-heal if the watcher died or the
// created event was missed (e.g. resumed sessions).

import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const WRAPPER_SCRIPT =
  "C:\\Users\\Administrator\\.config\\opencode\\scripts\\ensure-via-cim.ps1"
const MARKER = path.join(tmpdir(), "minimize-agent-plugin.log")

function mark(msg: string) {
  try {
    appendFileSync(MARKER, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // diagnostics must never break the plugin
  }
}

mark("module evaluated") // proves the module itself loads

async function spawnWatcher() {
  try {
    const proc = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", WRAPPER_SCRIPT],
      // The wrapper launches ensure via WMI Win32_Process.Create, which escapes
      // bun's job object — verified the daemon survives parent exit. (bun puts
      // direct spawn children in a job that kills them; detached:true too.)
      { stdio: "ignore", windowsHide: true }
    )
    proc.unref()
    mark(`spawnWatcher: spawned pid=${proc.pid ?? "?"}`)
  } catch (e) {
    mark(`spawnWatcher ERROR: ${(e as Error)?.message ?? e}`)
  }
}

// session.created / session.idle are NOT reliable in this event stream
// (resumed sessions + no idle events). Spawn ONCE on the first event of the
// session — the daemon is WMI-launched (escapes bun's job object) so it keeps
// running across sessions; if it ever dies, the next opencode start's first
// event respawns it. No 60s re-spawn: that popped a console window every
// minute (Win32_Process.Create gives WMI-launched processes a fresh console).
let spawned = false
let loggedFirstEvent = false

export default (async () => {
  mark("plugin factory called")
  return {
    event: async ({ event }: { event: { type?: string } }) => {
      if (!loggedFirstEvent) {
        loggedFirstEvent = true
        mark(`first event: ${event?.type ?? "?"}`)
      }
      if (!spawned) {
        spawned = true
        await spawnWatcher()
      }
    },
  }
}) satisfies Plugin
