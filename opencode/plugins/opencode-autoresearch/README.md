# opencode-autoresearch

V2 (`Plugin.define`) port of [Maleick/AutoResearch v3.14.2](https://github.com/Maleick/AutoResearch)
(adapt-in-place over the moedesux/pi-autoresearch V2 base — V1 shape was
`export async function server()` + `export default {id,server}` in `src/index.ts`,
no `Plugin.define`/`@opencode/plugin`).

## What was installed (and where)

| This plugin | Upstream source |
|---|---|
| `plugins/opencode-autoresearch/index.js` | `plugins/autoresearch-context.ts` (V1 `experimental.chat.system.transform` → V2 `session.hook("context")`; injection text byte-identical) |
| `plugins/opencode-autoresearch/index.js` `prompt` hook | `before_agent_start` equivalent — V2 `SessionHooks` has no such hook; `prompt` fires per inbound message before the agent loop and rolls a `autoresearch.jsonl` backup (keep 5, never throws) |
| `commands/autoresearch.md` | upstream `commands/autoresearch.md` + added `on` + `export` sections (upstream only had `off`/`dashboard`/resume/fresh-start) |
| `scripts/backup-state.sh` | byte-identical copy of upstream `scripts/backup-state.sh` |
| `scripts/backup-state.ps1` | PowerShell port of the above (opencode shell on Windows is pwsh) |
| `skills/autoresearch/SKILL.md` | already installed globally (479 lines, pre-existing) |

Dual layout: flat (`autoresearch.md` in cwd, moedesux style) checked first,
then legacy `.auto/autoresearch.md` (pi-autoresearch `paths.ts` style).
`.autoresearch-off` sentinel pauses both injection and auto-backup.

## Install

Auto-loaded via the `plugins/` directory scanner — no `opencode.json` change
needed (the 4 remote `plugins[]` entries are untouched). After copying files:

```powershell
cd $env:USERPROFILE\.config\opencode\plugins\opencode-autoresearch
npm install --no-audit --no-fund   # resolves @opencode/plugin (peer dep)
opencode plugin list               # expect: opencode-autoresearch 1.0.0, no -/-
```

## Uninstall

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.config\opencode\plugins\opencode-autoresearch
Remove-Item -Force $env:USERPROFILE\.config\opencode\commands\autoresearch.md
Remove-Item -Force $env:USERPROFILE\.config\opencode\scripts\backup-state.sh,
  $env:USERPROFILE\.config\opencode\scripts\backup-state.ps1
# skills/autoresearch/SKILL.md is shared — remove only if nothing else uses it
```

## Use

`/autoresearch <goal>` fresh start · `/autoresearch` resume ·
`/autoresearch on|off` resume/pause · `/autoresearch dashboard` rebuild
dashboard · `/autoresearch export` write `autoresearch-export.md` handoff.

## V1 → V2 API mapping (exact)

- `import type {Plugin} from "@opencode-ai/plugin"` → `import {Plugin} from "@opencode/plugin"`, `export default Plugin.define({id, setup})`
- `experimental.chat.system.transform` w/ `{directory}` → `ctx.session.hook("context", e => e.system.push({type:"text",text}))`; dir via `ctx.session.get({sessionID})` → `Session.Info.location.directory`
- `before_agent_start` → no v2 equivalent; `session.hook("prompt")` used instead
- Slash commands are NOT plugin-registrable in v2 → markdown files in `commands/`
