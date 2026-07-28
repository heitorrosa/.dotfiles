import { tool } from "@opencode-ai/plugin"
import type { SkillManager } from "../skill-manager.ts"

/**
 * Create skill-related custom tools for the agent.
 * These let the agent capture reusable workflows as SKILL.md files
 * that OpenCode loads automatically in future sessions.
 */
export function createSkillTools(skillManager: SkillManager): Record<string, ReturnType<typeof tool>> {
  return {
    /**
     * skill_create — Document a reusable workflow as a persistent Skill
     */
    skill_create: tool({
      description: `Create a reusable SKILL.md file documenting a workflow, so you can perform it better in future sessions.

**When to use this:**
- You just completed a complex task with 5+ tool calls
- You found a non-obvious solution after trial and error
- You discovered a multi-step workflow that will likely be needed again
- The user asked you to remember how to do something

**Skill name rules:** lowercase letters, numbers, and hyphens only. Examples:
- "deploy-to-aws", "database-migration", "create-react-component", "git-release-workflow"

**Good skill content includes:**
- What the skill does (in 2-3 sentences)
- Step-by-step instructions
- Common pitfalls to avoid
- Example commands or code snippets

The skill will be immediately available to you in all future sessions via the \`skill\` tool.`,
      args: {
        name: tool.schema
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be lowercase alphanumeric with hyphens")
          .max(64)
          .describe("Skill name: lowercase, hyphen-separated (e.g. 'deploy-to-aws')"),
        description: tool.schema
          .string()
          .min(10)
          .max(200)
          .describe(
            "One-line description of what this skill does — shown to the agent for selection (be specific)"
          ),
        content: tool.schema
          .string()
          .min(50)
          .describe("Full skill content in Markdown. Include steps, commands, and pitfalls to avoid."),
      },
      async execute(args) {
        const name = args.name as string
        const description = args.description as string
        const content = args.content as string

        const filePath = skillManager.create(name, description, content)
        return `Skill '${name}' created at ${filePath}. It will be listed under <available_skills> in all future sessions. You can load it with the \`skill\` tool by name.`
      },
    }),

    /**
     * skill_update — Add new learnings to an existing skill
     */
    skill_update: tool({
      description: `Add new learnings, corrections, or refinements to an existing skill.

Use this when:
- You used a skill and discovered it was incomplete or had errors
- You found a better approach than what the skill documents
- The user corrected something the skill said

This appends an update section to the existing SKILL.md — it does NOT overwrite the original.`,
      args: {
        name: tool.schema
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .describe("Name of the existing skill to update"),
        patch: tool.schema
          .string()
          .min(10)
          .describe("The new learning or correction to add to the skill"),
      },
      async execute(args) {
        const name = args.name as string
        const patch = args.patch as string

        if (!skillManager.exists(name)) {
          return `Skill '${name}' not found. Available skills: ${skillManager
            .list()
            .map((s) => s.name)
            .join(", ") || "none yet"}. Use skill_create to create it first.`
        }

        const filePath = skillManager.update(name, patch)
        return `Skill '${name}' updated at ${filePath}. The update is now part of the skill documentation.`
      },
    }),

    /**
     * skill_list — List all auto-created skills
     */
    skill_list: tool({
      description: `List all skills that have been created by the Hermes memory plugin.

Use this to see what workflows have been documented so far, or to check if a skill already exists before creating a new one.`,
      args: {},
      async execute() {
        const skills = skillManager.list()
        if (skills.length === 0) {
          return "No skills created yet. Use skill_create after completing complex tasks to build up your skill library."
        }
        const lines = skills.map((s) => `- **${s.name}**: ${s.description}`)
        return `## Hermes Skills (${skills.length} total)\n\n${lines.join("\n")}`
      },
    }),
  }
}
