// smoke.js — PLAN §3 + v3 verification + cache-quiet revision, no framework. Isolated roots, cleaned up after.
// Covers: quiet digest (empty unless mentioned/direct-ASK/new-RESULT), fixed
// head + seq-at-tail, ASK-escalation flags, lane-relevant threads, JSONL
// append, legacy-reader compat, caps/archive, no-push invariant, v3 acks
// (tool path), STALE-UNACKED aging, dead-letter quarantine (tool path),
// slow-consumer function (digest carries no slow/presence lines by design),
// backpressure counter, T2 200-post soak with reconcile, board_read shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pluginDefault from "./index.js";
import { __boardTest as T } from "./index.js";

const BOARD = path.join(os.homedir(), ".config", "opencode", "board");
const ROOT = "smoke-" + process.pid;
const ME = "ses_smoke_me";
let pass = 0;
function assert(c, name, extra) {
  if (!c) { console.error("FAIL:", name, extra ?? ""); process.exitCode = 1; }
  else { pass++; console.log("ok:", name); }
}
const now = Date.now();
const H = 3600 * 1000;

function seed() {
  const b = { root: ROOT, next_seq: 8, participants: ["main", ME, "ses_other"],
    dedupe: {},
    messages: [
      { id: "m1", seq: 1, from: ME, to: "ALL", type: "INFO", body: "hello", reply_to: null, ts: now - 30 * 60 * 1000 },
      { id: "m2", seq: 2, from: "ses_other", to: "ALL", type: "INFO", body: "ping @" + ME + " look", reply_to: null, ts: now - 25 * 60 * 1000 },
      { id: "m3", seq: 3, from: "ses_other", to: ME, type: "ASK", body: "need review", reply_to: null, ts: now - 20 * 60 * 1000 },
      { id: "m4", seq: 4, from: "ses_other", to: "ALL", type: "ASK", body: "quick q", reply_to: null, ts: now - 1 * 60 * 1000 },
      { id: "m5", seq: 5, from: ME, to: "ALL", type: "ASK", body: "DEADLINE:" + new Date(now + 2 * H).toISOString() + " later task", reply_to: null, ts: now - 20 * 60 * 1000 },
      { id: "m6", seq: 6, from: "main", to: "ALL", type: "RESULT", body: "ACK: done", reply_to: "m4", ts: now - 30 * 1000 },
      { id: "m7", seq: 7, from: "ses_other", to: "ALL", type: "INFO", body: "child note", reply_to: "m3", ts: now - 19 * 60 * 1000 },
    ] };
  fs.mkdirSync(BOARD, { recursive: true });
  fs.writeFileSync(path.join(BOARD, ROOT + ".json"), JSON.stringify(b));
  return b;
}

// 1. digest (quiet-cache): nonempty only when lane is addressed; fixed head; seq at tail
{
  const b = seed();
  const d = T.buildDigest(b, ME, ROOT);
  assert(typeof d === "string" && d.length > 0, "digest nonempty when mentioned");
  assert(Buffer.byteLength(d, "utf8") <= T.DIGEST_MAX, "digest <=2KiB", Buffer.byteLength(d, "utf8"));
  const lines = d.split("\n");
  assert(lines[0] === "[shared-board digest]", "fixed head line, no numbers/IDs", lines[0]);
  assert(!/[0-9]/.test(lines[0]), "head carries no digits");
  assert(!d.startsWith("[board #"), "seq header no longer first");
  assert(d.includes("@you:"), "mention section present");
  assert(d.indexOf("@you:") < d.indexOf("needs-reply:"), "mentions before needs-reply");
  const nrBlock = d.split("needs-reply:")[1].split(/^(new-results:|threads:|\[board #)/m)[0];
  assert(nrBlock.includes("#3") && !nrBlock.includes("#4") && !nrBlock.includes("#5"), "only overdue direct unanswered ASK escalated");
  assert(d.includes("  > "), "threads indented");
  assert(!d.includes("presence:") && !d.includes("slow:") && !d.includes("unread since") && !d.includes("newest/lane:"), "no wall-clock/broadcast-churn sections");
  const t3 = lines.find((l) => l.includes("#3 ") && l.startsWith("* "));
  assert(t3 && t3.includes("STALE-UNACKED") && !t3.includes("escalated"), "aged (20min) direct unanswered ASK flagged STALE-UNACKED");
  assert(!lines.some((l) => l.startsWith("* ") && l.includes("#4 ")), "lane-irrelevant broadcast thread excluded from digest");
  const tail = lines[lines.length - 1];
  assert(/^\[board #\d+\] acks \d+\/\d+ archived \d+, 0 lost dead \d+/.test(tail), "all counters in trailing state line", tail);
  assert(T.buildDigest(b, ME, ROOT) === d, "digest byte-stable");
  const q = T.buildDigest(b, "ses_quiet_zzz", ROOT);
  assert(q === "", "quiet lane gets empty digest despite broadcast ASK/unread", JSON.stringify(q).slice(0, 200));
  fs.mkdirSync(path.dirname(T.cursorFile(ROOT, "ses_quiet_zzz")), { recursive: true });
  fs.writeFileSync(T.cursorFile(ROOT, "ses_quiet_zzz"), JSON.stringify({ lastSeq: 7 }));
  assert(T.buildDigest(b, "ses_quiet_zzz", ROOT) === "", "quiet lane with cursor still empty");
  b.messages.push({ id: "m8", seq: 8, from: "main", to: "ALL", type: "RESULT", body: "ACK: reviewed", reply_to: "m3", ts: now });
  b.next_seq = 9;
  const d2 = T.buildDigest(b, ME, ROOT);
  assert(d2.includes("#3") && d2.includes("ACKed by main"), "ACK linking renders");
  assert(T.buildDigest(null, ME, ROOT) === "", "digest fail-open on null board");
}
// 2. append: 50 rapid appends, no interleave, seq monotonic
{
  const tdir = T.topicsDir(ROOT);
  fs.rmSync(tdir, { recursive: true, force: true });
  for (let i = 1; i <= 50; i++) {
    T.appendTopicLine(ROOT, { id: "x" + i, seq: i, from: ME, to: "ALL", type: "INFO", body: "line " + i, reply_to: null, ts: now });
  }
  const f = T.topicFile(ROOT, "ALL", "INFO");
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert(lines.length === 50, "50 appended lines", lines.length);
  const seqs = lines.map((l) => JSON.parse(l).seq);
  assert(seqs.every((s, i) => s === i + 1), "seq monotonic, no interleave");
}

// 3. compat: dual-write keeps legacy shape; old reader path intact
{
  const b = seed();
  const msg = { id: "m9", seq: 8, from: ME, to: "main", type: "RESULT", body: "dual", reply_to: null, ts: now };
  b.next_seq = 9; b.messages.push(msg);
  T.writeBoardDual(ROOT, b, msg);
  const raw = JSON.parse(fs.readFileSync(path.join(BOARD, ROOT + ".json"), "utf8"));
  assert(Array.isArray(raw.messages) && typeof raw.next_seq === "number" && Array.isArray(raw.participants) && raw.dedupe && typeof raw.dedupe === "object", "legacy shape keys intact");
  assert(raw.messages.every((m) => ["id", "seq", "from", "to", "type", "body", "reply_to", "ts"].every((k) => k in m)), "legacy msg schema untouched");
  const back = T.readBoard(ROOT);
  assert(back.messages.length === 8 && back.next_seq === 9, "readBoard sees dual-written board");
  assert(fs.existsSync(T.topicFile(ROOT, "main", "RESULT")), "topic file written");
  assert(T.acquireLock(ROOT) === true, "lock acquire");
  T.releaseLock(ROOT);
  assert(T.assignSeqUnderLock(ROOT, back) >= 9, "counter seq >= board");
}

// 4. caps/archive: overflow moves to dated archive, live under caps
{
  const b = T.blankBoard(ROOT);
  for (let i = 1; i <= 1005; i++) b.messages.push({ id: "a" + i, seq: i, from: ME, to: "ALL", type: "INFO", body: "pad " + i, reply_to: null, ts: now });
  b.next_seq = 1006;
  T.writeBoardDual(ROOT, b, null);
  const live = JSON.parse(fs.readFileSync(path.join(BOARD, ROOT + ".json"), "utf8"));
  assert(live.messages.length <= 1000, "live under 1000-cap", live.messages.length);
  const arch = T.archiveDir(ROOT);
  const files = fs.readdirSync(arch).filter((f) => f.endsWith(".jsonl"));
  const archived = files.reduce((n, f) => n + fs.readFileSync(path.join(arch, f), "utf8").trim().split("\n").length, 0);
  assert(archived >= 5, "evicted archived, not silently dropped", archived);
}

// 5. no-push invariant: digest/context paths never write the board
{
  for (const fn of [T.buildDigest, T.boardContextDigest]) {
    const src = fn.toString();
    assert(!src.includes("writeBoard(") && !src.includes("appendFileSync"), "no board writes on hot path: " + fn.name);
  }
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert(src.includes("Stored only. Does not wake"), "receipt text intact");
}

// ── v3 tool harness (mock ctx; bind pinned to isolated roots) ──
const tools = {};
const mockCtx = {
  tool: { transform: (fn) => fn({ add: (def) => { tools[def.name] = def; } }), hook: () => {} },
  session: { hook: () => {}, get: async () => null },
};
await pluginDefault.setup(mockCtx);
assert(tools.board_post && tools.board_read && tools.board_reset && tools.board_attach, "all 4 tools registered via mock ctx");
const bindPath = path.join(BOARD, "bind.json");
const bindBak = fs.readFileSync(bindPath, "utf8");
function bindAdd(map) {
  const b = JSON.parse(fs.readFileSync(bindPath, "utf8"));
  for (const k of Object.keys(map)) b[k] = map[k];
  fs.writeFileSync(bindPath, JSON.stringify(b));
}
const RA = "smokev3a-" + process.pid, RB = "smokev3b-" + process.pid,
  RC = "smokev3c-" + process.pid, RD = "smokev3d-" + process.pid,
  RE = "smokev3e-" + process.pid, RF = "smokev3f-" + process.pid;
const MEA = "ses_v3a_me", MEB = "ses_v3b_me", MED = "ses_v3d_me", MEF = "ses_v3f_me";
const ALLROOTS = [ROOT, RA, RB, RC, RD, RE, RF];
function wipeRoots() { // hermetic reruns: orphans from a crashed run never leak in
  for (const R of ALLROOTS) {
    fs.rmSync(path.join(BOARD, R + ".json"), { force: true });
    fs.rmSync(path.join(BOARD, R + ".seq"), { force: true });
    fs.rmSync(path.join(BOARD, R + ".lock"), { recursive: true, force: true });
    for (const d of [T.topicsDir(R), T.archiveDir(R), T.deadDir(R)]) fs.rmSync(d, { recursive: true, force: true });
    for (const f of fs.readdirSync(BOARD)) {
      if (f.startsWith(R + ".cursors") || f.startsWith(R + ".beat") || f.startsWith(R + ".acks")) fs.rmSync(path.join(BOARD, f), { recursive: true, force: true });
    }
  }
}
wipeRoots();
bindAdd({ [MEA]: RA, [MEB]: RB, [MED]: RD, [MEF]: RF });
async function post(sid, mid, args) {
  const r = await tools.board_post.execute(args, { sessionID: sid, messageID: mid });
  return JSON.parse(r.content);
}
async function read(sid, args) {
  const r = await tools.board_read.execute(args || {}, { sessionID: sid });
  return JSON.parse(r.content);
}

// 6. v3 acks via tool path: ack file written on read-with-since; coverage rides the tail line
{
  for (let i = 1; i <= 3; i++) {
    const r = await post(MEA, "ack-" + i, { to: "ALL", type: "INFO", body: "hello " + i });
    assert(!r.error && r.id, "post " + i + " stored", JSON.stringify(r).slice(0, 120));
  }
  const r1 = await read(MEA, { limit: 50 });
  assert(r1.messages.length === 3 && r1.cursor, "read returns 3 msgs + cursor");
  const r2 = await read(MEA, { since: r1.cursor, limit: 50 });
  assert(r2.messages.length === 0, "read past cursor is empty");
  assert(T.readAck(RA, MEA) === 3, "ack file written on read-with-since (ackSeq=head)", T.readAck(RA, MEA));
  const q = T.buildDigest(T.readBoard(RA), "ses_v3a_other", RA);
  assert(q === "", "unaddressed lane quiet despite 3 unread", JSON.stringify(q).slice(0, 120));
  await post(MEA, "ack-4", { to: "ALL", type: "INFO", body: "ping @ses_v3a_other hi" });
  const d = T.buildDigest(T.readBoard(RA), "ses_v3a_other", RA);
  assert(d.length > 0 && d.split("\n")[0] === "[shared-board digest]", "triggered digest keeps fixed head");
  assert(/acks 3\/4/.test(d.split("\n").pop()), "tail carries ack-coverage counter", d.split("\n").pop());
}
// 7. v3 dead-letter via tool path: same Conflict errors + quarantine with reason
{
  const over = await post(MEA, "dead-1", { to: "ALL", type: "INFO", body: "x".repeat(4097) });
  assert(over.error === "Conflict", "oversize still Conflict (no new error kinds)", JSON.stringify(over).slice(0, 120));
  const unrout = await post(MEA, "dead-2", { to: "ses_nonexistent_zzz", type: "INFO", body: "hello?" });
  assert(unrout.error === "Conflict", "unroutable still Conflict", JSON.stringify(unrout).slice(0, 120));
  const exp = await post(MEA, "dead-3", { to: "ALL", type: "ASK", body: "DEADLINE:2000-01-01T00:00:00.000Z stale task" });
  assert(exp.error === "Conflict", "expired still Conflict", JSON.stringify(exp).slice(0, 120));
  const st = T.readDeadStats(RA);
  assert(st.n === 3 && st.reasons.oversize === 1 && st.reasons.unroutable === 1 && st.reasons.expired === 1,
    "dead/ holds all 3 with correct reasons", JSON.stringify(st));
  const live = T.readBoard(RA);
  assert(live.messages.length === 4, "rejected posts never stored (3 INFO + §6 ack-4 mention)", live.messages.length);
  await post(MEA, "dead-4", { to: "ALL", type: "INFO", body: "ping @ses_v3a_other hi" });
  const d = T.buildDigest(T.readBoard(RA), "ses_v3a_other", RA);
  assert(/dead 3 \(expired:1 oversize:1 unroutable:1\)/.test(d.split("\n").pop()), "tail carries dead-letter counts with reasons",
    d.split("\n").pop());
}

// 8. v3 aging/escalation + slow-consumer + rate-limited note
{
  const b = { root: RC, next_seq: 4, participants: ["main", MEB, "ses_director"], dedupe: {},
    messages: [
      { id: "c1", seq: 1, from: "ses_director", to: MEB, type: "ASK", body: "old task", reply_to: null, ts: now - 20 * 60 * 1000 },
      { id: "c2", seq: 2, from: "ses_director", to: MEB, type: "ASK", body: "ancient task", reply_to: null, ts: now - 70 * 60 * 1000 },
      // fix3 board-time anchor: fresh head so board-max-ts ~= wall now and the
      // 20m/70m ages above keep their STALE/escalated meaning under board-time.
      { id: "c3", seq: 3, from: "ses_director", to: "ALL", type: "INFO", body: "fyi", reply_to: null, ts: now },
    ] };
  fs.writeFileSync(path.join(BOARD, RC + ".json"), JSON.stringify(b));
  const d = T.buildDigest(b, MEB, RC);
  assert(d.includes("STALE-UNACKED"), "aged ASK fixture fires STALE-UNACKED flag");
  assert(d.split("\n").find((l) => l.includes("#2 "))?.includes("STALE-UNACKED escalated"), "70min ASK escalated");
  assert(d.split("\n").find((l) => l.includes("#1 "))?.includes("[STALE-UNACKED]"), "20min ASK flagged, not escalated");

  const bd = T.blankBoard(RD);
  bd.participants = ["main", MED, "ses_laggy", "ses_stalebeat"];
  for (let i = 1; i <= 60; i++) bd.messages.push({ id: "d" + i, seq: i, from: MED, to: "ALL", type: "INFO", body: "pad " + i, reply_to: null, ts: now });
  bd.next_seq = 61;
  fs.writeFileSync(path.join(BOARD, RD + ".json"), JSON.stringify(bd));
  fs.mkdirSync(path.dirname(T.beatFile(RD, "ses_stalebeat")), { recursive: true });
  fs.mkdirSync(path.dirname(T.cursorFile(RD, "ses_stalebeat")), { recursive: true });
  fs.writeFileSync(T.beatFile(RD, "ses_stalebeat"), JSON.stringify({ ts: now - 20 * 60 * 1000, seq: 60 }));
  fs.writeFileSync(T.cursorFile(RD, "ses_stalebeat"), JSON.stringify({ lastSeq: 60, lastMentionSeq: 0 })); // caught up, only beat is stale
  T.resetSlowNotes();
  const slow = T.slowLanes(bd, RD, MED, now);
  assert(slow.some((s) => s.lane === "ses_laggy" && String(s.reason).startsWith("lag-")), "cursor-lag lane detected by slowLanes()", JSON.stringify(slow));
  assert(slow.some((s) => s.lane === "ses_stalebeat" && s.reason === "beat-stale"), "beat-stale lane detected by slowLanes()", JSON.stringify(slow));
  const s1 = T.buildDigest(bd, MED, RD);
  assert(s1 === "", "digest carries no slow/presence lines: INFO pads alone stay quiet", JSON.stringify(s1).slice(0, 200));
  assert(!s1.includes("slow:") && !s1.includes("note:") && !s1.includes("presence:"), "no wall-clock sections in digest");
  T.resetSlowNotes();
  assert(Buffer.byteLength(s1, "utf8") <= T.DIGEST_MAX, "quiet digest trivially <=2KiB");
}
// 9. v3 backpressure counter: N archived, 0 lost (digest quiet unless addressed; tail carries counts)
{
  const before = T.dropped_avoided;
  const b = T.blankBoard(RE);
  for (let i = 1; i <= 1005; i++) b.messages.push({ id: "e" + i, seq: i, from: MED, to: "ALL", type: "INFO", body: "pad " + i, reply_to: null, ts: now });
  b.next_seq = 1006;
  T.writeBoardDual(RE, b, null);
  assert(T.dropped_avoided >= before + 5, "mem counter tracks archived", T.dropped_avoided);
  const live = T.readBoard(RE);
  const q = T.buildDigest(live, MED, RE);
  assert(q === "", "backpressure alone never triggers a digest", JSON.stringify(q).slice(0, 120));
  live.messages.push({ id: "etrig", seq: 1006, from: "ses_other", to: MED, type: "INFO", body: "ping @ses_v3d_me go", reply_to: null, ts: now });
  const d = T.buildDigest(live, MED, RE);
  const tail = d.split("\n").pop();
  const m = tail.match(/archived (\d+), 0 lost/);
  assert(m && Number(m[1]) >= 5, "tail archived count matches counter, 0 lost", tail);
}
// 10. T2 soak: 200 rapid sequential posts, zero exceptions, reconcile
{
  let errors = 0;
  for (let i = 1; i <= 200; i++) {
    try {
      const r = await post(MEF, "t2-" + i, { to: "ALL", type: "INFO", body: "soak line " + i });
      if (r.error) errors++;
    } catch { errors++; }
  }
  assert(errors === 0, "200 posts, zero exceptions/errors", errors);
  const live = T.readBoard(RF);
  let archived = 0;
  try {
    for (const f of fs.readdirSync(T.archiveDir(RF)).filter((f) => f.endsWith(".jsonl")))
      for (const line of fs.readFileSync(path.join(T.archiveDir(RF), f), "utf8").split("\n")) if (line.trim()) archived++;
  } catch {}
  const dead = T.readDeadStats(RF).n;
  assert(live.messages.length === 200 && live.next_seq === 201, "live holds all 200, next_seq monotonic",
    live.messages.length + "/" + live.next_seq);
  assert(200 === live.messages.length + archived + dead, "counters reconcile (posted = live + archived + dead)",
    `posted=200 live=${live.messages.length} archived=${archived} dead=${dead}`);
}

// 11. board_read shape byte-identical for old clients
{
  const r = await read(MEF, {});
  assert(JSON.stringify(Object.keys(r)) === JSON.stringify(["messages", "cursor", "hasMore", "participants"]),
    "board_read top-level keys unchanged", Object.keys(r).join(","));
  assert(r.messages.every((m) => JSON.stringify(Object.keys(m).sort()) === JSON.stringify(["body", "from", "id", "reply_to", "seq", "to", "ts", "type"])),
    "message schema keys unchanged");
}

// 12. fix3: ASK flags byte-stable across wall-clock advance (board-time)
{
  const RG = "smokev3g-" + process.pid;
  const T0 = now;
  const gb = { root: RG, next_seq: 3, participants: ["main", MEA, "ses_director"], dedupe: {},
    messages: [
      { id: "g1", seq: 1, from: "ses_director", to: MEA, type: "ASK", body: "fresh task", reply_to: null, ts: T0 - 14 * 60 * 1000 },
      { id: "g2", seq: 2, from: "ses_director", to: "ALL", type: "INFO", body: "head", reply_to: null, ts: T0 },
    ] };
  fs.writeFileSync(path.join(BOARD, RG + ".json"), JSON.stringify(gb));
  const d1 = T.buildDigest(gb, MEA, RG);
  assert(d1.length > 0 && d1.split("\n")[0] === "[shared-board digest]", "fix3 triggered digest keeps fixed head");
  assert(d1.includes("[unacked]") && !d1.includes("STALE-UNACKED"), "14min ASK under board-time renders plain unacked", d1.split("\n").filter((l) => l.includes("#1")).join("|"));
  assert(T.buildDigest(gb, MEA, RG) === d1, "digest byte-identical across repeated builds, identical board state");
  const realNow = Date.now;
  Date.now = () => realNow() + 3600 * 1000; // simulated +1hr wall-clock advance
  let d3 = null;
  try { d3 = T.buildDigest(gb, MEA, RG); } finally { Date.now = realNow; }
  assert(d3 === d1, "digest identical across simulated +1hr clock advance (board-time, not wall-clock)");
  fs.rmSync(path.join(BOARD, RG + ".json"), { force: true });
}

// 13. fix3 (b): broadcast-only RESULT traffic renders counts-only; direct address keeps full text
{
  const RH = "smokev3h-" + process.pid;
  const hb = { root: RH, next_seq: 4, participants: ["main", MEA, "ses_other", "ses_third"], dedupe: {},
    messages: [
      { id: "h1", seq: 1, from: MEA, to: "ALL", type: "INFO", body: "baseline", reply_to: null, ts: now - 10 * 60 * 1000 },
      { id: "h2", seq: 2, from: "ses_other", to: "ALL", type: "RESULT", body: "did X detail alpha", reply_to: null, ts: now - 5 * 60 * 1000 },
      { id: "h3", seq: 3, from: "ses_third", to: "ALL", type: "RESULT", body: "did Y detail beta", reply_to: null, ts: now },
    ] };
  fs.writeFileSync(path.join(BOARD, RH + ".json"), JSON.stringify(hb));
  fs.mkdirSync(path.dirname(T.cursorFile(RH, MEA)), { recursive: true });
  fs.writeFileSync(T.cursorFile(RH, MEA), JSON.stringify({ lastSeq: 1 }));
  const dc = T.buildDigest(hb, MEA, RH);
  assert(dc.length > 0 && dc.split("\n")[0] === "[shared-board digest]", "counts-only digest keeps fixed head");
  assert(dc.includes("counts only"), "broadcast-only trigger renders counts-only mode", dc);
  assert(dc.includes("ses_other: 1") && dc.includes("ses_third: 1"), "per-lane unread counts present", dc);
  assert(!dc.includes("did X detail alpha") && !dc.includes("did Y detail beta"), "no message text in counts-only body", dc);
  assert(!dc.includes("new-results:") && !dc.includes("threads:"), "full-text sections absent in counts-only mode", dc);
  assert(dc.includes("[board #3]"), "tail state line survives in counts-only mode");
  // control: same board plus a direct @mention -> full text returns
  const hb2 = { ...hb, next_seq: 5, messages: hb.messages.concat([
    { id: "h4", seq: 4, from: "ses_other", to: "ALL", type: "INFO", body: "ping @" + MEA + " go", reply_to: null, ts: now },
  ]) };
  const df = T.buildDigest(hb2, MEA, RH);
  assert(df.includes("@you:") && df.includes("ping @" + MEA + " go"), "direct @mention keeps full text", df);
  assert(df.includes("new-results:"), "broadcast RESULTs keep full text under direct address", df);
  fs.rmSync(path.join(BOARD, RH + ".json"), { force: true });
  fs.rmSync(path.dirname(T.cursorFile(RH, MEA)), { recursive: true, force: true });
}

// cleanup
fs.writeFileSync(bindPath, bindBak);
wipeRoots();
console.log(`\nSMOKE PASS: ${pass} assertions`);
