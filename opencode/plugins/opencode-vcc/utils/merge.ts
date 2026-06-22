// ~/.config/opencode/plugins/opencode-vcc/utils/merge.ts

/**
 * Section merge policy for compaction.
 *
 * Sticky sections (merge with previous): goals, files, commits
 * Volatile sections (replace on each compaction): transcript, blockers
 * Preference section: dedup against goals and existing preferences
 */

export interface VCCSections {
  goals: string[];
  scopeChanges: string[];
  files: { path: string; operation: string }[];
  commits: { hash: string; message: string }[];
  preferences: string[];
  blockers: string[];
  transcript: string;
}

/**
 * Merge new extraction with previous summary sections.
 * Sticky sections accumulate, volatile sections replace.
 */
export function mergeSections(
  previous: VCCSections | null,
  current: VCCSections
): VCCSections {
  if (!previous) return current;

  // Sticky: goals merge (dedup)
  const goals = dedup([...previous.goals, ...current.goals]).slice(0, 8);

  // Sticky: scope changes merge
  const scopeChanges = dedup([...previous.scopeChanges, ...current.scopeChanges]).slice(0, 4);

  // Sticky: files merge (dedup by path)
  const fileMap = new Map<string, { path: string; operation: string }>();
  for (const f of [...previous.files, ...current.files]) {
    fileMap.set(f.path, f);
  }
  const files = [...fileMap.values()].slice(0, 30);

  // Sticky: commits merge (dedup by hash+message)
  const commitMap = new Map<string, { hash: string; message: string }>();
  for (const c of [...previous.commits, ...current.commits]) {
    const key = `${c.hash}::${c.message}`;
    commitMap.set(key, c);
  }
  const commits = [...commitMap.values()].slice(0, 20);

  // Preference: dedup, cap at 10
  const preferences = dedup([...previous.preferences, ...current.preferences]).slice(0, 10);

  // Volatile: replace (blockers, transcript)
  const blockers = current.blockers;
  const transcript = current.transcript;

  return { goals, scopeChanges, files, commits, preferences, blockers, transcript };
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}
