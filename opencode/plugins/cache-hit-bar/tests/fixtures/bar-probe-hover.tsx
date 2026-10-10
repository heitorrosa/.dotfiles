/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { CacheHitBarHost } from "../../src/bar.tsx"

/**
 * Hover-fg probe: TWO real host rows in one tree — rest (muted gray) and
 * hovered (white) via literal `hovered` values. No mid-render signal flips:
 * the test renderer does not propagate external signal writes into a mounted
 * tree (proven by waitFor timeout), so both states render side by side and
 * one span capture proves both fgs. Driven by bar-hover-runner.ts.
 */
const PRIME = "ses_probe_hover"

const msg = {
  id: "m1",
  role: "assistant",
  created: 1,
  model: "muse-spark-1.3-contributor",
  providerID: "opencode-go",
  tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 900, write: 0 } },
}

const session = {
  id: PRIME,
  model: { id: "muse-spark-1.3-contributor", providerID: "opencode-go" },
  cost: 0.6,
  tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 3000, write: 0 } },
}

const fakeApi = {
  state: {
    path: { directory: "C:/tmp" },
    provider: [],
    session: {
      messages: (sid: string) => (sid === PRIME ? [msg] : []),
      get: (sid: string) => (sid === PRIME ? session : undefined),
    },
  },
  client: { session: { list: async () => [] } },
  event: { on: () => () => {} },
}

export function BarProbe() {
  return (
    <box flexDirection="column">
      <CacheHitBarHost sessionId={PRIME} api={fakeApi as never} muted="#9ca3af" base="#ffffff" hovered={() => false} />
      <CacheHitBarHost sessionId={PRIME} api={fakeApi as never} muted="#9ca3af" base="#ffffff" hovered={() => true} />
      <CacheHitBarHost sessionId={PRIME} api={fakeApi as never} muted={RGBA.fromHex("#9ca3af")} base={RGBA.fromHex("#ffffff")} hovered={() => false} />
    </box>
  )
}
