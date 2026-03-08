# AGENTS

This file is the persistent context for LLM agents working in `destamatic-forge`.
It is prescriptive. Use it as the ground rules and architecture memory.

## PURPOSE & NON-GOALS
- Purpose: stable operational memory for agents so they can act correctly without re-discovering core architecture.
- Non-goals: this is not a full documentation set or per-module reference. Read code for specifics.
- If working inside a git submodule, always check for a nested `AGENTS.md` and follow it.

## PROJECT PHILOSOPHY
- Modules are atomic and self-contained; they rely on system guarantees, not defensive checks.
- Favor architecture alignment and clarity over defensive noise or convenience helpers.
- If it looks messy, re-organize it; do not patch with one-off helpers.
- READMEs are condensed, accurate summaries, not substitutes for code.

## DECISION HIERARCHY
1) System invariants
2) Architecture coherence
3) Module clarity
4) Style rules
5) Local convenience
6) Micro-optimizations

If a change violates a higher tier, it is wrong even if it “works.”

## ARCHITECTURE MAP (CONDENSED)
- Server core: `server/core.js` wires HTTP, WebSocket, module lifecycle, validation, schedule, sync.
- Module system: `server/modules.js` handles discovery, dependency sort, DI, config merge.
- Sync network: server `server/sync.js`, client `client/sync.js`, serialization in `common/clone.js`.
- Validation: `server/validate.js` wraps ODB with validators and cleanup hooks.
- ODB: `odb/` implements observable persistence and database/storage drivers.

## MODULE SYSTEM CONTRACT (CANONICAL)
- Hook names: `onConnection`, `onMessage`, `validate`, `schedule`, `internal`, `authenticated`.
- Injections always present (from `server/core.js`):
  - `config` (always defined)
  - `odb`, `server`, `env`, `serverProps`, `registerValidator`, `registerSchedule`, `logStartup`
  - `extensions`
  - `imports` (dependencies injected by short name, last path segment)
- Defaults are merged upstream; modules read `config` directly.
- Do not guard against missing `odb` or missing deps inside modules.

## CODING POLICY (STRICT)
- No one-off helper functions. Inline unless reused in multiple places.
- No aliasing `config` if it is used directly and not transformed.
- Shared utilities live in `common/` only if they are cross-module and justified.
- Keep code tight and direct; avoid helper sprawl.

## ANTI-PATTERNS
- Local helpers used once (e.g., `toArray`, `normalizeX`) instead of inline logic.
- Defensive guards for guaranteed injections.
- Re-declaring config aliases without transformation.

## DOCS POLICY
- Update AGENTS.md after any core architecture or invariant change.
- Update READMEs only after user confirms changes are working and satisfactory.
- Update CHANGES.md only after user confirms changes are working and satisfactory.
- Always tell the user when docs were updated.

## CHANGES.MD SPEC
- Before editing `CHANGES.md`, ensure the related changes are committed so hashes are real.
- Read recent git log to collect commit hashes and titles.
- Append new entries at the top (reverse-chronological order).
- Do not read the entire file; read only the top entries needed for the task.
- Chunk markers must wrap each entry for grep/rg usage:
  - Start: `/* CHANGE: DD-MM-YYYY */`
  - End: `/* END CHANGE */`
- Entry header format: `DD-MM-YYYY — [<hash1>, <hash2>, ...] — <aggregated title>`
- Commit hashes may be an array to group related commits.
- Required fields per entry:
  - Summary (concise description of what changed)
  - Breaking (yes/no)
  - Affected systems (e.g., server core, module system, client sync, ODB, common)
  - Files touched (list paths or directories, not full diffs)
  - Rationale (why the change was made)
  - Migration (only if breaking; otherwise omit)

## ECOSYSTEM CONTEXT
- destam: observer-based delta state (OObject/OArray/Observer) for direct mutation + tracked deltas.
- destam-dom: DOM updates directly (no VDOM), built on destam.
- destamatic-ui: opinionated UI framework built on destam/destam-dom (JSX, theming, stages).
- destamatic-forge: server+client runtime to make SaaS easy to spin up (coops/orgs/open-source/startups), centered on modules, sync, ODB, and scheduled jobs.
- destam/destam-dom docs live in `node_modules/destam` and `node_modules/destam-dom` within the consuming root project.
