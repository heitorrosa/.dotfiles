/**
 * OpenCode 2 server-side entry (`exports["."]`).
 *
 * The bar is TUI-only, but V2 requires a loadable server entrypoint before
 * it reports `features.tui`, and the CLI only activates TUI plugins the server
 * knows about. Deliberately a no-op: the real work is in `exports["./tui"]`.
 * V1 never resolves this file (it reads `./server` or `main`; neither exists).
 */
export default {
  id: "cache-hit-bar",
  setup() {},
}
