// background-tools - forces shell commands into OpenCode v2 background mode.
//
// Mechanism: the tool "execute.before" hook receives the tool call payload with a
// MUTABLE `input` field, so the hook can set input.background = true before the
// shell tool runs. Background commands return immediately and notify the session on
// completion, which keeps the agent responsive and removes the tool timeout.
//
// Gated by C:\Users\Administrator\.config\opencode\background-tools.json:
//   { "enabled": true, "agents": ["asuka"], "marker": "FORCEBG_TEST" }
// "agents" = agent ids where every shell call is backgrounded.
// "marker" = any command containing this string is backgrounded (used to test
// safely without changing the behaviour of every call in a live session).
// Every injection is logged to %TEMP%\opencode\background-tools.log.
import { appendFileSync, readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

const CFG = "C:/Users/Administrator/.config/opencode/background-tools.json"
const LOG = "C:/Users/Administrator/AppData/Local/Temp/opencode/background-tools.log"

function config() {
  try {
    return JSON.parse(readFileSync(CFG, "utf8"))
  } catch {
    return { enabled: false, agents: [] }
  }
}

export default Plugin.define({
  id: "background-tools",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (payload) => {
      try {
        if (payload.tool !== "shell") return
        const cfg = config()
        if (!cfg.enabled) return
        const input = payload.input
        if (!input || typeof input !== "object") return
        const cmd = String(input.command ?? "")
        const byAgent = Array.isArray(cfg.agents) && cfg.agents.includes(payload.agent)
        const byMarker = Boolean(cfg.marker) && cmd.includes(cfg.marker)
        if (!byAgent && !byMarker) return
        const before = { ...input }
        if (typeof input.background !== "boolean") input.background = true
        appendFileSync(
          LOG,
          JSON.stringify({
            at: new Date().toISOString(),
            sessionID: payload.sessionID,
            agent: payload.agent,
            by: byMarker ? "marker" : "agent",
            before,
            after: { ...input },
          }) + "\n",
        )
      } catch (e) {
        appendFileSync(LOG, "ERR " + String(e) + "\n")
      }
    })
  },
})
