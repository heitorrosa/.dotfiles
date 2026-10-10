/** @jsxImportSource @opentui/solid */
import { CacheHitBarHost } from "../../src/bar.tsx"

/**
 * Render probe: the smallest tree that exercises the real bar component with
 * faked host state. Driven by tests/fixtures/bar-probe-runner.ts in a
 * subprocess (`bun --conditions=browser`), same pattern as the upstream
 * fold-probe fixture this plugin's data layer was copied from.
 */
const PRIME = "ses_probe_prime"

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
  return <CacheHitBarHost sessionId={PRIME} api={fakeApi as never} />
}
