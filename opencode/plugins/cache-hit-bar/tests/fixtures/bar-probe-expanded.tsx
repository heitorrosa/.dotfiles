/** @jsxImportSource @opentui/solid */
import { CacheStatusMenu } from "../../src/bar.tsx"

/**
 * Menu-content probe: the dialog menu body rendered standalone (no host
 * api needed). Lines match the synthetic $24.00 scenario in bar.test.ts.
 */
export function BarProbe() {
  return (
    <CacheStatusMenu
      title="Cache Hit (90.0% · 10.2M tok)"
      lines={[
        "req hit      : 90.0% ↑",
        "session total: 90.0% ↑",
        "",
        "subagents    : -- (0)",
        "",
        "total        : 10.2M tok (90.0% ↑)",
        "cache read   : 9M tok",
        "cache write  : 100K tok",
        "",
        "saved cost   : $24.00",
      ]}
    />
  )
}
