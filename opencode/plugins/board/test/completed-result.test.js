// Self-check for completedResult: distinguishes a finished foreground subagent
// result from background/live results that must stay "running".
//
// admission.js imports ./tools.js, which this worktree's stale base lacks, so
// the helper is loaded from the module source with its imports stripped.
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs
  .readFileSync(new URL("../src/admission.js", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/^export \{.*$/gm, "");
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { completedResult } = mod;

const done = [
  { state: "completed" },
  { nested: { state: "completed", sessionID: "ses_x" } },
  '{"state":"completed","sessionID":"ses_x"}',
  'state="completed" sessions: ses_x',
  "ok state=completed",
  [{ content: [{ type: "text", text: 'result state="completed"' }] }],
  // JSON.stringify fallback sees state through toJSON where the walk cannot.
  { toJSON: () => ({ state: "completed" }) },
];
for (const value of done) assert.equal(completedResult(value), true, JSON.stringify(value));

const running = [
  undefined,
  null,
  { state: "running" },
  { state: "background" },
  '{"state":"running"}',
  "state=background",
  '{"status":"completed"}',
  "completed",
  { text: "all state values are listed" },
];
for (const value of running) assert.equal(completedResult(value), false, JSON.stringify(value));

console.log("completedResult: 6 true / 9 false cases pass");
