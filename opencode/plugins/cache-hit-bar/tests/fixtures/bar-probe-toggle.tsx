/** @jsxImportSource @opentui/solid */
import { CacheHitBarHost } from "../../src/bar.tsx"

/**
 * Click-toggle probe: real host row wired to a recording fake dialog.
 * Driven by bar-toggle-runner.ts, which clicks the row twice via mockMouse.
 */
export const dialogCalls = { show: 0, clear: 0 }

const dialog = {
  show: (_render: () => unknown) => {
    dialogCalls.show++
  },
  set: (_opts: unknown) => {},
  clear: () => {
    dialogCalls.clear++
  },
}

const PRIME = "ses_probe_toggle"

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
  return <CacheHitBarHost sessionId={PRIME} api={fakeApi as never} dialog={dialog as never} />
}
