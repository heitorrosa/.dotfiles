// read-shell — read-only shell for the router agent.
//
// One tool, read_shell({command, workdir?, timeout_ms?}). The command must
// match the allowlist in ./allowlist.js; anything else is rejected before a
// process exists. For PowerShell the -Command string is rebuilt from the
// validated argv (single-quoted args), so the parser is the execution
// boundary. Native binaries run through spawn(shell:false) with an argv array.
//
// The router keeps permission "shell: deny". This plugin asserts its own
// permission, action "read_shell", before running anything.
import { Plugin } from "@opencode/plugin"
import {
  runReadShell,
  prepareReadShell,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
} from "./allowlist.js"

const DESCRIPTION =
  "Run one read-only command and return JSON {ok, exit_code, stdout, stderr, truncated}." +
  " Allowed verbs only: Get-ChildItem, Get-Item, Get-Content, Select-String, Test-Path," +
  " Measure-Object, rg, node --check <file>, and git status|diff|log|show|branch|rev-parse|" +
  "ls-files|grep (read flags only). Rejected: ; && || | > >> < backticks $() and write verbs." +
  " No shell is involved. Output capped at 32 KiB, timeout capped at 30000 ms."

export default Plugin.define({
  id: "read-shell",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "read_shell",
        description: DESCRIPTION,
        input: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Single read-only command, no pipes, no redirects, no chaining",
            },
            workdir: {
              type: "string",
              description: "Absolute or session-relative working directory; defaults to the session directory",
            },
            timeout_ms: {
              type: "integer",
              description: `Timeout in milliseconds, clamped to 100..${MAX_TIMEOUT_MS}`,
              minimum: 1,
              maximum: MAX_TIMEOUT_MS,
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const command = String((args && args.command) ?? "")
          // Resolve the session directory and assert permission first. A
          // permission deny rejects here (Tool.Error) and is not swallowed.
          const gate = await prepareReadShell(ctx, args, context)
          if (!gate.ok) {
            return {
              content: JSON.stringify({ ok: false, error: gate.error, command }, null, 2),
            }
          }
          const result = await runReadShell(
            {
              command: args && args.command,
              workdir: args && args.workdir,
              timeout_ms: args && args.timeout_ms,
            },
            { baseDir: gate.baseDir, maxOutputBytes: MAX_OUTPUT_BYTES },
          )
          return { content: JSON.stringify(result, null, 2) }
        },
      })
    })
  },
})
