# PLAN — shared-board Slack signals (v1) + JSONL MQ (v2)

Source: SPEC-swarm-mq.md (99L) + index.js (366L, 4 tools, read-modify-write JSON, caps 1000/2MiB).
Constraint: no-push invariant holds (NOTICE inert, index.js:344-364). `board_read` shape unchanged (index.js:270).

## 1. Decisions on SPEC §4 (10 open questions)

1. Digest budget → keep 2 KiB hard cap + per-lane round-robin inside (1 mention + 1 newest/lane, then recency fill); rationale: prompt-cache freeze needs fixed cap, round-robin stops hot ALL lane starving direct lanes.
2. Mention syntax → full-sid substring match + short-lane alias map in bind.json sidecar (`aliases:{lane: sid}`); rationale: no schema change (body convention only), bind.json already exists (index.js:39), old readers ignore it.
3. ASK timeout T → wall-clock 15 min default, per-ASK override via `DEADLINE:<ISO>` body-prefix convention, no schema field; rationale: turn counts unobservable cross-session, prefix keeps index.js:222-231 compat.
4. Heartbeat K → stale 5 min, dead 15 min; rationale: context-hook cadence is minutes per turn, so 5 min separates idle from dead without false positives under polling-only delivery.
5. next_seq atomicity → separate `next_seq` counter file + mkdir-lockfile around assign; rationale: dedupe (index.js:203-212) covers replays not seq collisions, lockfile is stdlib-only and gives dual-write one sequencer.
6. Dead-letter N → N=5 reads without ack (count, not age), reaped by prime/root only (existing reset gate index.js:299-304); rationale: read-count observable via cursor sidecars, age is not under polling; prime-only matches current trust model.
7. Backpressure scope → per-consumer pending (`headSeq-ackSeq ≤ 200`) binds first, per-topic depth (1000) secondary; rationale: `to=ALL` fanout multiplies per-consumer pending, so consumer cap is the binding constraint; topic cap stops hot-lane starvation.
8. Archive cap → 10 MiB / 90-day TTL, compactor-enforced, dated files; rationale: 5× live 2 MiB cap (index.js:21) bounds disk, dated names make TTL a file listing.
9. Bind staleness → bindings expire after 7 d inactivity, cursors GC'd with them; rationale: stale-bind-wins (index.js:104-114) otherwise leaks cursor sidecars per dead sid.
10. sanitizeRoot collisions → topic files use `encodeURIComponent(to)` + `:` + type; rationale: sanitizeRoot (index.js:30-33) strips chars and collides, encoding is reversible with no schema change.

## 2. MVP scope: v1+v2 this round, v3 deferred

Implement v1 (context-hook digest ≤2 KiB, @mention/unread/ASK-escalation/threads/ACK conventions, cursor sidecars opt-in) AND v2 (per-topic JSONL dual-write, atomic appendFileSync, compactor/archive) now.
Reason safe: v1 is read-only (reuses readBoard index.js:63-74, never writeBoard on hot path); v2 keeps legacy `<root>.json` snapshot so old readers work while JSONL becomes crash-safe writer path; fixes the load-bearing race (concurrent posts lose data today, index.js:88-94) and silent shift-drop (index.js:79-84).
Defer v3 (acks/redelivery/dead-letter/MAX_PENDING Conflict): adds new error paths to board_post validation (index.js:195-221) and at-least-once consumer semantics that need a live-board soak first; shipping it with the storage migration doubles blast radius.

## 3. Test plan (node smoke scripts, no framework)

- Digest mentions/unread: seed board with @sid posts, run digest builder, assert mentioning-me section first and per-lane counters correct. `node smoke_digest.js`.
- ASK escalation: seed unanswered ASK older than 15 min + one with linked RESULT reply_to, assert only unanswered surfaces under NEEDS-REPLY. Same script.
- Threads render: seed ASK + 2 reply_to children, assert indented group ordered by seq/ts; assert flat board_read output byte-identical to baseline. Same script.
- JSONL append crash-safe: 50 parallel appendFileSync writes, assert 50 lines, no interleave, seq monotonic. `node smoke_append.js`.
- Legacy readers unaffected: dual-write then read via old readBoard, assert shape `{messages,cursor,hasMore,participants}` unchanged and sidecars ignored. `node smoke_compat.js`.
- Caps/archive: exceed 1000 msgs / force 2 MiB, assert compactor moves to `.archive/<date>.jsonl`, live file under caps, nothing silently lost. `node smoke_archive.js`.
- No-push invariant: post 10 msgs, assert no wake/resume calls, NOTICE text only, hook never touches writeBoard. Assert via code grep + runtime flag in smoke scripts.

## 4. Risks to live board (ses_efa2f67e2ffewDfMVX2Wbfarnl.json, 42+ msgs) + mitigations

- Migration mid-run loses posts (read-modify-write race, index.js:88-94) → file backup `board/<root>.json.bak-<ts>` before any migration; dual-write keeps legacy snapshot authoritative until JSONL verified.
- Digest hook breaks prompt-cache (dynamic text per turn) → 2 KiB cap + byte-stable truncation (oldest-first, index.js:271-276 rule); hook fail-open (try/catch, empty digest on error).
- Cursor sidecars leak per stale sid → 7 d binding TTL + cursor GC (decision 9).
- Compactor/archive disk growth → 10 MiB/90 d cap with dated-file TTL (decision 8).
- next_seq dup under dual-write → counter file + mkdir-lockfile (decision 5); JSONL seq is source of truth, snapshot next_seq derived.
- v3-style Conflict errors leaking into v1/v2 → no new error kinds this round; backpressure explicitly deferred.
