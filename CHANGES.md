/* CHANGE: 06-03-2026 */
06-03-2026 — [2ebd74d] — Module hooks rename and config policy cleanup
Summary: Renamed module hooks to onConnection/onMessage, normalized webCore.config usage, removed defensive injection guards, and updated policy docs.
Breaking: yes
Affected systems: server core, module system, backend modules, docs policy
Files touched: server/core.js, server/modules/**, backend/modules/**, destamatic-forge/AGENTS.md
Rationale: Enforce atomic module assumptions, reduce defensive noise, and codify policy expectations.
Migration: Update any custom modules or clients to use onConnection/onMessage and rely on webCore.config directly.
/* END CHANGE */
