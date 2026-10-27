# memo (opencode) — prose: prompts.json (memo://summary)
skill_sync(harness:"opencode", known:<local name/hash list>)
agent_id: server-minted on first skill_sync, persisted in .memo-sync.json, presented on every sync
after a workflow worth repeating (5+ tool calls / non-obvious fix): skill_put + write skills/<name>/SKILL.md
new skill: skill_create(name, description, body) -> writes skills/<name>/SKILL.md + auto skill_put
