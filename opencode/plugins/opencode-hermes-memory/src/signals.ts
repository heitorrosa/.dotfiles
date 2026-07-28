/**
 * Signal detection — scans tool output for persistable moments.
 * Patterns adapted from ACP's signal detection.
 */

const CORRECTION_PATTERNS = [
  /\bno[,.!]\s/i,
  /\bactually\b/i,
  /\bthat'?s\s+(not|wrong|incorrect)\b/i,
  /\byou\s+should\s+have\b/i,
  /\buse\s+\S+\s+instead\b/i,
  /\bdon'?t\s+(use|do|run|call)\b/i,
  /\bincorrect\b/i,
]

const WORKFLOW_PATTERNS = [
  /step\s+\d+\s*(of|:)/i,
  /phase\s+\d+/i,
  /successfully\s+(completed|deployed|built|installed)/i,
]

const ENVIRONMENT_PATTERNS = [
  /deploy(?:ment)?\s+(via|using|with|command)/i,
  /build\s+(command|step|script)/i,
  /runtime:\s*/i,
  /package\s+manager/i,
  /node\s+version/i,
  /\b(pnpm|bun|yarn|npm)\b.*\b(install|run|build)\b/i,
]

export type SignalType = "correction" | "workflow" | "environment"

export function detectSignalInToolOutput(toolName: string, output: string): SignalType | null {
  if (toolName.startsWith("memory_") || toolName.startsWith("ctx_")) return null

  for (const pattern of WORKFLOW_PATTERNS) {
    if (pattern.test(output)) return "workflow"
  }
  for (const pattern of ENVIRONMENT_PATTERNS) {
    if (pattern.test(output)) return "environment"
  }
  return null
}

export function detectCorrectionInText(text: string): boolean {
  if (text.includes("[Hermes Memory — Correction Detected]")) return false
  return CORRECTION_PATTERNS.some((p) => p.test(text))
}
