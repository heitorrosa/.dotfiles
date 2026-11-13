// read-shell/allowlist.js — policy + executor for the read_shell tool.
//
// Pure Node builtins, no @opencode/plugin import, so tests can import this
// module directly. The policy is an allowlist of verbs plus a rejection pass
// for shell metacharacters. A validated command is handed to pwsh with
// -Command, or to a native binary directly, always through spawn(shell:false)
// with an argument array. There is no shell in the loop and no string
// concatenation of user data into a command line.
import { spawn as nodeSpawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path from "node:path"

export const DEFAULT_TIMEOUT_MS = 10000
export const MIN_TIMEOUT_MS = 100
export const MAX_TIMEOUT_MS = 30000
export const MAX_OUTPUT_BYTES = 32 * 1024
export const MAX_COMMAND_CHARS = 4000

// PowerShell cmdlets that only read.
const PS_VERBS = new Set([
  "get-childitem",
  "get-item",
  "get-content",
  "select-string",
  "test-path",
  "measure-object",
])

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "grep",
])

// git branch flags that mutate refs.
const GIT_BRANCH_WRITE = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
])

// git branch flags that only query.
const GIT_BRANCH_READ = new Set([
  "-l",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--show-current",
  "--format",
  "--sort",
  "-i",
  "--ignore-case",
  "-q",
  "--quiet",
  "--column",
])

// Destructive or side-effecting commands, rejected wherever they appear as a
// standalone token. Defense in depth: the verb allowlist already blocks them.
const WRITE_VERBS = new Set([
  "out-file",
  "set-content",
  "add-content",
  "clear-content",
  "set-item",
  "set-itemproperty",
  "new-item",
  "remove-item",
  "move-item",
  "copy-item",
  "rename-item",
  "export-csv",
  "export-clixml",
  "start-process",
  "start-job",
  "invoke-expression",
  "invoke-command",
  "invoke-webrequest",
  "invoke-restmethod",
  "stop-process",
  "remove-variable",
  "set-variable",
  "new-variable",
  "tee-object",
  "curl",
  "wget",
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
  "mkdir",
  "touch",
  "sed",
  "tee",
  "chmod",
  "chown",
])

// Ordered longest first so the reported reason is the real cause.
const SHELL_METACHARACTERS = [
  ["&&", "&&"],
  ["||", "||"],
  [">>", ">>"],
  ["$(", "$("],
  ["\r", "carriage return"],
  ["\n", "newline"],
  ["\0", "NUL"],
  [";", ";"],
  [">", ">"],
  ["<", "<"],
  ["`", "backtick"],
  ["|", "|"],
  ["&", "&"],
]

// Characters that, in a PowerShell argument, could be re-parsed as a
// subexpression, array, splat, statement separator or redirection.
const PS_ARG_FORBIDDEN = /[(){}[\],@`;|&><$\r\n]/

// Splits a command line into argv without a shell. Single and double quotes
// group, a backslash escapes a double quote inside double quotes, and every
// other character is literal. No globbing, no variable expansion.
export function splitCommand(command) {
  const out = []
  let cur = ""
  let quote = null
  let has = false
  const raw = String(command ?? "")
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === "\\" && quote === '"' && raw[i + 1] === '"') {
        cur += '"'
        i++
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (ch === " " || ch === "\t") {
      if (has) {
        out.push(cur)
        cur = ""
        has = false
      }
      continue
    }
    cur += ch
    has = true
  }
  if (quote) return { ok: false, reason: "unbalanced quote in command" }
  if (has) out.push(cur)
  return { ok: true, argv: out }
}

export function findForbiddenSequence(command) {
  const raw = String(command ?? "")
  for (const [needle, label] of SHELL_METACHARACTERS) {
    if (raw.includes(needle)) return label
  }
  return null
}

// Validates one command string. Returns { ok, argv, verb, kind, cwdIndex? }
// or { ok:false, reason }. kind is "pwsh" | "rg" | "git" | "node".
export function validateCommand(command) {
  const raw = String(command ?? "").trim()
  if (!raw) return { ok: false, reason: "command is required" }
  if (raw.length > MAX_COMMAND_CHARS) {
    return { ok: false, reason: `command too long (max ${MAX_COMMAND_CHARS} chars)` }
  }
  const bad = findForbiddenSequence(raw)
  if (bad) return { ok: false, reason: `rejected shell metacharacter: ${bad}` }

  const split = splitCommand(raw)
  if (!split.ok) return split
  const argv = split.argv
  if (!argv.length) return { ok: false, reason: "command is required" }

  for (const token of argv) {
    if (WRITE_VERBS.has(token.toLowerCase())) {
      return { ok: false, reason: `write verb not allowed: ${token}` }
    }
  }

  const head = argv[0].toLowerCase()

  if (PS_VERBS.has(head)) {
    for (const token of argv) {
      if (PS_ARG_FORBIDDEN.test(token)) {
        return { ok: false, reason: `rejected PowerShell metacharacter in argument: ${token}` }
      }
    }
    return { ok: true, argv, verb: head, kind: "pwsh" }
  }

  if (head === "rg") {
    for (const arg of argv.slice(1)) {
      const l = arg.toLowerCase()
      if (l === "--pre" || l.startsWith("--pre=")) {
        return { ok: false, reason: "rg --pre spawns a command" }
      }
      if (l === "--hostname-bin" || l.startsWith("--hostname-bin=")) {
        return { ok: false, reason: "rg --hostname-bin spawns a command" }
      }
    }
    return { ok: true, argv, verb: "rg", kind: "rg" }
  }

  if (head === "node") {
    if (argv.length !== 3 || argv[1] !== "--check") {
      return { ok: false, reason: "node is allowed only as: node --check <file>" }
    }
    if (argv[2].startsWith("-")) return { ok: false, reason: "node --check needs a file path" }
    return { ok: true, argv, verb: "node", kind: "node" }
  }

  if (head === "git") {
    let i = 1
    if (argv[1] && argv[1].toLowerCase() === "--no-pager") i = 2
    const sub = (argv[i] || "").toLowerCase()
    if (!sub) return { ok: false, reason: "git needs a read subcommand" }
    if (sub.startsWith("-")) {
      return { ok: false, reason: `git global option not allowed before the subcommand: ${argv[i]}` }
    }
    if (!GIT_READ_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `git subcommand not allowed: ${sub}` }
    }
    const rest = argv.slice(i + 1)
    for (const arg of rest) {
      const l = arg.toLowerCase()
      if (l === "--output" || l.startsWith("--output=")) {
        return { ok: false, reason: "git --output writes a file" }
      }
      if (l === "--ext-diff") return { ok: false, reason: "git --ext-diff runs an external command" }
    }
    if (sub === "branch") {
      for (const arg of rest) {
        if (GIT_BRANCH_WRITE.has(arg)) {
          return { ok: false, reason: `git branch flag mutates refs: ${arg}` }
        }
      }
      const hasPositional = rest.some((arg) => !arg.startsWith("-"))
      const hasReadFlag = rest.some((arg) => GIT_BRANCH_READ.has(arg.split("=")[0]))
      if (hasPositional && !hasReadFlag) {
        return { ok: false, reason: "git branch with a name creates a branch; only read flags are allowed" }
      }
    }
    return { ok: true, argv, verb: `git ${sub}`, kind: "git", sub }
  }

  return { ok: false, reason: `verb not in allowlist: ${argv[0]}` }
}

export function clampTimeout(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)))
}

// Resolves and checks the working directory. Missing workdir falls back to
// baseDir, which the tool sets from the session directory.
export function resolveWorkdir(workdir, baseDir) {
  const fallback = baseDir || process.cwd()
  if (workdir == null) return { ok: true, cwd: fallback }
  const s = String(workdir).trim()
  if (!s) return { ok: true, cwd: fallback }
  if (s.includes("\0")) return { ok: false, reason: "invalid workdir" }
  const abs = path.isAbsolute(s) ? path.normalize(s) : path.resolve(fallback, s)
  try {
    if (!existsSync(abs)) return { ok: false, reason: `workdir does not exist: ${abs}` }
    if (!statSync(abs).isDirectory()) return { ok: false, reason: `workdir is not a directory: ${abs}` }
  } catch (e) {
    return { ok: false, reason: `workdir unusable: ${String((e && e.message) || e)}` }
  }
  return { ok: true, cwd: abs }
}

function cutUtf8(buf, n) {
  if (n <= 0) return ""
  return buf.subarray(0, n).toString("utf8").replace(/\uFFFD+$/, "")
}

// PowerShell emits SGR colour codes on stderr even when piped. Strip them so
// the tool result stays readable and JSON-safe.
export function stripAnsi(text) {
  return String(text ?? "").replace(/\u001B\[[0-9;]*[A-Za-z]/g, "")
}

export function capOutput(text, max = MAX_OUTPUT_BYTES) {
  const buf = Buffer.from(String(text ?? ""), "utf8")
  if (buf.length <= max) return { text: buf.toString("utf8"), truncated: false }
  return { text: cutUtf8(buf, max), truncated: true }
}

// Caps stdout+stderr together at max bytes. stdout has priority; stderr gets
// whatever budget is left. Never returns more than max bytes of text.
export function capCombined(stdout, stderr, max = MAX_OUTPUT_BYTES) {
  const outBuf = Buffer.from(String(stdout ?? ""), "utf8")
  const errBuf = Buffer.from(String(stderr ?? ""), "utf8")
  if (outBuf.length + errBuf.length <= max) {
    return { stdout: outBuf.toString("utf8"), stderr: errBuf.toString("utf8"), truncated: false }
  }
  const outTake = Math.min(outBuf.length, max)
  const errTake = Math.min(errBuf.length, Math.max(0, max - outTake))
  return {
    stdout: cutUtf8(outBuf, outTake),
    stderr: cutUtf8(errBuf, errTake),
    truncated: outTake < outBuf.length || errTake < errBuf.length,
  }
}

// Single-quotes one PowerShell argument. PowerShell escapes a literal quote by
// doubling it, so the rebuilt script can never break out of its quotes.
export function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// Rebuilds the -Command payload from the already-validated argv. The parser is
// therefore the execution boundary: nothing the user typed is passed through
// raw, and the verb must be on the allowlist again here.
export function buildPowerShellScript(argv) {
  const list = Array.isArray(argv) ? argv : []
  if (!list.length) throw new Error("cannot build a PowerShell script from an empty argv")
  if (!PS_VERBS.has(String(list[0]).toLowerCase())) {
    throw new Error(`verb not in allowlist: ${list[0]}`)
  }
  return "& " + list.map(psQuote).join(" ")
}

// Cached pwsh-vs-powershell.exe decision. Probing is existence-only, so exactly
// one interpreter is ever launched; the fallback relies on PATH.
let shellDecision = null

export function resetShellCache() {
  shellDecision = null
}

export function resolvePowerShell(opts = {}) {
  if (opts.shellPath) return opts.shellPath
  if (shellDecision) return shellDecision
  const exists = typeof opts.exists === "function" ? opts.exists : existsSync
  const env = opts.env || process.env
  const platform = opts.platform || process.platform
  if (env.READ_SHELL_PWSH) {
    shellDecision = env.READ_SHELL_PWSH
    return shellDecision
  }
  const candidates = []
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files"
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    const root = env.SystemRoot || "C:\\Windows"
    candidates.push(
      path.join(pf, "PowerShell", "7", "pwsh.exe"),
      path.join(pf, "PowerShell", "6", "pwsh.exe"),
      path.join(pf86, "PowerShell", "7", "pwsh.exe"),
      path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    )
  } else {
    candidates.push("/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh")
  }
  for (const candidate of candidates) {
    if (exists(candidate)) {
      shellDecision = candidate
      return shellDecision
    }
  }
  shellDecision = platform === "win32" ? "powershell.exe" : "pwsh"
  return shellDecision
}

// Builds the spawn call. PowerShell cmdlets run the rebuilt script as ONE argv
// element after -Command. Native binaries keep their parsed argument array.
export function buildSpawnSpec(parsed, cwd, opts = {}) {
  if (parsed.kind === "pwsh") {
    const script = buildPowerShellScript(parsed.argv)
    return {
      file: resolvePowerShell(opts),
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      cwd,
      script,
    }
  }
  const file = parsed.kind === "node" ? process.env.READ_SHELL_NODE || "node" : parsed.argv[0]
  return { file, args: parsed.argv.slice(1), cwd }
}

// Resolves the session directory through the V2 session API. A failure is a
// refusal: the caller must never fall back to the server cwd.
export async function resolveSessionDirectory(ctx, sessionID) {
  if (!sessionID) return { ok: false, reason: "session id is required" }
  const api = ctx && ctx.session
  if (!api || typeof api.get !== "function") {
    return { ok: false, reason: "session API unavailable; cannot resolve the working directory" }
  }
  try {
    const session = await api.get({ sessionID })
    // The host may wrap the payload as {data: ...}; unwrap before reading.
    const s = session?.data ?? session
    // Probe the known V2 shapes in order.
    const directory =
      s?.directory ??
      s?.location?.directory ??
      s?.info?.location?.directory ??
      s?.info?.directory
    if (!directory) {
      const keys = s && typeof s === "object" ? Object.keys(s).join(",") : "none"
      return { ok: false, reason: `session has no directory (keys: ${keys})` }
    }
    return { ok: true, directory }
  } catch (e) {
    return { ok: false, reason: `session lookup failed: ${String((e && e.message) || e)}` }
  }
}

// V2 shape: { sessionID, action, resources }. assert() resolves on allow and
// rejects with a Tool.Error on deny; the rejection is deliberately not caught
// so a deny can never be turned into a successful tool result.
export async function assertReadShellPermission(ctx, { sessionID, resource } = {}) {
  const api = ctx && ctx.permission
  if (!api || typeof api.assert !== "function") return { ok: true, skipped: true }
  await api.assert({
    sessionID,
    action: "read_shell",
    resources: [String(resource || "*")],
  })
  return { ok: true }
}

// Full pre-spawn gate: session directory first, then permission. Returns
// { ok:true, baseDir } or { ok:false, error }. A permission deny throws.
export async function prepareReadShell(ctx, args, context) {
  const sessionID = context && context.sessionID
  const dir = await resolveSessionDirectory(ctx, sessionID)
  if (!dir.ok) return { ok: false, error: dir.reason }
  await assertReadShellPermission(ctx, { sessionID, resource: dir.directory })
  return { ok: true, baseDir: dir.directory }
}

export async function runReadShell(input = {}, opts = {}) {
  const started = Date.now()
  const command = String((input && input.command) ?? "").trim()
  const parsed = validateCommand(command)
  if (!parsed.ok) return { ok: false, command, error: parsed.reason }

  const wd = resolveWorkdir(input && input.workdir, opts.baseDir)
  if (!wd.ok) return { ok: false, command, error: wd.reason }

  const timeout_ms = clampTimeout(input && input.timeout_ms)
  const spec = buildSpawnSpec(parsed, wd.cwd, { shellPath: opts.shellPath, exists: opts.exists })
  const spawnFn = typeof opts.spawn === "function" ? opts.spawn : nodeSpawn
  const maxBytes = Number.isFinite(opts.maxOutputBytes) ? opts.maxOutputBytes : MAX_OUTPUT_BYTES

  const result = await new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (exitCode, signal, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const capped = capCombined(stripAnsi(stdout), stripAnsi(stderr), maxBytes)
      resolve({
        ok: !error,
        command,
        verb: parsed.verb,
        argv: parsed.argv,
        spawn: { file: spec.file, args: spec.args, shell: false },
        cwd: wd.cwd,
        timeout_ms,
        exit_code: typeof exitCode === "number" ? exitCode : null,
        signal: signal || null,
        timed_out: timedOut,
        stdout: capped.stdout,
        stderr: capped.stderr,
        truncated: capped.truncated || timedOut,
        duration_ms: Date.now() - started,
        error: error ? String((error && error.message) || error) : null,
      })
    }

    let child
    try {
      child = spawnFn(spec.file, spec.args, {
        cwd: wd.cwd,
        shell: false,
        windowsHide: true,
        timeout: timeout_ms,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      })
    } catch (e) {
      finish(null, null, e)
      return
    }
    if (!child || typeof child.on !== "function") {
      finish(null, null, new Error("spawn returned no process"))
      return
    }

    if (child.stdout && typeof child.stdout.on === "function") {
      if (typeof child.stdout.setEncoding === "function") child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        if (stdout.length < maxBytes * 2) stdout += String(chunk)
      })
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      if (typeof child.stderr.setEncoding === "function") child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => {
        if (stderr.length < maxBytes * 2) stderr += String(chunk)
      })
    }
    child.on("error", (e) => finish(null, null, e))
    child.on("close", (code, signal) => finish(code, signal, null))

    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {}
    }, timeout_ms)
    if (timer && typeof timer.unref === "function") timer.unref()
  })

  return result
}
