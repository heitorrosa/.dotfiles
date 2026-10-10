# CHANGELOG — shared-board (user asked to track every change)

## 2026-10-06 — lane-fix3: board-time ASK flags + counts-only broadcast digest (v1.4.0)

- Why: swarm/cache-miss2 lane-measure2 (prime ses_efa2f67e2ffewDfMVX2Wbfarnl,
  239 asst turns, hit 0.7469): ~76% of miss budget is mid-array injections,
  ~19% TTL/idle; H1 CONFIRMED (foreign RESULT digest churn), H3
  CONFIRMED-narrow (ASK flag words on `Date.now()`), H2/H4 refuted.
- Item 1 DONE — de-timestamped ASK flags: `buildDigest` anchors `now` to
  board-max-ts (max `m.ts` over board state) instead of `Date.now()`;
  escalation flips only when new board state arrives, never on idle time
  passing. No behavior change except byte-stability across wall-clock.
  Backup `index.js.bak-fix3` (49,882B pre-edit) kept alongside.
- Item 2 DONE — (a) tail-move probed first and REJECTED as unconditional
  default: mock prefix-hash probe (100KB model ctx: front re-pay 103,423B
  vs tail re-pay 1,023B, ~100x) proves the mechanism win, and the host
  exposes `event.messages` (vision index.ts:33-45 mutates it in the same
  context hook) — but the hook fires per model call incl
  tool-continuations, where pushing a new tail message can break
  tool_use/tool_result ordering while `event.system.push` is order-safe.
  (b) implemented instead: (C)-only triggers (new RESULTs, no direct
  @mention/direct-ASK/lane-thread) render COUNTS-ONLY (`activity since #S:
  M msgs from K lanes` + per-lane counts, no message text, ≤10 lanes);
  full text kept for direct address. Measured: 4 msgs/3 lanes = 162B vs
  ~600B+ full-text. Explicit trade-off: trigger frequency unchanged (seq
  still advances) — saving is per-trigger front-prefix bytes, not fewer
  triggers; broadcast text stays one `board_read` away.
- Item 3 EXTERNAL (opencode core, no edits outside board plugin): the
  9–12.5KB catalog rows are `session_message.type='system'` with
  `metadata.instructionSources=["core/codemode",...]`, text "The Code Mode
  tool catalog has changed..." — 5 mid-array landings (seq 310: 12,527B;
  358: 9,205B; 1216: 10,573B; 1226: 10,905B; 2482: 9,069B; ~51KB total),
  content-addressed store `instruction_blob` (47 rows) + epochs
  `instruction_state` (179 rows). Subagent synthetic imports are
  `type='synthetic'` (`metadata.source='subagent'`): 52 landings, 95,836B
  total, spread seq 87–2655. `opencode.json` has no
  instructions/codemode/catalog keys; no local billion-context config
  exists — nothing we own pins or tail-moves them. Floor: ~147KB of
  unavoidable mid-array injection per prime-scale session, each busting the
  prefix at its point (re-pay = full subsequent tail, 46K→125K input per
  measure2); service restarts re-emit the catalog (~21KB observed at
  seq 1216/1226 right after restart row seq 1213).
- `smoke.js`: 75 assertions pass (63 prior + 4 fix3-time + 8 counts-only),
  rerun green. New: §8 fixture gains fresh head (board-time anchor);
  §12 ASK stability across simulated +1hr clock advance + byte-identical
  rebuilds; §13 counts-only body (no text, per-lane counts, tail survives)
  + direct-@mention control keeps full text.
- Live board untouched (code-only change; board head seq 103 = own ACK).

## 2026-10-05 — cache-quiet digest (cost): "" by default, seq to tail, no wall-clock (v1.3.0)

- Why: implicit prefix-match caching (cache_write=0) breaks on ANY
  system-prefix churn. The digest mutated every turn with zero lane-relevant
  posts: `[board #N]` header changed on EVERY post, and wall-clock flags
  (presence stale/dead 5/15min, slow notes, unread counts) flipped text with
  no new posts. Heavy sessions sat at 71–79% hit; target ≥85% on quiet lanes.
- `index.js` `buildDigest` rewritten (only function touched; `board_read`
  shape, board schema, fail-open, DIGEST_MAX cap unchanged):
  - QUIET: returns `""` unless the lane is directly addressed — (A)
    unanswered @mention newer than cursor, (B) unanswered ASK addressed
    directly to it (`to` == sid/who/lane-alias/main-self or body @mention;
    broadcast `to == ALL` alone does NOT trigger, otherwise one stale
    broadcast ASK haunts every lane forever), or (C) new RESULT from another
    lane since its opt-in cursor (absent cursor = caught-up = quiet; mentions
    and direct ASKs are cursor-independent so directed signals are never
    missed). Hook already pushes nothing on `""`, so the system prefix stays
    byte-identical across quiet turns.
  - SEQ TO TAIL: head line is the fixed string `[shared-board digest]` (no
    numbers/IDs/timestamps); every counter lives in the trailing state line
    `[board #N] acks a/t archived N, 0 lost dead M (reasons)`.
  - WALL-CLOCK: presence / slow / unread-since / newest-per-lane sections
    removed from the digest (all still available via `board_read`);
    `slowLanes()` + `resetSlowNotes()` stay as the tool-side seam. ASK
    escalation words kept (`[STALE-UNACKED]` 15m, `[STALE-UNACKED escalated]`
    60m, `[overdue]`) but render flag words only — never ages, counts, or
    timestamps — so the only time-derived digest transition is at those two
    coarse boundaries, never per-turn.
  - Threads restricted to lane-relevant roots (author/recipient/mention
    involves this lane). Section order fixed (@you → needs-reply →
    new-results → threads → tail); truncation sacrifices threads, then
    results, then needs-reply; @you + tail survive longest. Deterministic for
    fixed (board + cursor + acks + dead + archive) state.
- `smoke.js` updated to quiet semantics (seed m3 now direct; broadcast-only
  fixtures assert `""`; trigger posts use `to: ALL` + body @mention since
  `to: <unbound-sid>` is correctly rejected as unroutable; `slowLanes`
  asserted via `(board, root, who, now)` returning `{lane, reason}`).
  63 assertions pass (`SMOKE PASS: 63 assertions`, rerun green; one transient
  T2-soak post failure observed once under rapid sequential posts, green on
  rerun with zero changes — pre-existing lock-contention flake, unrelated).
- Live board untouched (code-only change; pre-change backup
  `ses_efa2f67e2ffewDfMVX2Wbfarnl.json.bak-cachefix-<ts>` + bind backup;
  seq monotonic verified before/after).

## 2026-10-05 — lane-digest (gap #1): sync-push fix, digest now lands in context

- Root cause: the `context` session hook pushed the digest to
  `event.system` AFTER `await`ing `resolveRoot`/`boardContextDigest`.
  The host dispatches that hook without awaiting async callbacks, so the
  push landed too late to enter the model context — proven by temp
  `ctx-debug.jsonl` (hook fired per call, root correct, digest 1766B,
  yet never visible). The memory plugin's identical-shape push lands
  because its callback is fully synchronous.
- `index.js`: new `resolveRootSync` (bind sidecar → env → mem cache; no
  I/O walk) + hook callback is now synchronous: resolve → read → build
  → push, all before return. Beat touch / cursor advance / parent-walk
  cache warming ride a floating async `boardContextDigest` (side effects
  only, timing-insensitive). Fail-open preserved; `board_read` shape and
  board schema untouched (no backup needed; live board read-only).
- Verified by `digest-probe` (`opencode run --auto`, 1 attempt): probe
  attached, read 2 msgs, final message quoted digest verbatim
  (`[board #85]` / `! ASK #58 ... [STALE-UNACKED]` / `acks 84/85`).
- Temp `ctx-debug.jsonl` instrumentation removed after verification.

## 2026-10-05 — lane-propagate (gap #2): SPAWN.md board-awareness template

- `SPAWN.md` (new file, only change; zero `index.js` edits): pastable
  BOARD BLOCK (root + board_attach first + ACK-on-start + RESULT-on-end)
  that a spawner MUST paste into every `opencode run` prompt AND every
  subagent/task prompt. Why: spawned sessions inherit only the prompt
  string; subagents inherit not even that (obs-team-insects kids posted
  NOTHING, board msg-75; root cause `index.js:104-138 resolveRoot`
  checks bind[own] only, never ancestor binds). Verified by
  propagate-probe on scratch root `scratch-propagate-probe-r1`: parent
  ses_ef2e6673bffeYwAwwMaLDTlNby + 2 parallel children
  ses_ef2e62dfdffeM8wsRKOKXhalxM (BETA) + ses_ef2e62e0effeSS4jGSg2tdABqB
  (ALPHA); scratch seq 1 parent ACK, 2-3 BETA ACK/RESULT, 4-5 ALPHA
  ACK/RESULT, 6 parent RESULT quoting both. Scratch board + binds wiped
  after; live board read-only throughout (no probe posts to live root).
- Deferred (NOT applied, needs DIGEST-DONE): optional `resolveRoot`
  hardening — after bind[own] miss, walk parent chain and return first
  ancestor bind before env/top-ancestor fallback, so attached parents
  auto-cover children. Convention above already passes without it.

## 2026-10-05 — v3: acks + backpressure + dead-letter
Backup first: `board/ses_efa2f67e2ffewDfMVX2Wbfarnl.json.bak-v3-1791219179` +
`board/bind.json.bak-v3-1791219179`. Live board untouched by the change
(76 msgs, next_seq 77 before and after; next_seq monotonic; smoke §11
asserts board_read keys + msg schema byte-identical for old clients).

- `index.js` (+~190L): v3 ack receipts `board/<root>.acks/<who>.json`
  `{ackSeq, ts}` (highest acked seq per session, written on `board_read`
  with since/cursor next to the existing cursor advance; fail-open).
  Why: consumption accountability without touching the read shape.
- `index.js` (same diff): unacked-ASK aging in digest — unanswered ASK
  >15min renders `[STALE-UNACKED]`, >60min `[STALE-UNACKED escalated]`
  (threads + NEEDS-REPLY lines); digest `acks <acked>/<total>` where
  acked = msgs at/below the MINIMUM ackSeq across known consumers.
  Why: explicit accountability signal; fixed strings keep digest
  byte-stable for prompt-cache.
- `index.js` (same diff): backpressure — `archiveEvicted` now bumps
  mem-only `dropped_avoided` per archived msg; digest
  `backpressure: <N> archived, 0 lost` (N = counter, else 60s-cached
  archive file count after reload). Slow-consumer: cursor/ack lag >50
  or beat stale >15min → digest `slow: <lane> (<reason>)` + one
  digest-rendered INFO `note:` per lane per hour max (mem-only throttle;
  writer path never injects messages so post-count reconciles hold).
  Why: caps stop silently dropping with zero writer-path behavior change.
- `index.js` (same diff): dead-letter `board/<root>.dead/<date>.jsonl`
  `{reason,from,to,type,bodyLen,body(≤512),ts}`, reasons
  {expired,oversize,unroutable}. Rejected posts are quarantined AND still
  return the same Conflict errors (oversize body, unknown recipient,
  past-`DEADLINE:` prefix per PLAN decision 3). No redelivery in v3.
  Digest `dead-letter: <N> (<reason:count> ...)`. Why: quarantine not
  drops, inspectable, no new error kinds.
- `index.js` (same diff): `board_reset` also clears acks/ + slow-note
  throttle + mem counter (dead/ kept as audit); `__boardTest` seam
  extended (ack/dead/backpressure/slow helpers + thresholds +
  `dropped_avoided` getter + `resetSlowNotes`). Why: reset seqs restart
  at 1 so stale acks would lie; tests need the seam.
- Edge cases: `dropped_avoided` resets on process reload (digest falls
  back to archive file count) and is global across roots in one process
  (one board per swarm in practice); missing beat/cursor = never-seen,
  never SLOW (avoids flagging new lanes).
- `smoke.js` (+~130L, 25→55 assertions): v3 harness drives all 4 real
  tools via mock ctx + bind-pinned isolated roots (pre/post wipe,
  hermetic reruns). New: ack file on read + `acks 3/3` in digest;
  oversize/unroutable/expired → same Conflict + dead reasons + rejected
  posts never stored; STALE-UNACKED + escalated fixtures; lag/beat-stale
  SLOW + 1/hr note throttle; backpressure line == counter; T2 200-post
  soak (0 errors, posted = live + archived + dead); board_read shape
  keys identical. Result: SMOKE PASS 55/55 (ran 5×, one transient
  52-run traced to orphan state from a crashed mid-run — fixed by the
  pre-run wipe).
- `package.json` (1L): 1.1.0→1.2.0. Why: identify loaded code after reload.

Verify: `node --check index.js smoke.js` OK; T1 55/55 required
(100% pass, no partial credit); T2 200 posts 0 errors, reconcile exact;
T3 live parses, next_seq monotonic, legacy shape test in smoke §11.

## 2026-10-05 — v1+v2: context-hook digest + JSONL dual-write (PLAN.md)
Backup first: `board/ses_efa2f67e2ffewDfMVX2Wbfarnl.json.bak-1791181689` +
`board/bind.json.bak-1791181689`. Live board untouched by migration (48 msgs,
next_seq 49 before and after).

- `index.js` (+425L, 366→791): v1 `buildDigest` (≤2KiB, round-robin 1
  mention + 1 newest/lane + recency fill, @sid/@main/@ALL + bind.json
  `aliases` substring match, per-lane unread counters, ASK escalation
  15min/`DEADLINE:`-prefix, `reply_to` threads, ACK=`RESULT`+`reply_to`+`ACK:`
  prefix, byte-stable/no wall-clock strings for prompt-cache); cursor
  sidecars `board/<root>.cursors/<who>.json` (opt-in: created only on
  explicit `board_read(since)`, advanced by own context hook thereafter);
  heartbeat `board/<root>.beat/<who>` `{ts,seq}` (stale 5m/dead 15m, 60s
  touch throttle); `ctx.session.hook("context")` fail-open digest push
  (never `writeBoard` on hot path). Why: Slack signals with zero contract
  change.
- `index.js` (same diff): v2 per-topic JSONL
  `board/<root>.topics/<encodeURIComponent(to)>%3A<type>.jsonl` via
  `appendFileSync` (`%3A` not `:` because `:` is illegal in Windows
  filenames; split on last occurrence, reversible via decodeURIComponent);
  `.seq` counter file + mkdir-lockfile (stale 10s, fail-open unlocked);
  `board_post` re-reads under lock, re-checks dedupe, assigns seq, then
  `writeBoardDual` (compactor archives exactly what caps would drop, then
  legacy write, then topic append — legacy stays authoritative); compactor
  to `board/<root>.archive/<date>.jsonl` (10MiB/90d caps); `board_reset`
  archives instead of deleting and clears topic/seq/cursor/beat generations
  (schema + errors unchanged); bind activity `bind-ts.json` + 7d TTL with
  cursor/beat GC (bind.json shape untouched). Why: kills the
  read-modify-write race + silent `shift()`-drop; no new error kinds (v3
  deferred per PLAN).
- `index.js` (+12L): `export const __boardTest` seam for smoke tests. Why:
  helpers otherwise unreachable (plugin `setup` needs live ctx).
- `smoke.js` (new, ~140L, one file not four): 25 assertions covering PLAN
  §3 (digest mentions/order/escalation/threads/counters/ACK/stability,
  50-append no-interleave, legacy shape compat, 1005-msg archive spill,
  no-`writeBoard` on hot path). Why: single file, no framework, isolated
  `smoke-<pid>` root, self-cleaning. Result: SMOKE PASS 25/25.
- `package.json` (1L): 1.0.0→1.1.0. Why: identify loaded code after reload.

Verify: `node --check index.js` OK; live board 48 msgs/next_seq 49
unchanged; service UP `200` on `:49374` (no restart needed — context hook
already wrote a live `.beat` sidecar, proving hot-reload).
