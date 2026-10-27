# Swarm Artifact Rules (strict)

Single source of truth: `swarm-workspace.ps1` resolves all paths below.

## Naming

- Briefs: `.opencode/swarm/briefs/<swarm-id>/<lane>.md`
- Charter mirror: `.opencode/swarm/briefs/<swarm-id>/charter.md`
- Ledger: charter topic `swarm/<swarm-id>/charter` (max workers, stop rules)
- Board topics: `swarm/<swarm-id>/charter`, `swarm/<swarm-id>/<lane>`,
  `swarm/<swarm-id>/all`, `swarm/<swarm-id>/verdicts`

## Required sections

- Charter: objective, lanes + scopes, max workers, retry cap,
  stop rules, board topics, root id, baseline commit, checks.
- Brief: swarm + lane, root id, task, files, preserve-list, skills,
  charter topic, post-to topic, envelope format.
- Envelope: `Status:` / `Mutations:` / `Edge-Cases:` / `Deliverables:`. Cap 300 words.

## Depth / size caps

- Prime nests swarms max depth 2. Lane count only grows mid-flight.
- Envelope â‰¤300 words â€” enforced by `check-envelope.ps1`.

## Board read discipline

- LANES READ SINCE-CURSOR + CHARTER ONLY. NEVER FULL HISTORY.
- Full-log reads desynchronize: stale snapshots, divergent read offsets.
- More messages = worse. Transport is not authority.
- Prime verdicts are authoritative snapshots; lanes post conclusions-only.

## Enforcers

- Run `swarm-workspace.ps1 -SwarmId <id>` before writing any brief.
- Run `check-envelope.ps1 -File <envelope.md>` before integrating any lane.
