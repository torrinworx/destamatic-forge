/* CHANGE: 06-03-2026 */
06-03-2026 — [1bafc00] — Add extension modules for config and overrides
Summary: Added extension modules to supply config and extension hooks alongside module overrides, updated auth/Enter to apply extension user fields, and migrated tests to the new extension-based config fixtures.
Breaking: yes
Affected systems: module system, server modules, tests
Files touched: server/modules.js, server/modules/auth/Enter.js, server/modules/posts/Scheduler.js, tests/authentication.test.js, tests/utils/modules/Probe.js, tests/utils/modules-config/**, tests/modules/auth/**
Rationale: Support user-defined module config and hooks without modifying core modules, while keeping override behavior explicit.
Migration: Move per-module config into extension modules, and only use moduleConfig to disable modules.
/* END CHANGE */

/* CHANGE: 06-03-2026 */
06-03-2026 — [7ad708a] — Add authenticated module access test
Summary: Added a unit-style authentication guard test with a local probe module to verify authenticated modules are blocked without a session token.
Breaking: no
Affected systems: tests
Files touched: tests/authentication.test.js, tests/utils/Probe.js
Rationale: Ensure authenticated modules are exercised in isolation without relying on live modules.
/* END CHANGE */

/* CHANGE: 06-03-2026 */
06-03-2026 — [2ebd74d] — Module hooks rename and config policy cleanup
Summary: Renamed module hooks to onConnection/onMessage, normalized webCore.config usage, removed defensive injection guards, and updated policy docs.
Breaking: yes
Affected systems: server core, module system, backend modules, docs policy
Files touched: server/core.js, server/modules/**, backend/modules/**, destamatic-forge/AGENTS.md
Rationale: Enforce atomic module assumptions, reduce defensive noise, and codify policy expectations.
Migration: Update any custom modules or clients to use onConnection/onMessage and rely on webCore.config directly.
/* END CHANGE */
