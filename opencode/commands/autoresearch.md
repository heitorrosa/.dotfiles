---
description: Start or resume autoresearch experiment loop (Maleick v3.14.2 + moedesux base; submodes plan/debug/fix/learn/predict/scenario/security/ship/digest; args on|off|dashboard|export)
---

# Autoresearch Command

You are starting or resuming an autonomous experiment loop.

## Activation (Maleick v3.14.2 subagent-first)

1. Read `skills/autoresearch/references/loop-workflow.md`
2. Read `skills/autoresearch/references/core-principles.md`
3. Read `skills/autoresearch/references/state-management.md`
4. Read `skills/autoresearch/references/results-logging.md`
5. For interactive setup, read `skills/autoresearch/references/interaction-wizard.md`

## Submodes

- `/autoresearch:plan`, `:debug`, `:fix`, `:learn`, `:predict`, `:scenario`, `:security`, `:ship` — read the matching `skills/autoresearch/references/<mode>-workflow.md` then execute.
- `/autoresearch:digest` — re-entry digest for operator handoff (`--json` for machine-readable).
- Managed state: `.autoresearch/state.json` + `.autoresearch/goal.md` (constants.ts STATE_DEFAULT/GOAL_DEFAULT); hooks `init.sh`/`status.sh`/`stop.sh` map to context/digest/manual-stop in `plugins/opencode-autoresearch/index.js`.

## Handle arguments

Arguments: $ARGUMENTS

### If arguments = "off"

Create a `.autoresearch-off` sentinel file in the current directory:
```bash
touch .autoresearch-off
```
Then tell the user autoresearch mode is paused. It can be resumed by running `/autoresearch` again (which will delete the sentinel).

### If arguments = "dashboard"

Regenerate `autoresearch-dashboard.md` based on the current state:

1. Read `autoresearch.jsonl` to get all experiment results
2. Count total runs, kept, discarded, crashed
3. Find baseline metric (first result after config header)
4. Find best metric and which run achieved it
5. Calculate delta percentages vs baseline
6. Generate dashboard markdown with:
   - Title: `# Autoresearch Dashboard: <name from config>`
   - Summary line with counts
   - Baseline and best values
   - Table of ALL runs in current segment with commit, metric, status, description
7. Write the dashboard to `autoresearch-dashboard.md` in the current directory using the Write tool
8. Confirm to the user that the dashboard has been saved to disk

Include dashboard generation instructions from the SKILL.md (lines 198-217):

```markdown
# Autoresearch Dashboard: <name>

**Runs:** 12 | **Kept:** 8 | **Discarded:** 3 | **Crashed:** 1
**Baseline:** <metric_name>: <value><unit> (#1)
**Best:** <metric_name>: <value><unit> (#8, -26.2%)

| # | commit | <metric_name> | status | description |
|---|--------|---------------|--------|-------------|
| 1 | abc1234 | 42.3s | keep | baseline |
| 2 | def5678 | 40.1s (-5.2%) | keep | optimize hot loop |
| 3 | abc1234 | 43.0s (+1.7%) | discard | try vectorization |
...
```

Include delta percentages vs baseline for each metric value. Show ALL runs in the current segment (not just recent ones).

### If arguments = "on"

Resume a paused loop: delete `.autoresearch-off` if it exists, then follow the
resume steps above (read goal + jsonl state + git log, continue the loop).

### If arguments = "export"

Write a portable handoff file `autoresearch-export.md` in the current directory:

1. Read `autoresearch.md` (goal, constraints), `autoresearch.jsonl` (all runs),
   and `experiments/worklog.md` (key insights) if they exist
2. Write `autoresearch-export.md` with: goal statement, best config + commit,
   baseline vs best metric with delta %, full run table (same shape as the
   dashboard), and top insights/learnings from the worklog
3. Confirm the export path to the user

### If `autoresearch.md` exists in the current directory (resume)

This is a resume. Do the following:

1. Delete `.autoresearch-off` if it exists
2. Read `autoresearch.md` to understand the objective, constraints, and what's been tried
3. Read `autoresearch.jsonl` to reconstruct state:
   - Count total runs, kept, discarded, crashed
   - Find baseline metric (first result in current segment)
   - Find best metric and which run achieved it
   - Identify which secondary metrics are being tracked
4. Read recent git log: `git log --oneline -20`
5. If `autoresearch.ideas.md` exists, read it for experiment inspiration
6. Continue the loop from where it left off — pick up the next experiment

### If `autoresearch.md` does NOT exist (fresh start)

1. Delete `.autoresearch-off` if it exists
2. Invoke the `autoresearch` skill to set up the experiment from scratch
3. If arguments were provided (other than "off"), use them as the goal description to skip/answer the setup questions
