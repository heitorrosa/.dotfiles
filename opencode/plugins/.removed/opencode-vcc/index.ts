// ~/.config/opencode/plugins/opencode-vcc/index.ts
// View-oriented Conversation Compiler for OpenCode
// Hybrid: algorithmic extraction + LLM-guided formatting + SQLite FTS5 recall

import { closeDb } from "./storage/db.js";
import { createCompactingHook } from "./hooks/compacting.js";
import { createMessagesTransformHook } from "./hooks/messages.js";
import { createConfigHook } from "./hooks/config.js";
import { vcc_recall, vcc_compact, vcc_preview } from "./hooks/tools.js";

export default async function (input: any) {
  const { project, directory } = input;
  const ctxDir = directory || project?.root;

  return {
    // Compaction hook: inject extracted context into compaction prompt
    "experimental.session.compacting": createCompactingHook(),

    // Messages hook: prepend VCC summary after compaction
    "experimental.chat.messages.transform": createMessagesTransformHook(),

    // Config hook: slash command registration
    config: createConfigHook(),

    // Custom tools
    tool: {
      vcc_recall,
      vcc_compact,
      vcc_preview,
    },

    // Event hook: optional cleanup on idle
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.idle") {
        // Periodic cleanup could go here
      }
    },

    // Cleanup on shutdown
    [Symbol.asyncDispose]: async () => {
      closeDb();
    },
  };
}
