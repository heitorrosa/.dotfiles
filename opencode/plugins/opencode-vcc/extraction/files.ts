// ~/.config/opencode/plugins/opencode-vcc/extraction/files.ts

import type { NormalizedBlock } from "../utils/normalize.js";
import { getToolBlocks } from "../utils/filter.js";

const TOOL_TO_OPERATION: Record<string, "read" | "write" | "delete" | "search" | "other"> = {
  read: "read",
  read_file: "read",
  write: "write",
  write_file: "write",
  edit: "write",
  edit_file: "write",
  create_file: "write",
  delete_file: "delete",
  remove_file: "delete",
  grep: "search",
  search: "search",
  glob: "search",
  find: "search",
  bash: "other",
  shell: "other",
};

const GIT_OPERATION_PATTERNS = /\b(git\s+(add|rm|mv|checkout|reset))\s+(\S+)/g;

export interface FileRecord {
  path: string;
  operation: "read" | "write" | "delete" | "search" | "other";
  toolName: string;
}

export interface FileExtraction {
  files: FileRecord[];
  uniquePaths: string[];
  commonPrefix: string;
}

/**
 * Extract file operations from tool call/result blocks.
 * Maps tool names to file operations, tracks modified/created/deleted files.
 */
export function extractFiles(blocks: NormalizedBlock[]): FileExtraction {
  const toolBlocks = getToolBlocks(blocks);
  const files: FileRecord[] = [];

  for (const block of toolBlocks) {
    if (!block.toolName) continue;

    const operation = TOOL_TO_OPERATION[block.toolName] ?? "other";

    // Extract file paths from tool arguments/results
    const paths = extractPathsFromContent(block.content, block.toolName);

    for (const path of paths) {
      // Dedup: same path + same operation
      const existing = files.find(
        (f) => f.path === path && f.operation === operation
      );
      if (!existing) {
        files.push({ path, operation, toolName: block.toolName });
      }
    }

    // Special handling for bash: check for git operations
    if (block.toolName === "bash" || block.toolName === "shell") {
      const gitFiles = extractGitFileOps(block.content);
      for (const gf of gitFiles) {
        const existing = files.find(
          (f) => f.path === gf.path && f.operation === gf.operation
        );
        if (!existing) {
          files.push(gf);
        }
      }
    }
  }

  const uniquePaths = [...new Set(files.map((f) => f.path))];
  const commonPrefix = findLongestCommonPrefix(uniquePaths);

  return { files, uniquePaths, commonPrefix };
}

function extractPathsFromContent(content: string, toolName: string): string[] {
  const paths: string[] = [];

  // First, try to extract from JSON tool arguments (common pattern)
  // Matches "path":"value", "file":"value", "filePath":"value", etc.
  const jsonKeyRegex = /"(?:path|file|filePath|filename|target|source|destination)":\s*"([^"]+)"/gi;
  let match;
  while ((match = jsonKeyRegex.exec(content)) !== null) {
    const p = match[1];
    if (p.length > 3 && p.length < 500 && /\.\w{1,10}$/.test(p)) {
      paths.push(p);
    }
  }

  // If no JSON paths found, try generic path patterns
  if (paths.length === 0) {
    const pathRegex = /(?:["'\s]|^)((?:\/|\.\/|\.\.\/|[A-Za-z]:\\)[^\s"':,;]+(?:\.\w{1,10}))/gm;
    while ((match = pathRegex.exec(content)) !== null) {
      const p = match[1];
      if (p.length > 3 && p.length < 500) {
        paths.push(p);
      }
    }
  }

  return paths;
}

function extractGitFileOps(content: string): FileRecord[] {
  const records: FileRecord[] = [];
  let match;
  while ((match = GIT_OPERATION_PATTERNS.exec(content)) !== null) {
    const gitOp = match[2];
    const filePath = match[3];
    let operation: FileRecord["operation"] = "other";
    if (gitOp === "add") operation = "write";
    else if (gitOp === "rm") operation = "delete";
    else if (gitOp === "mv") operation = "write";
    records.push({ path: filePath, operation, toolName: "bash" });
  }
  return records;
}

function findLongestCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const parts = paths[0].split(/[/\\]/);
    parts.pop();
    return parts.join("/");
  }

  const splitPaths = paths.map((p) => p.split(/[/\\]/));
  const minLen = Math.min(...splitPaths.map((p) => p.length));
  const prefix: string[] = [];

  for (let i = 0; i < minLen; i++) {
    const segment = splitPaths[0][i];
    if (splitPaths.every((p) => p[i] === segment)) {
      prefix.push(segment);
    } else {
      break;
    }
  }

  return prefix.join("/");
}
