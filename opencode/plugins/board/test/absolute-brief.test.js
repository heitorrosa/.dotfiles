// Self-check for copyAbsoluteBrief: board-state briefs are absolute paths and
// must copy into the worktree without escaping it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyAbsoluteBrief } from "../src/admission.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "board-brief-"));
try {
  const worktree = path.join(tmp, "wt");
  const brief = path.join(tmp, "state", "briefs", "swarm", "t1.md");
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, "hello brief\n", "utf8");

  const rel = ".opencode/swarm/briefs/swarm/t1.md";
  const ok = copyAbsoluteBrief(brief, worktree, rel);
  assert.equal(ok.copied, true);
  assert.equal(ok.dest, path.resolve(worktree, rel));
  assert.equal(fs.readFileSync(ok.dest, "utf8"), "hello brief\n");

  const escape = copyAbsoluteBrief(brief, worktree, "../outside.md");
  assert.equal(escape.copied, false);
  assert.match(escape.reason, /escapes worktree/);

  const missing = copyAbsoluteBrief(path.join(tmp, "nope.md"), worktree, rel);
  assert.equal(missing.copied, false);
  assert.equal(missing.missing, true);

  console.log("copyAbsoluteBrief: copy / escape / missing cases pass");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
