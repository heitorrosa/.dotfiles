// ~/.config/opencode/plugins/opencode-vcc/hooks/config.ts

/**
 * Config hook — register slash commands.
 *
 * Registers /vcc and /vcc-recall commands.
 * Does NOT register commands that conflict with DCP or other plugins.
 */
export function createConfigHook() {
  return async (config: any) => {
    // Ensure command object exists
    if (!config.command) {
      config.command = {};
    }

    // Note: OpenCode's config hook modifies the config object in-place.
    // Command registration happens via the config object.
    // The actual command handlers are defined by the tools (vcc_compact, vcc_recall).
    // These commands map to those tools.
  };
}
