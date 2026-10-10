# SPEC-swarm-mq — Slack-like signals + real MQ on shared-board

Scope: spec only, no code. Baseline: `Plugin.define` id `shared-board` (index.js:159-160);
4 tools via `ctx.tool.transform` (index.js:171); board file `~/.config/opencode/board/<root>.json` (index.js:19,35-37);
schema `{id,seq,from,to,type,body,reply_to,ts}` (index.js:222-231); caps 1000 msgs / 2 MiB silent `shift()` (index.js:20-21,77-86);
read `limit<=50` + 32 KiB drop-oldest/truncate (index.js:256-276); `to=main|ALL|sid` display-only (index.js:213-221);
dedupe exact-key (index.js:201-212); `NOTICE` via `ctx.tool.hook("execute.after")` is inert text (index.js:344-364);
no push — posts NEVER wake (index.js:6-7,24); reset root-only + revision (index.js:296-304).

## 1. Slack-like signals (all v2-implementable, no wake)

All signals below ride `ctx.session.hook("context")` + `event.system.push` digest injection
(proven pattern: memory/src/index.ts:77, autoresearch/index.js:92, vision/index.ts:33).
Digest builder reuses `readBoard` (index.js:63-74) read-only; never `writeBoard` (index.js:88-94) on the hot path.

- **@mention directive.** Convention: `@<sessionID>` / `@main` / `@ALL` substring in `body` (body 1-4096, index.js:196-197).
  Digest hook scans newest N msgs, lists `mentioning me` section first. Text convention only — no `notify`/push API exists.
- **Unread-mentions-per-session cursor.** New sidecar `board/<root>.cursors/<sid>.json` `{lastSeq, lastMentionSeq}`.
  Advanced only by reader's own `context` hook / explicit `board_read(since)` (cursor semantics index.js:260-268).
  Old readers ignore sidecar (backward-compat; board file schema index.js:222-231 untouched).
- **Per-lane unread counters.** Digest emits `unread: <k> msgs since seq <s>, <m> mentioning you` per `from` lane.
  Derived from `senderOf` (index.js:139-141) + `participants[]` (index.js:96-98). Cap digest bytes (frozen-snapshot cache
  rule; dynamic board text breaks prompt-cache — keep digest ≤2 KiB, truncate oldest first as in index.js:271-276).
- **ACK-receipt upgrade (RESULT-ACK linking).** Convention, no schema change: an ACK is `type=RESULT` with `reply_to=<msg-id>`
  (field exists index.js:229) + body prefix `ACK:`. Digest renders `ASK <id> → ACKed by <who>` / `unacked`.
  Receipt string stays (index.js:24,236); `board_post` return `{id,from,to,type,receipt}` (index.js:236) unchanged.
- **ASK escalation.** Digest hook surfaces unanswered `type=ASK` (enum index.js:184) older than T turns / wall-clock,
  `reply_to`-linked RESULT absent, in prime `context` hook output under `NEEDS-REPLY`. Advisory-only like HOLD/VETO
  (index.js:156-157) — never blocks `execute.before` (contrast memory/src/index.ts:84 throw-to-block).
- **Typing / heartbeat.** Per-lane touch-file `board/<root>.beat/<sid>` = `{ts, seq}` written from own session's
  `context` or `prompt` hook (`ctx.session.hook("prompt")` = before_agent_start equiv) — own-session only, no peer reach
  (same limit as `execute.before/after` snooping own calls, index.js:344-347). Digest marks lane stale if `now-ts > K`.
  Best-effort presence; absence ≠ death (polling-only delivery, no wake).
- **Threading.** `reply_to` chains (index.js:229, index.js:261-264 cursor walk) rendered as indented threads in digest:
  root ASK + replies grouped by `reply_to`, ordered by `seq`/`ts` (index.js:223,230). No new field; readers without
  thread rendering see flat list as today (index.js:265).

## 2. Real message queue within plugin constraints

Goal: at-least-once, ordered-per-topic, bounded, without cross-session wake (impossible — no notify API) and without
changing the 4-tool contract (`board_post/read/reset/attach` via `ctx.tool.transform`, index.js:171-340).

- **Per-topic logs.** Topic = routing key `to + ":" + type-prefix`, e.g. `ALL:ASK`, `main:RESULT`, `lane-design:INFO`.
  Derived from existing `to` (index.js:192,226) + `type` enum (index.js:184,227). Storage: append-only
  `board/<root>.topics/<topic>.jsonl`, one line per msg (today: single whole-file JSON, index.js:35-37,65-74).
  Global `board/<root>.json` retained as index/cache for old readers (`messages,next_seq,participants,dedupe`, index.js:60).
- **Atomic append (kill read-modify-write).** Today `readBoard→push→writeBoard` has no lock; concurrent posts can lose
  (whole-file `writeFileSync+renameSync`, index.js:88-94; tmp+rename in index.js:91-93 is crash-atomic, not race-safe).
  New path: `fs.appendFileSync(topic.jsonl, line)` — single-syscall atomic under PIPE_BUF for ≤4 KiB bodies
  (body cap index.js:23,196-197 keeps lines small); or tmp+rename per message. Whole-file rewrite kept only for the
  legacy index snapshot, rebuilt lazily, never on the writer critical path. `enforceCaps` (index.js:77-86) moves to compactor.
- **Per-consumer cursor/ack files.** `board/<root>.cursors/<sid>.json` `{cursor: <msg-id|seq>, ackSeq: <n>}`.
  ACK = cursor advance (explicit `board_read` with `since`, index.js:247-268, already cursor-shaped: index.js:260-268).
  `read` returns unacked slice first (redelivery of unacked on next read); at-least-once, idempotent consumers required
  (existing dedupe exact-key precedent, index.js:203-212). Dead-letter: after N reads without ack, move line ref to
  `board/<root>.dead/*.jsonl` with `{id,reads}` count; digest hook surfaces dead-letter depth.
- **Backpressure.** Cap `pending-per-consumer = headSeq - ackSeq ≤ MAX_PENDING` (suggest 200). When full,
  `board_post` `execute` (index.js:191-237) returns `errJson Conflict` (existing shape index.js:143-145) with
  `Retry-After` hint instead of append. Writer never blocks otherwise (today writer never blocks; keep it).
  Per-topic cap prevents one hot `to=ALL` lane starving direct `to=<sid>` lanes (today single 1000-msg pool, index.js:20).
- **Ordering.** Per-topic monotonic `seq` assigned at append (extends `next_seq`, index.js:60,232; needs atomic counter —
  `next_seq` file or `O_APPEND`-offset derived seq). Global `board_read` merges topic heads by `ts` (index.js:230),
  tie-break `seq`. Cross-topic total order explicitly NOT guaranteed (same as today: single array order = arrival, racy).
- **Retention (stop silent drop).** Today `enforceCaps` silently `shift()`s (index.js:79-84) and `board_reset` is
  irreversible (index.js:305-307). New: compactor moves evicted lines to `board/<root>.archive/<yyyy-mm-dd>.jsonl`
  instead of dropping; archive excluded from reads; `reset` (index.js:282-310, root+revision gate index.js:299-304)
  archives instead of deleting by default (add `purge:true` only for true wipe).

## 3. Migration path

- **v1 — digest + mentions, read-only.** Add `context`-hook digest (`ctx.session.hook("context")`) + `@mention`/unread/
  ASK-escalation/threading conventions on current file (index.js:63-74 read path). No schema change; cursor sidecars
  opt-in. Old readers ignore digest text (same as `NOTICE`, index.js:25-26,344-364).
- **v2 — JSONL append.** Dual-write: append `topics/*.jsonl` + legacy whole-file snapshot (index.js:88-94) for compat.
  Readers still hit `<root>.json`; new readers prefer JSONL. Compactor + archive ships here; `enforceCaps` stays as
  snapshot guard (index.js:77-86) until v3.
- **v3 — acks + backpressure.** Cursor/ack files, redelivery, dead-letter, `MAX_PENDING` Conflict on `board_post`
  (extends validation block index.js:195-221; new error kinds alongside No-self-post/Unknown-recipient).
  Snapshot becomes derived cache; JSONL is source of truth.
- **Backward compat.** New fields/sidecars ignored by old code (defensive `readBoard`, index.js:63-74 already tolerates
  shape drift); `board_read` output shape `{messages,cursor,hasMore,participants}` (index.js:270) unchanged — digest,
  threads, counters are rendered text, not schema. `reply_to` (index.js:229) and `since` (index.js:261-264) already exist.
- **Stays out.** Cross-session wake/resume (impossible — no notify/push API; `NOTICE` is text, index.js:344-364; receipt
  index.js:24). ACL/permissions (out of scope — full history to all by design, index.js:240-246). True exactly-once
  (at-least-once + idempotent consumers only). Multi-root routing (one file per root, index.js:35-37; `resolveRoot`
  precedence bind>env>parent-chain, index.js:100-137, untouched).

## 4. Open questions

1. Digest budget: 2 KiB cap enough with 5+ hot lanes, or per-lane round-robin? (cache-freeze rule vs recency.)
2. `@mention` syntax: `@<full-sid>` is verbose; short-lane aliases need a registry — where (bind.json sidecar index.js:39)?
3. ASK timeout T: turns vs wall-clock? Who sets per-ASK deadlines — new `body` prefix convention or schema field (breaks index.js:222-231 compat)?
4. Heartbeat staleness K: what threshold distinguishes idle vs dead given polling-only delivery?
5. `next_seq` atomicity under dual-write: lockfile, separate counter file, or accept rare dup seq (dedupe index.js:203-212 covers replays, not seq collisions)?
6. Dead-letter N: redelivery count vs age? Who reaps `.dead/` — prime only (`reset` gate index.js:299-304) or any participant?
7. Backpressure scope: per-consumer pending vs per-topic depth — which binds first under `to=ALL` fanout?
8. Archive growth: retention window / size cap for `.archive/` (today 2 MiB total cap index.js:21 — new equivalent)?
9. `bind.json` staleness (stale bind wins per resolveRoot index.js:104-114): should re-attach expire, else cursors leak per stale sid?
10. `sanitizeRoot` collisions (index.js:30-33 strips chars): topic-file escaping rule for exotic `to` values?
