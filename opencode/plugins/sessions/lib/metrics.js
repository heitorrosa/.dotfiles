// Session metrics: tokens, cost, timing, busy/idle and outcome straight from
// ctx.session.get. No storage writes.

import { unwrapSession, unwrapList } from "./read.js";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function sessionMetrics(session, extra = {}) {
  const s = unwrapSession(session);
  const tokens = (s.tokens && typeof s.tokens === "object") ? s.tokens : {};
  const cache = (tokens.cache && typeof tokens.cache === "object") ? tokens.cache : {};
  const time = (s.time && typeof s.time === "object") ? s.time : {};

  const created = num(time.created, 0) || null;
  const updated = num(time.updated, 0) || null;
  const completed = num(time.completed, 0) || null;
  const end = completed || updated || created;

  const messages = Array.isArray(extra.messages)
    ? extra.messages
    : unwrapList(extra.messages).length
      ? unwrapList(extra.messages)
      : null;

  return {
    sessionID: s.id || s.sessionID || extra.sessionID || null,
    title: s.title || null,
    agent: s.agent || null,
    parentID: s.parentID || null,
    directory: s.directory || null,
    busy: s.busy !== undefined ? Boolean(s.busy) : (s.running !== undefined ? Boolean(s.running) : null),
    outcome: s.outcome ?? s.status ?? null,
    steps: firstNumber(s.steps, s.step, extra.steps, messages ? messages.length : 0),
    messages: messages ? messages.length : firstNumber(s.messageCount, 0),
    tokens: {
      input: firstNumber(tokens.input, tokens.prompt),
      output: firstNumber(tokens.output, tokens.completion),
      reasoning: firstNumber(tokens.reasoning),
      cache_read: firstNumber(cache.read, tokens.cache_read),
      cache_write: firstNumber(cache.write, tokens.cache_write),
      total: firstNumber(tokens.total) || (
        firstNumber(tokens.input, tokens.prompt)
        + firstNumber(tokens.output, tokens.completion)
        + firstNumber(tokens.reasoning)
      ),
    },
    cost: firstNumber(s.cost, tokens.cost, cache.cost),
    time: {
      created,
      updated,
      completed,
      elapsed_ms: created && end ? Math.max(0, end - created) : 0,
    },
  };
}

function humanMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}m`;
  return `${(n / 3_600_000).toFixed(1)}h`;
}

export function formatMetrics(m) {
  if (!m) return "no metrics";
  const bits = [
    `session ${m.sessionID || "?"}`,
    m.title ? `title=${m.title}` : "",
    m.agent ? `agent=${m.agent}` : "",
    m.busy === null ? "" : `state=${m.busy ? "busy" : "idle"}`,
    m.outcome ? `outcome=${m.outcome}` : "",
    `steps=${m.steps}`,
    `tokens in/out=${m.tokens.input}/${m.tokens.output}`,
    m.tokens.reasoning ? `reasoning=${m.tokens.reasoning}` : "",
    `cache r/w=${m.tokens.cache_read}/${m.tokens.cache_write}`,
    `cost=$${Number(m.cost || 0).toFixed(4)}`,
    m.time.elapsed_ms ? `elapsed=${humanMs(m.time.elapsed_ms)}` : "",
  ].filter(Boolean);
  return bits.join("  ");
}
