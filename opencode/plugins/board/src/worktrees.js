// Thin wrapper over the host's ctx.worktree surface so it can be faked in
// tests. ESM, Node built-ins only.
//
// The runtime validates the generated client endpoints, so these shapes win
// over @opencode/plugin's d.ts:
//   create({ projectID, from?, branch?, directory?, name? }) -> { directory }
//   remove({ projectID, directory, force }) -> void
//   list({ projectID }) -> { directory, type }[]
//
// The shadow backend keeps a sidecar bare repo so a task can have an isolated
// checkout without creating a worktree in the host repo or a `.git` in the
// canonical directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Pathspec excludes keep the shadow base free of generated/local state.
const SHADOW_EXCLUDES = [
  "node_modules",
  ".cache",
  "*.log",
  "auth.json",
  ".env",
  "board",
  "backups",
  ".local",
  ".git",
];

function excludePathspecs() {
  return SHADOW_EXCLUDES.flatMap((name) => [
    `:(exclude,glob)${name}`,
    `:(exclude,glob)**/${name}`,
    `:(exclude,glob)**/${name}/**`,
  ]);
}

async function git(shadowDir, workTree, args) {
  const base = [`--git-dir=${shadowDir}`];
  if (workTree) base.push(`--work-tree=${workTree}`);
  return run("git", [...base, ...args], {
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function directoryOf(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (typeof result.directory === "string") return result.directory;
  if (result.data && typeof result.data.directory === "string") {
    return result.data.directory;
  }
  return null;
}

export function createWorktrees(ctx, config = {}) {
  const projectID = config.project_id || (ctx && ctx.location && ctx.location.project && ctx.location.project.id);
  if (!projectID) throw new Error("worktree: projectID unavailable");

  function requireSurface() {
    if (!ctx || !ctx.worktree) {
      throw new Error("ctx.worktree is not available");
    }
    return ctx.worktree;
  }

  function shadowDir() {
    const boardDir =
      config.board_dir || process.env.OPENCODE_BOARD_DIR || path.join(os.homedir(), ".local", "share", "opencode", "board");
    return path.join(boardDir, "shadow", `${projectID}.git`);
  }

  return {
    async create(name, from) {
      const surface = requireSurface();
      const args = {
        projectID,
        name: String(name),
      };
      const base = from ?? config.worktree_base;
      if (base !== undefined && base !== null) args.from = base;
      const result = await surface.create(args);
      return { directory: directoryOf(result) };
    },

    async remove(directory, force = false) {
      const surface = requireSurface();
      return surface.remove({ projectID, directory, force: Boolean(force) });
    },

    async list() {
      const surface = requireSurface();
      return surface.list({ projectID });
    },

    async createShadow(name, { canonicalDir, directory } = {}) {
      const source = path.resolve(canonicalDir || config.canonical_dir || config.checkout || process.cwd());
      const shadow = shadowDir();
      fs.mkdirSync(path.dirname(shadow), { recursive: true });
      if (!fs.existsSync(shadow)) {
        await run("git", ["init", "--bare", shadow], { shell: false, windowsHide: true });
      }
      for (const args of [
        ["config", "user.name", "board-shadow"],
        ["config", "user.email", "board-shadow@localhost"],
      ]) {
        try {
          await git(shadow, null, args);
        } catch {
          /* identity is best-effort; commit falls back to host config */
        }
      }

      let base;
      try {
        const head = await git(shadow, null, ["rev-parse", "--verify", "HEAD"]);
        base = String(head.stdout || "").trim();
      } catch {
        await git(shadow, source, ["add", "-A", "--", ".", ...excludePathspecs()]);
        await git(shadow, source, ["commit", "--allow-empty", "-m", `shadow base ${Date.now()}`]);
        const head = await git(shadow, null, ["rev-parse", "HEAD"]);
        base = String(head.stdout || "").trim();
      }
      if (!base) throw new Error("shadow: no base commit");

      const target = path.resolve(directory || path.join(path.dirname(shadow), "trees", String(name)));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await git(shadow, null, ["worktree", "add", "--detach", target, base]);
      return { directory: target, branch: "shadow", base };
    },

    async applyShadow(patchPath, { canonicalDir } = {}) {
      const shadow = shadowDir();
      const source = path.resolve(canonicalDir || config.canonical_dir || config.checkout || process.cwd());
      const status = await git(shadow, source, ["status", "--porcelain"]);
      if (String(status.stdout || "").trim()) throw new Error("shadow: canonical work tree is not clean");
      await git(shadow, source, ["apply", "--3way", path.resolve(patchPath)]);
    },

    async removeShadow(directory) {
      const shadow = shadowDir();
      if (!fs.existsSync(shadow)) return;
      await git(shadow, null, ["worktree", "remove", "--force", path.resolve(directory)]);
    },
  };
}