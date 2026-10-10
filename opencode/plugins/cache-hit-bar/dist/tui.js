// @bun
// src/plugin.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";

// src/bar.tsx
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, untrack } from "solid-js";

// src/session-list.ts
function parseSessionListResponse(all) {
  const list = Array.isArray(all) ? all : all?.data ?? [];
  if (!Array.isArray(list))
    return [];
  return list.map((raw) => {
    const s = raw;
    return {
      id: s.id ?? "",
      parentID: s.parentID,
      created: s.time?.created ?? s.createdAt
    };
  }).filter((e) => e.id.length > 0);
}
function childSessionEntriesForParent(list, parentId) {
  return list.filter((s) => s.parentID === parentId);
}

// src/child-session-sync.ts
var CHILD_LIST_DEBOUNCE_MS = 200;
function createChildSessionSync(opts) {
  let listGen = 0;
  let debounceTimer;
  const clearDebounce = () => {
    if (debounceTimer !== undefined)
      clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };
  const loadChildren = () => {
    clearDebounce();
    const parentId = opts.getParentId();
    if (!parentId) {
      opts.setChildIds([]);
      opts.setChildEntries?.([]);
      return;
    }
    const gen = listGen;
    const directory = opts.getDirectory();
    opts.client.list({ query: { directory } }).then((all) => {
      if (gen !== listGen || opts.getParentId() !== parentId)
        return;
      const entries = childSessionEntriesForParent(parseSessionListResponse(all), parentId);
      opts.setChildIds(entries.map((e) => e.id));
      opts.setChildEntries?.(entries);
      opts.onSynced?.();
    }, () => {
      if (gen !== listGen || opts.getParentId() !== parentId)
        return;
      opts.setChildIds([]);
      opts.setChildEntries?.([]);
    });
  };
  const scheduleLoad = () => {
    clearDebounce();
    if (!opts.getParentId())
      return;
    const ms = opts.debounceMs ?? CHILD_LIST_DEBOUNCE_MS;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      loadChildren();
    }, ms);
  };
  const resetForParentChange = () => {
    listGen++;
    clearDebounce();
    opts.setChildIds([]);
  };
  const onForeignSessionActivity = (sessionId) => {
    const parentId = opts.getParentId();
    if (!parentId || !sessionId || sessionId === parentId)
      return;
    scheduleLoad();
  };
  const dispose = () => {
    listGen++;
    clearDebounce();
  };
  return {
    loadChildren,
    scheduleLoad,
    resetForParentChange,
    onForeignSessionActivity,
    dispose,
    _generation: () => listGen
  };
}

// src/session-messages.ts
var SESSION_MESSAGE_LIMIT = 1e4;
var TUI_MIRROR_LIMIT = 100;
function responseEntries(raw) {
  if (Array.isArray(raw))
    return raw;
  if (!raw || typeof raw !== "object")
    return null;
  const data = raw.data;
  return Array.isArray(data) ? data : null;
}
function normalizeEntries(entries) {
  const messages = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object")
      return null;
    const info = entry.info;
    if (!info || typeof info !== "object")
      return null;
    const message = info;
    if (typeof message.role !== "string")
      return null;
    if (message.role === "assistant")
      messages.push(message);
  }
  return messages;
}
function fallbackResult(fallback, reason) {
  const messages = [...fallback];
  if (messages.length < TUI_MIRROR_LIMIT) {
    return { messages, status: "complete", source: "mirror" };
  }
  return { messages, status: "unavailable", source: "mirror", reason };
}
async function loadSessionMessages(opts) {
  const fallback = opts.fallback;
  const request = opts.client.messages;
  if (!request) {
    return fallbackResult(fallback, "missing-client");
  }
  let raw;
  try {
    raw = await request({
      path: { id: opts.sessionId },
      query: { directory: opts.directory, limit: opts.limit ?? SESSION_MESSAGE_LIMIT }
    });
  } catch {
    return fallbackResult(fallback, "request-failed");
  }
  const entries = responseEntries(raw);
  const messages = entries ? normalizeEntries(entries) : null;
  if (!entries || !messages) {
    return fallbackResult(fallback, "malformed-response");
  }
  const limit = opts.limit ?? SESSION_MESSAGE_LIMIT;
  if (entries.length >= limit) {
    return { messages, status: "capped", source: "direct", reason: "limit-reached" };
  }
  return { messages, status: "complete", source: "direct" };
}

// src/stats.ts
function emptySessionSnapshot() {
  return { model: "", providerID: "", input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
function aggregateFromSessionObject(session) {
  const t = session.tokens;
  const c = t?.cache;
  return {
    model: session.model?.id ?? "",
    providerID: session.model?.providerID ?? "",
    input: t?.input ?? 0,
    output: t?.output ?? 0,
    reasoning: t?.reasoning ?? 0,
    cacheRead: c?.read ?? 0,
    cacheWrite: c?.write ?? 0,
    cost: session.cost ?? 0
  };
}
function aggregateSessionFromMessages(messages) {
  let model = "", providerID = "", input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !isInteractiveAssistantMessage(msg))
      continue;
    const t = msg.tokens ?? {};
    input += t.input ?? 0;
    output += t.output ?? 0;
    reasoning += t.reasoning ?? 0;
    cacheRead += t.cache?.read ?? 0;
    cacheWrite += t.cache?.write ?? 0;
    cost += msg.cost ?? 0;
    if (msg.modelID)
      model = msg.modelID;
    if (msg.providerID)
      providerID = msg.providerID;
  }
  return { model, providerID, input, output, reasoning, cacheRead, cacheWrite, cost };
}
function toSubAgentSummary(id, snap, speed, created) {
  return {
    id,
    model: snap.model,
    providerID: snap.providerID,
    cost: snap.cost,
    input: snap.input,
    output: snap.output,
    reasoning: snap.reasoning,
    cacheRead: snap.cacheRead,
    cacheWrite: snap.cacheWrite,
    speed,
    created
  };
}
function aggregateSubAgents(subs) {
  const total = emptySessionSnapshot();
  for (const s of subs) {
    total.input += s.input;
    total.output += s.output;
    total.reasoning += s.reasoning;
    total.cacheRead += s.cacheRead;
    total.cacheWrite += s.cacheWrite;
    total.cost += s.cost;
  }
  return total;
}
function cacheHitRatio(cacheRead, input) {
  const denom = cacheRead + input;
  return denom > 0 ? cacheRead / denom : 0;
}
function withModelFallback(snap, messages) {
  if (snap.model && snap.providerID)
    return snap;
  let model = snap.model;
  let providerID = snap.providerID;
  for (let i = messages.length - 1;i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant")
      continue;
    if (!model && m.modelID)
      model = m.modelID;
    if (!providerID && m.providerID)
      providerID = m.providerID;
    if (model && providerID)
      break;
  }
  return model === snap.model && providerID === snap.providerID ? snap : { ...snap, model, providerID };
}
function isInteractiveAssistantMessage(msg) {
  return msg.summary !== true && msg.agent !== "compaction";
}
function compareAssistantMessages(a, b) {
  const aCompleted = a.time?.completed ?? -Infinity;
  const bCompleted = b.time?.completed ?? -Infinity;
  if (aCompleted !== bCompleted)
    return aCompleted - bCompleted;
  const aCreated = a.time?.created ?? -Infinity;
  const bCreated = b.time?.created ?? -Infinity;
  if (aCreated !== bCreated)
    return aCreated - bCreated;
  return (a.id ?? a.messageID ?? "").localeCompare(b.id ?? b.messageID ?? "");
}
function perMessageHitPercent(msg) {
  if (msg.role !== "assistant" || !isInteractiveAssistantMessage(msg))
    return null;
  const t = msg.tokens;
  if (!t)
    return null;
  const input = t.input ?? 0;
  const read = t.cache?.read ?? 0;
  const denom = read + input;
  if (denom <= 0)
    return null;
  return read / denom * 100;
}

// src/dynamic-pricing/context.ts
function selectContextRates(cost, contextTokens, threshold = 200000) {
  if (!cost.context_over_200k)
    return cost;
  if (contextTokens === undefined)
    return cost;
  const eff = cost.contextThreshold ?? threshold;
  return contextTokens > eff ? cost.context_over_200k : cost;
}
function normalizeRuntimeCost(cost) {
  if (cost.context_over_200k)
    return cost;
  const raw = cost;
  if (raw.experimentalOver200K) {
    return { ...cost, context_over_200k: raw.experimentalOver200K, contextThreshold: 200000 };
  }
  const tier = raw.tiers?.find((t) => t.tier?.type === "context");
  if (tier) {
    return {
      ...cost,
      context_over_200k: {
        input: tier.input,
        output: tier.output,
        cache: { read: tier.cache?.read ?? 0, write: tier.cache?.write ?? 0 }
      },
      contextThreshold: tier.tier?.size ?? 200000
    };
  }
  return cost;
}
function scaleRates(cost, factor) {
  if (factor === 1)
    return cost;
  return {
    input: cost.input * factor,
    output: cost.output * factor,
    cache: { read: cost.cache.read * factor, write: cost.cache.write * factor },
    context_over_200k: cost.context_over_200k ? {
      input: cost.context_over_200k.input * factor,
      output: cost.context_over_200k.output * factor,
      cache: {
        read: cost.context_over_200k.cache.read * factor,
        write: cost.context_over_200k.cache.write * factor
      }
    } : undefined
  };
}
function billingCost(rates, input, output, cacheRead, cacheWrite) {
  return (input * rates.input + output * rates.output + cacheRead * rates.cache.read + cacheWrite * rates.cache.write) / 1e6;
}

// src/dynamic-pricing/deepseek.ts
var DEEPSEEK_DEFAULT_RULE = {
  multipliers: { peak: 1, offpeak: 0.5 }
};
function isDeepSeek(providerID, modelID) {
  const pid = providerID.toLowerCase();
  const mid = modelID.toLowerCase();
  return pid.includes("deepseek") || mid.startsWith("deepseek/");
}

// src/dynamic-pricing/schedule.ts
function prevWeekday(weekday) {
  return (weekday - 2 + 7) % 7 + 1;
}
function isEveryDayWindow(w) {
  return !w.days || w.days.length === 0;
}
function inWindow(dayMinute, weekday, w) {
  const anyDay = isEveryDayWindow(w);
  if (w.start <= w.end) {
    if (!anyDay && !w.days.includes(weekday))
      return false;
    return dayMinute >= w.start && dayMinute < w.end;
  }
  if (dayMinute >= w.start)
    return anyDay || w.days.includes(weekday);
  const prev = prevWeekday(weekday);
  return dayMinute < w.end && (anyDay || w.days.includes(prev));
}
var tzFormatterCache = new Map;
function tzFormatter(timezone) {
  let f = tzFormatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    tzFormatterCache.set(timezone, f);
  }
  return f;
}
function tzPartsOf(ts, timezone) {
  const parts = Object.fromEntries(tzFormatter(timezone).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  let year = Number(parts.year);
  let month = Number(parts.month);
  let day = Number(parts.day);
  let hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (hour === 24) {
    hour = 0;
    const d = new Date(Date.UTC(year, month - 1, day + 1));
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }
  return { year, month, day, hour, minute, second };
}
function dayMinuteOf(ts, timezone) {
  const p = tzPartsOf(ts, timezone);
  return p.hour * 60 + p.minute + p.second / 60;
}
function tzWeekdayOf(ts, timezone) {
  const p = tzPartsOf(ts, timezone);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return (dow + 6) % 7 + 1;
}
function isLevelAt(now, schedule, timezone) {
  if (schedule.length === 0)
    return;
  const min = dayMinuteOf(now, timezone);
  const weekday = tzWeekdayOf(now, timezone);
  let fallback;
  for (const lvl of schedule) {
    if (lvl.windows.length === 0) {
      fallback = lvl.level;
      continue;
    }
    for (const w of lvl.windows) {
      if (inWindow(min, weekday, w))
        return lvl.level;
    }
  }
  return fallback;
}

// src/dynamic-pricing/lookup.ts
function lookupModelCost(providers, providerID, modelID) {
  if (!providerID || !modelID)
    return null;
  for (const p of providers) {
    if (p.id !== providerID)
      continue;
    const model = p.models[modelID];
    return model?.cost ? normalizeRuntimeCost(model.cost) : null;
  }
  return null;
}
var warnedNoWeekday = new Set;
function maybeWarnDeepSeekWeekend(rules, providerID, modelID) {
  if (!rules?.enabled || !isDeepSeek(providerID, modelID))
    return;
  const hasWindowed = rules.schedule.some((l) => l.windows.length > 0);
  const hasDays = rules.schedule.some((l) => l.windows.some((w) => w.days && w.days.length > 0));
  if (!(hasWindowed && !hasDays))
    return;
  const key = `${providerID}/${modelID}`;
  if (warnedNoWeekday.has(key))
    return;
  warnedNoWeekday.add(key);
  console.warn(`[dynamicPricing] ${key} schedule is not weekday-aware \u2014 weekends 9:00-12:00/14:00-18:00 may still bill at peak. ` + `Add "days":[1,2,3,4,5] to the peak windows to match DeepSeek's weekend off-peak pricing.`);
}
function effectiveRule(rules, providerID, modelID) {
  if (!rules?.enabled)
    return;
  const explicit = rules.providers[providerID]?.models[modelID];
  if (explicit)
    return explicit;
  if (rules.schedule.length > 0 && isDeepSeek(providerID, modelID)) {
    return DEEPSEEK_DEFAULT_RULE;
  }
  return;
}
function resolveLevel(now, rules) {
  if (!rules?.enabled)
    return;
  const tz = rules.timezone || "UTC";
  return isLevelAt(now, rules.schedule, tz);
}
function tierOf(cost, tokens, threshold) {
  if (!cost.context_over_200k || tokens === undefined)
    return;
  const eff = cost.contextThreshold ?? threshold;
  return tokens > eff ? "over" : "base";
}
function resolveModelCost(providers, providerID, modelID, ctx = {}) {
  const base = lookupModelCost(providers, providerID, modelID);
  if (!base)
    return null;
  if (ctx.rules && !ctx.rules.enabled)
    return { rates: base, explicit: false };
  const now = ctx.now ?? Date.now();
  const rules = ctx.rules;
  const level = resolveLevel(now, rules);
  maybeWarnDeepSeekWeekend(rules, providerID, modelID);
  const rule = effectiveRule(rules, providerID, modelID);
  const effThreshold = rule?.contextThreshold ?? base.contextThreshold ?? rules?.contextThreshold ?? 200000;
  const effBase = base.contextThreshold === effThreshold ? base : { ...base, contextThreshold: effThreshold };
  const contextTier = tierOf(effBase, ctx.contextTokens, effThreshold);
  if (rule?.levels) {
    const absolute = level ? rule.levels[level] : undefined;
    if (absolute) {
      return { rates: absolute, level, contextTier: undefined, explicit: true };
    }
    return { rates: selectContextRates(effBase, ctx.contextTokens, effThreshold), level: undefined, contextTier, explicit: true };
  }
  if (rule?.multipliers) {
    const factor = level ? rule.multipliers[level] ?? 1 : 1;
    const levelShown = level !== undefined && rule.multipliers[level] !== undefined;
    return { rates: scaleRates(selectContextRates(effBase, ctx.contextTokens, effThreshold), factor), level: levelShown ? level : undefined, contextTier, explicit: true };
  }
  const levelAware = rule?.levels !== undefined || rule?.multipliers !== undefined;
  return { rates: selectContextRates(effBase, ctx.contextTokens, effThreshold), level: levelAware ? level : undefined, contextTier, explicit: rule !== undefined };
}

// src/bar-format.ts
function pricedSessionCost(snap, providers) {
  const resolved = resolveModelCost(providers, snap.providerID, snap.model);
  if (!resolved)
    return snap.cost;
  return billingCost(resolved.rates, snap.input, snap.output, snap.cacheRead, snap.cacheWrite);
}
function computeBarModel(main, mainMessages, kids, providers) {
  const snap = withModelFallback(main, mainMessages);
  const kidMessages = kids.flatMap((k) => k.messages ?? []);
  const ordered = [...mainMessages, ...kidMessages].filter((msg) => msg.role === "assistant" && isInteractiveAssistantMessage(msg)).slice().sort(compareAssistantMessages);
  const last = ordered[ordered.length - 1];
  let prevReqHit = null;
  for (let i = ordered.length - 2;i >= 0; i--) {
    const h = perMessageHitPercent(ordered[i]);
    if (h !== null) {
      prevReqHit = h;
      break;
    }
  }
  const subSnaps = kids.map((k) => withModelFallback(k.snap, k.messages ?? []));
  const agg = aggregateSubAgents(kids.map((k, i) => toSubAgentSummary(k.id, subSnaps[i])));
  let costTotal = pricedSessionCost(snap, providers);
  let cacheReadTotal = snap.cacheRead;
  let cacheWriteTotal = snap.cacheWrite;
  let savedTotal = savedSessionCost(snap, providers);
  let inputTotal = snap.input;
  let outputTotal = snap.output;
  let reasoningTotal = snap.reasoning;
  for (const sub of subSnaps) {
    costTotal += pricedSessionCost(sub, providers);
    cacheReadTotal += sub.cacheRead;
    cacheWriteTotal += sub.cacheWrite;
    savedTotal += savedSessionCost(sub, providers);
    inputTotal += sub.input;
    outputTotal += sub.output;
    reasoningTotal += sub.reasoning;
  }
  return {
    reqHit: last ? perMessageHitPercent(last) : null,
    prevReqHit,
    sessionHit: cacheHitRatio(snap.cacheRead, snap.input) * 100,
    subsHit: kids.length > 0 ? cacheHitRatio(agg.cacheRead, agg.input) * 100 : null,
    subsCount: kids.length,
    costTotal,
    cacheReadTotal,
    cacheWriteTotal,
    savedTotal,
    totalHit: cacheHitRatio(cacheReadTotal, inputTotal) * 100,
    totalTokens: inputTotal + outputTotal + cacheReadTotal + cacheWriteTotal + reasoningTotal
  };
}
function savedSessionCost(snap, providers) {
  const resolved = resolveModelCost(providers, snap.providerID, snap.model, {
    contextTokens: snap.input + snap.cacheRead
  });
  if (!resolved)
    return 0;
  const r = resolved.rates;
  const uncached = ((snap.input + snap.cacheRead) * r.input + snap.output * r.output) / 1e6;
  return uncached - billingCost(r, snap.input, snap.output, snap.cacheRead, snap.cacheWrite);
}
function trendGlyph(cur, prev) {
  if (cur === null || cur === undefined || prev === null || prev === undefined)
    return "\u2191";
  return cur - prev >= 0 ? "\u2191" : "\u2193";
}
function prevReqOf(m, prev) {
  if (prev?.reqHit !== undefined)
    return prev.reqHit;
  return m.prevReqHit ?? undefined;
}
function pctTrend(v, prev) {
  if (v === null)
    return "--";
  return `${v.toFixed(1)}% ${trendGlyph(v, prev)}`;
}
function formatBarLine(m, prev) {
  const req = pctTrend(m.reqHit, prevReqOf(m, prev));
  return `${formatTokens(m.totalTokens)} tok \xB7 cache hit ${req} (${m.totalHit.toFixed(1)}% ${trendGlyph(m.totalHit, prev?.totalHit)}) \xB7`;
}
function formatTokens(v) {
  const trim1 = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
  if (v >= 1e6)
    return `${trim1(v / 1e6)}M`;
  if (v >= 1000)
    return `${trim1(v / 1000)}K`;
  return `${v}`;
}
function formatMenuTitle(m) {
  return `Cache Hit (${m.totalHit.toFixed(1)}% \xB7 ${formatTokens(m.totalTokens)} tok)`;
}
function formatExpandedLines(m, prev) {
  const req = pctTrend(m.reqHit, prevReqOf(m, prev));
  const sess = pctTrend(m.sessionHit, prev?.sessionHit);
  const subs = pctTrend(m.subsHit, prev?.subsHit);
  const total = pctTrend(m.totalHit, prev?.totalHit);
  const label = (s) => s.padEnd(13, " ");
  const cacheWriteValue = m.cacheWriteTotal > 0 ? `${formatTokens(m.cacheWriteTotal)} tok` : "n/a (implicit)";
  return [
    `${label("req hit")}: ${req}`,
    `${label("session total")}: ${sess}`,
    "",
    `${label("subagents")}: ${m.subsHit === null ? "--" : subs} (${m.subsCount})`,
    "",
    `${label("total")}: ${formatTokens(m.totalTokens)} tok (${total})`,
    `${label("cache read")}: ${formatTokens(m.cacheReadTotal)} tok`,
    `${label("cache write")}: ${cacheWriteValue}`,
    "",
    `${label("saved cost")}: $${m.savedTotal.toFixed(2)}`
  ];
}

// src/bar.tsx
function nextMenuAction(menuOpen, hasDialog) {
  if (!hasDialog)
    return "noop";
  return menuOpen ? "close" : "open";
}
function rowFg(hovered, muted, base) {
  return hovered ? base ?? muted : muted;
}
function CacheStatusMenu(props) {
  return (() => {
    var _el$ = _$createElement("box");
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "paddingLeft", 2);
    _$setProp(_el$, "paddingRight", 2);
    _$setProp(_el$, "paddingTop", 1);
    _$setProp(_el$, "paddingBottom", 1);
    _$insert(_el$, (() => {
      var _c$ = _$memo(() => !!props.title);
      return () => _c$() ? [(() => {
        var _el$2 = _$createElement("text"), _el$3 = _$createElement("b");
        _$insertNode(_el$2, _el$3);
        _$setProp(_el$2, "wrapMode", "none");
        _$insert(_el$3, () => props.title);
        return _el$2;
      })(), (() => {
        var _el$4 = _$createElement("text");
        _$insertNode(_el$4, _$createTextNode(` `));
        _$setProp(_el$4, "wrapMode", "none");
        return _el$4;
      })()] : null;
    })(), null);
    _$insert(_el$, _$createComponent(For, {
      get each() {
        return props.lines;
      },
      children: (l) => l === "" ? (() => {
        var _el$6 = _$createElement("text");
        _$insertNode(_el$6, _$createTextNode(` `));
        _$setProp(_el$6, "wrapMode", "none");
        return _el$6;
      })() : (() => {
        var _el$8 = _$createElement("text");
        _$setProp(_el$8, "wrapMode", "none");
        _$insert(_el$8, l);
        _$effect((_$p) => _$setProp(_el$8, "fg", props.muted, _$p));
        return _el$8;
      })()
    }), null);
    return _el$;
  })();
}
function CacheHitBarHost(props) {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [childIds, setChildIds] = createSignal([]);
  const [historyMessages, setHistoryMessages] = createSignal([]);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let historyLoadGeneration = 0;
  const bumpRefresh = () => setRefreshTick((v) => v + 1);
  const childSync = createChildSessionSync({
    client: props.api.client.session,
    getDirectory: () => props.api.state.path.directory,
    getParentId: () => props.sessionId,
    setChildIds,
    onSynced: bumpRefresh
  });
  onCleanup(() => childSync.dispose());
  const mirrorMessages = createMemo(() => {
    refreshTick();
    const sid = props.sessionId;
    if (!sid)
      return [];
    return props.api.state.session.messages(sid) ?? [];
  });
  const mainSnap = createMemo(() => {
    refreshTick();
    const sid = props.sessionId;
    if (!sid)
      return emptySessionSnapshot();
    const session = props.api.state.session.get?.(sid);
    if (session) {
      const snap = aggregateFromSessionObject(session);
      const msgs = props.api.state.session.messages(sid);
      return msgs ? withModelFallback(snap, msgs) : snap;
    }
    const msgs = props.api.state.session.messages(sid);
    return msgs?.length ? aggregateSessionFromMessages(msgs) : emptySessionSnapshot();
  });
  const kids = createMemo(() => {
    refreshTick();
    const out = [];
    for (const cid of childIds()) {
      const kidMsgs = props.api.state.session.messages(cid) ?? [];
      const session = props.api.state.session.get?.(cid);
      if (session) {
        const snap = aggregateFromSessionObject(session);
        out.push({
          id: cid,
          snap: kidMsgs.length ? withModelFallback(snap, kidMsgs) : snap,
          messages: kidMsgs
        });
        continue;
      }
      if (kidMsgs.length)
        out.push({
          id: cid,
          snap: aggregateSessionFromMessages(kidMsgs),
          messages: kidMsgs
        });
    }
    return out;
  });
  const model = createMemo(() => {
    refreshTick();
    const hist = historyMessages();
    return computeBarModel(mainSnap(), hist.length ? hist : untrack(mirrorMessages), kids(), props.api.state.provider ?? []);
  });
  const [lastTurnPrev, setLastTurnPrev] = createSignal(undefined);
  const line = createMemo(() => formatBarLine(model(), untrack(lastTurnPrev)));
  createEffect(() => {
    const m = model();
    setLastTurnPrev({
      sessionHit: m.sessionHit,
      subsHit: m.subsHit,
      totalHit: m.totalHit
    });
  });
  const toggleMenu = (ev) => {
    if (ev && typeof ev.button === "number" && ev.button !== 0)
      return;
    ev?.stopPropagation?.();
    const dialog = props.dialog;
    switch (nextMenuAction(menuOpen(), Boolean(dialog))) {
      case "open":
        setMenuOpen(true);
        dialog.show(() => _$createComponent(CacheStatusMenu, {
          get title() {
            return formatMenuTitle(model());
          },
          get lines() {
            return formatExpandedLines(model(), untrack(lastTurnPrev));
          },
          get muted() {
            return props.muted;
          }
        }), () => setMenuOpen(false));
        return;
      case "close":
        setMenuOpen(false);
        dialog.clear();
        return;
      case "noop":
        return;
    }
  };
  const loadHistory = (sid) => {
    const generation = ++historyLoadGeneration;
    const mirror = untrack(mirrorMessages);
    setHistoryMessages(mirror);
    if (!sid)
      return;
    loadSessionMessages({
      client: props.api.client.session,
      sessionId: sid,
      directory: props.api.state.path.directory,
      fallback: mirror
    }).then((result) => {
      if (generation !== historyLoadGeneration)
        return;
      setHistoryMessages(result.messages);
    });
  };
  createEffect(() => {
    const sid = props.sessionId;
    props.api.state.path.directory;
    childSync.resetForParentChange();
    loadHistory(sid);
    if (sid)
      childSync.loadChildren();
  });
  createEffect(() => {
    const unsub = props.api.event.on("message.updated", (event) => {
      bumpRefresh();
      const msg = event.properties?.info;
      childSync.onForeignSessionActivity(msg?.sessionID);
      if (msg?.sessionID === props.sessionId && msg?.role === "assistant") {
        setHistoryMessages((messages) => {
          const id = msg.id ?? msg.messageID;
          const next = [...messages];
          const index = id ? next.findIndex((m) => (m.id ?? m.messageID) === id) : -1;
          if (index >= 0)
            next[index] = msg;
          else
            next.push(msg);
          return next;
        });
      }
    });
    onCleanup(() => unsub?.());
  });
  return (() => {
    var _el$9 = _$createElement("text");
    _$setProp(_el$9, "wrapMode", "none");
    _$setProp(_el$9, "truncate", true);
    _$setProp(_el$9, "onMouseUp", toggleMenu);
    _$insert(_el$9, line);
    _$effect((_p$) => {
      var _v$ = rowFg(props.hovered?.() ?? false, props.muted, props.base), { onMouseOver: _v$2, onMouseOut: _v$3 } = props;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$9, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$9, "onMouseOver", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$9, "onMouseOut", _v$3, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$9;
  })();
}

// src/v2/map.ts
function toAssistantMessage(row, sessionID) {
  return {
    id: row.id,
    messageID: row.id,
    role: row.type === "assistant" ? "assistant" : row.type,
    agent: row.agent,
    modelID: row.model?.id,
    providerID: row.model?.providerID,
    cost: row.cost,
    summary: row.type === "compaction" ? true : undefined,
    finish: row.finish,
    time: row.time,
    tokens: row.tokens ? {
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      cache: { read: row.tokens.cache?.read ?? 0, write: row.tokens.cache?.write ?? 0 }
    } : undefined,
    sessionID
  };
}
function toSessionObject(row) {
  if (!row)
    return;
  return {
    model: row.model ? { id: row.model.id, providerID: row.model.providerID } : undefined,
    cost: row.cost,
    tokens: row.tokens,
    parentID: row.parentID
  };
}
function toProviderInfos(providers, models) {
  const byProvider = new Map;
  for (const model of models ?? []) {
    const cost = toModelCost(model.cost);
    if (!cost)
      continue;
    const bucket = byProvider.get(model.providerID) ?? {};
    bucket[model.id] = { cost };
    byProvider.set(model.providerID, bucket);
  }
  return (providers ?? []).map((provider) => ({
    id: provider.id,
    models: byProvider.get(provider.id) ?? {}
  }));
}
function toModelCost(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    return null;
  const base = entries.find((entry) => !entry.tier) ?? entries[0];
  if (!base)
    return null;
  const cost = {
    input: base.input ?? 0,
    output: base.output ?? 0,
    cache: { read: base.cache?.read ?? 0, write: base.cache?.write ?? 0 }
  };
  const tier = entries.find((entry) => entry.tier?.type === "context");
  if (tier) {
    cost.context_over_200k = {
      input: tier.input ?? 0,
      output: tier.output ?? 0,
      cache: { read: tier.cache?.read ?? 0, write: tier.cache?.write ?? 0 }
    };
    cost.contextThreshold = tier.tier?.size ?? 200000;
  }
  return cost;
}
function toThemeRecord(theme) {
  const t = theme;
  return {
    primary: t?.text?.action?.primary?.base,
    text: t?.text?.base,
    textMuted: t?.text?.muted ?? t?.current?.textMuted,
    success: t?.text?.feedback?.success?.base,
    warning: t?.text?.feedback?.warning?.base,
    error: t?.text?.feedback?.error?.base,
    border: t?.border?.base
  };
}
function streamPartsFromContent(content) {
  const parts = [];
  for (const part of content ?? []) {
    if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool")
      continue;
    const start = part.time?.created;
    if (typeof start !== "number")
      continue;
    parts.push({ type: part.type, time: { start } });
  }
  return parts;
}

// src/v2/adapter.ts
function createV2Api(ctx) {
  const location = ctx.location ?? { directory: "" };
  const listeners = new Map;
  const parts = new Map;
  const toolStarts = new Map;
  const synced = new Set;
  const disposers = [];
  const emit = (name, event) => {
    for (const handler of listeners.get(name) ?? [])
      handler(event);
  };
  const on = (name, handler) => {
    const set = listeners.get(name) ?? new Set;
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  };
  const rememberParts = (messageID, next) => {
    if (!messageID || next.length === 0)
      return;
    const existing = parts.get(messageID) ?? [];
    parts.set(messageID, [...existing, ...next]);
  };
  const messageIDOf = (event) => event.data?.assistantMessageID ?? event.data?.messageID ?? "";
  const ensureMessages = (sessionID) => {
    if (!sessionID || synced.has(sessionID))
      return;
    synced.add(sessionID);
    ctx.data.session.message.sync(sessionID).catch(() => synced.delete(sessionID));
  };
  ctx.data.location.provider.sync(location).catch(() => {});
  ctx.data.location.model.sync(location).catch(() => {});
  const subscribe = (type, handler) => {
    disposers.push(ctx.data.on(type, handler));
  };
  const emitPart = (type, event) => {
    const messageID = messageIDOf(event);
    if (!messageID)
      return;
    const start = event.created;
    const part = { type, time: typeof start === "number" ? { start } : undefined };
    if (typeof start === "number")
      rememberParts(messageID, [part]);
    emit("message.part.updated", { properties: { part: { ...part, messageID } } });
  };
  subscribe("session.usage.updated", () => emit("message.updated", { properties: {} }));
  subscribe("session.message.content.updated", (event) => {
    const sessionID = event.data?.sessionID ?? "";
    const messageID = event.data?.messageID ?? "";
    rememberParts(messageID, streamPartsFromContent(event.data?.content));
    const row = messageID ? ctx.data.session.message.get(sessionID, messageID) : undefined;
    if (!row)
      return;
    emit("message.updated", { properties: { info: toAssistantMessage(row, sessionID) } });
  });
  subscribe("session.text.started", (event) => emitPart("text", event));
  subscribe("session.reasoning.started", (event) => emitPart("reasoning", event));
  subscribe("session.tool.input.started", (event) => {
    const messageID = event.data?.assistantMessageID ?? "";
    const callID = String(event.data?.id ?? "");
    if (!messageID || !callID)
      return;
    const name = String(event.data?.name ?? "");
    const start = event.created;
    toolStarts.set(callID, { messageID, name, start });
    if (typeof start === "number")
      rememberParts(messageID, [{ type: "tool", time: { start } }]);
    emit("message.part.updated", {
      properties: { part: { type: "tool", messageID, callID, tool: name, state: { status: "running", time: { start } } } }
    });
  });
  const finishTool = (status) => (event) => {
    const callID = String(event.data?.id ?? "");
    const known = toolStarts.get(callID);
    const messageID = event.data?.assistantMessageID ?? known?.messageID ?? "";
    if (!messageID || !callID)
      return;
    emit("message.part.updated", {
      properties: {
        part: {
          type: "tool",
          messageID,
          callID,
          tool: known?.name ?? "",
          state: { status, time: { start: known?.start, end: event.created } }
        }
      }
    });
  };
  subscribe("session.tool.success", finishTool("completed"));
  subscribe("session.tool.failed", finishTool("error"));
  subscribe("session.text.delta", (event) => {
    const messageID = messageIDOf(event);
    if (messageID)
      emit("message.part.delta", { properties: { messageID, field: "text" } });
  });
  subscribe("session.reasoning.delta", (event) => {
    const messageID = messageIDOf(event);
    if (messageID)
      emit("message.part.delta", { properties: { messageID, field: "reasoning" } });
  });
  const messagesOf = (sessionID) => {
    const rows = ctx.data.session.message.list(sessionID);
    if (rows.length === 0)
      ensureMessages(sessionID);
    return rows.map((row) => toAssistantMessage(row, sessionID));
  };
  const api = {
    state: {
      path: { directory: location.directory },
      get provider() {
        return toProviderInfos(ctx.data.location.provider.list(location), ctx.data.location.model.list(location));
      },
      session: {
        messages: messagesOf,
        get: (id) => toSessionObject(ctx.data.session.get(id))
      },
      part: (messageID) => parts.get(messageID)
    },
    client: {
      session: {
        list: async () => {
          await ctx.data.session.sync().catch(() => {});
          return ctx.data.session.list().map((session) => ({
            ...session,
            parentID: session.parentID
          }));
        },
        messages: async (opts) => {
          const list = ctx.client?.message?.list;
          if (list) {
            try {
              const response = await list({
                sessionID: opts.path.id,
                limit: opts.query.limit,
                order: "desc"
              });
              return {
                data: (response?.data ?? []).slice().reverse().map((row) => ({ info: toAssistantMessage(row, opts.path.id) }))
              };
            } catch {
              ensureMessages(opts.path.id);
              return { data: messagesOf(opts.path.id).map((info) => ({ info })) };
            }
          }
          ensureMessages(opts.path.id);
          return { data: messagesOf(opts.path.id).map((info) => ({ info })) };
        }
      }
    },
    event: { on }
  };
  return {
    ...api,
    dispose: () => {
      for (const dispose of disposers)
        dispose();
      disposers.length = 0;
      listeners.clear();
    }
  };
}

// src/plugin.tsx
var PLUGIN_ID = "cache-hit-bar";
function resolveMutedFg(theme) {
  const v = toThemeRecord(theme).textMuted;
  if (typeof v === "string")
    return v.length > 0 ? v : undefined;
  if (v !== null && typeof v === "object")
    return v;
  return;
}
function resolveBaseFg(theme) {
  const v = toThemeRecord(theme).text;
  if (typeof v === "string")
    return v.length > 0 ? v : undefined;
  if (v !== null && typeof v === "object")
    return v;
  return;
}
function bar(api, sessionId, muted, dialog, base, hover) {
  return _$createComponent2(CacheHitBarHost, {
    sessionId,
    api,
    muted,
    dialog,
    base,
    get hovered() {
      return hover?.hovered;
    },
    get onMouseOver() {
      return hover?.onMouseOver;
    },
    get onMouseOut() {
      return hover?.onMouseOut;
    }
  });
}
var tui = async (api) => {
  let currentSessionId = "";
  api.event.on("message.updated", (event) => {
    const sid = event.properties?.info?.sessionID;
    if (sid)
      currentSessionId = sid;
  });
  api.slots.register({
    order: 57,
    slots: {
      app_bottom() {
        return bar(api, currentSessionId);
      }
    }
  });
};
var setup = (ctx) => {
  const api = createV2Api(ctx);
  const muted = resolveMutedFg(ctx.theme);
  const base = resolveBaseFg(ctx.theme);
  const dialog = ctx.ui.dialog;
  const unregister = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => bar(api, input.sessionID ?? "", muted, dialog, base, input)
  });
  return () => {
    unregister?.();
    api.dispose();
  };
};
var plugin = {
  id: PLUGIN_ID,
  tui,
  setup
};
var plugin_default = plugin;
export {
  plugin_default as default
};
