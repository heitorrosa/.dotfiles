# opencode-memo (memo v3 plugin — Bun, zero deps)

Thin glue: the memo container is the sole writer (M-032). This plugin NEVER
opens `memo.db` — every call goes over the MCP endpoint.

## Config (opencode.json — replaces the two `hermes-*` lines)

```json
{ "mcp": { "memo": { "type": "remote", "url": "http://localhost:8000/mcp",
  "headers": { "Authorization": "Bearer ${MEMO_TOKEN}" } } } }
```

Remote/web harnesses: same entry with the tunnel URL. Env: `MEMO_ENDPOINT`
(default `http://localhost:8000/mcp`), `MEMO_TOKEN` (required for `--http`).

## Hooks

- `transform`: appends `templates/hermes-block.md` (§26.1 verbatim) + the
  frozen `MEMORY.md`/`USER.md` snapshots. Pure string op, no MCP call.
- `onSessionStart`: reads `memo://summary` + `skill_sync(harness:"opencode",
  known)`; applies deltas **deletes-then-writes** (a rename arriving as
  delete+write must not leave both copies); rewrites the two `.md` views.
  Failure (down / bad token / tunnel expired) → warn + stale `.md`;
  **the session never fails because memory is down** (M-026).
- `onAfterWrite`: only `skills/**/SKILL.md` → parses frontmatter
  (`name`, `description`) + body → `skill_put` with `source='local-hook'`,
  debounced 2s per path; failures logged, never thrown. Equal bodies are a
  server-side no-op, so the common case converges silently.

## Single truth direction

File/row disagree → the hook overwrites the FILE, never the row.
Single write path: memories → `memory_save`; skills → local file then
`skill_put` (row first, file second; the next sync repairs the file, M-022).

## Notes

- Tool names are `skill_*`-prefixed; they never collide with opencode's
  native bare `skill` / `skill_create` / `skill_list` (M-018).
- Tunnels: experiments → `cloudflared tunnel --url http://localhost:8000`;
  settled use → named tunnel to `http://memo:8000`. The URL is PUBLIC —
  unauthenticated `--http` is a review-blocking bug (M-030a).
