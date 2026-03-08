# Code Audit: `leader.ts` and `leader-teams-tool.ts`

**Date:** 2026-03-07  
**Files:**
- `extensions/teams/leader.ts` (998 lines)
- `extensions/teams/leader-teams-tool.ts` (144 lines)

**Scope:** Duplicated/convoluted code, maintainability, security, and performance.

---

## Executive Summary

`leader-teams-tool.ts` is in good shape — it's a thin, clearly-scoped legacy shim with minimal logic of its own. The vast majority of findings centre on `leader.ts`, which at ~1,000 lines acts as the orchestration hub for the entire teams extension. While not critically broken, it has accrued several categories of tech debt: duplicated control flow, an unbounded in-memory set, fire-and-forget promises that swallow errors, and one function (`enqueueHook`) that alone accounts for ~220 lines inside the already-long `runLeader` closure.

---

## 1. Duplicated Code ✅ COMPLETED

### 1.1 Refresh/poll timer setup — copy-pasted between `session_start` and `session_switch` ✅

**Status:** Completed — Extracted `startLoops(ctx)` helper in `leader.ts`. Both `session_start` and `session_switch` now call it instead of duplicating the timer setup.

### 1.2 Session initialisation preamble — repeated in `session_start` and `session_switch` ✅

**Status:** Completed — Extracted `initSession(ctx)` helper in `leader.ts`. `session_start` is now a one-liner calling `initSession(ctx)`. `session_switch` performs teardown (release claim, stop teammates, reset compaction flag) then calls `initSession(ctx)`.

### 1.3 Task mutation callbacks — duplicated between `openWidget` and `leader-tool-task.ts` ✅

**Status:** Completed — Created `task-mutations.ts` with three shared helpers:
- `applyStatusChange(cur, status)` — stamps `completedAt` / `reopenedAt`
- `applyUnassign(cur, by, reason)` — removes owner, resets to pending
- `applyReassign(cur, newOwner, by)` — reassigns with metadata

Both `leader.ts` (widget callbacks) and `leader-tool-task.ts` (tool handler) now import and use these shared helpers.

---

## 2. Complexity / Convoluted Code ✅ COMPLETED

### 2.1 `enqueueHook` — 220-line inline closure ✅

**Status:** Completed — Created `leader-hooks.ts` (353 lines) with five extracted functions:
- `buildFailureSummary(res)` — compact human-readable failure description
- `persistHookLog(invocation, res)` — log file persistence
- `applyQualityGateMetadata(...)` — quality-gate metadata stamping + reopen logic
- `createFollowupTask(...)` — follow-up task creation + mailbox notification
- `sendRemediationMessage(...)` — remediation message delivery

Plus `processHookResult(opts)` as the orchestrator that calls all of the above. `enqueueHook` in `leader.ts` is now ~25 lines: deduplication, hook execution, and a single `processHookResult` call.

### 2.2 `spawnTeammate` — 160-line inline closure ✅

**Status:** Completed — Created `leader-spawn.ts` (254 lines) with:
- `SpawnContext` interface for passing closure state
- `handleTeammateClose(...)` — extracted named `onClose` handler
- `spawnTeammateImpl(spawnCtx, ctx, opts)` — full spawn logic
- `BUILT_IN_TOOL_SET` hoisted to module scope (also addresses audit item 3.2)

`leader.ts` now constructs a `SpawnContext` and delegates to `spawnTeammateImpl` via a one-liner.

### 2.3 `openWidget` callback bag ✅

**Status:** Completed — Created `leader-widget-callbacks.ts` (172 lines) with:
- `WidgetCallbackContext` interface for closure state
- `buildWidgetCallbacks(wctx)` — builds the full `InteractiveWidgetDeps` object

`openWidget` in `leader.ts` is now ~15 lines: constructs the context and calls `openInteractiveWidget(ctx, deps)`.

**Net effect:** `leader.ts` reduced from ~998 lines to ~536 lines (46% reduction).

---

## 3. Performance Issues ✅ COMPLETED

### 3.1 `seenHookEvents` — unbounded `Set<string>` growth ✅

**Status:** Completed — `seenHookEvents.clear()` is now called in the `session_switch` handler alongside `compactionInFlight = false`.

### 3.2 `builtInToolSet` recreated on every spawn ✅

**Status:** Already addressed during section 2.2 refactoring — hoisted to `BUILT_IN_TOOL_SET` module-level constant in `leader-spawn.ts`.

### 3.3 `resolveTeamToolContext` calls `ensureTeamConfig` on every tool invocation ✅

**Status:** Completed — Added optional `getTeamConfig` getter to `TeamToolOpts`. `resolveTeamToolContext` now uses the cached config when available, only falling back to `ensureTeamConfig` when the cache returns `null`. The `toolOpts` object in `leader.ts` wires `getTeamConfig: () => teamConfig`.

### 3.4 `filterStaleTeamsResults` runs on every LLM call — no action needed

**Status:** Acknowledged — no immediate action needed per original recommendation. Impact is low (O(n) over typically < 200 messages). To be revisited if profiling shows a bottleneck.

---

## 4. Error Handling Issues ✅ COMPLETED

### 4.1 Fire-and-forget promises without error handlers ✅

**Status:** Completed — Created `fire-and-forget.ts` with a shared `fireAndForget(promise, ctx?)` helper that catches rejections and logs them via `ctx.ui.notify`. Applied in:
- `leader-spawn.ts` `handleTeammateClose`: `unassignTasksForAgent`, `refreshTasks`, and `setMemberStatus` now use `fireAndForget` instead of bare `void`. Added `getCurrentCtx` to `SpawnContext` interface to provide context access.
- `leader-widget-callbacks.ts` `killMember`: `rpc.stop()`, `unassignTasksForAgent`, `setMemberStatus`, and `refreshTasks` now use `fireAndForget`. Also updated `abortMember` to use `fireAndForget` for `rpc.abort()`.

### 4.2 Silent `catch {}` blocks ✅

**Status:** Completed — Replaced bare `catch {}` with logged warnings for non-trivial operations:
- `leader-hooks.ts` `persistHookLog`: now accepts optional `ctx` parameter and logs a warning on write failure instead of silently swallowing.
- `leader-spawn.ts` `spawnTeammateImpl`: mailbox write for session naming now logs a warning via `ctx.ui.notify` on failure.
- `leader-inbox.ts` `pollLeaderInboxImpl`: mailbox write for session naming now logs a warning via `ctx.ui.notify` on failure.

Bare `catch {}` blocks retained only for truly inconsequential operations (entry path probe in `getTeamsExtensionEntryPath`, event handler unsub cleanup, hook enqueue errors in inbox polling).

### 4.3 `hookChain` error isolation ✅

**Status:** Acknowledged — no action needed per original recommendation. The current approach is acceptable.

---

## 5. Security Considerations ✅ COMPLETED

### 5.1 `shellQuote` — non-standard escaping ✅

**Status:** Completed — Added JSDoc comment to `shellQuote` in `leader.ts` documenting that it is for display purposes only (used in `/team info` output) and should never be used to construct commands for programmatic execution.

### 5.2 Teammate name injection ✅

**Status:** Completed — Added trust-boundary documentation to `sanitizeName` in `names.ts` noting that the restrictive allowlist (`[a-zA-Z0-9_-]`) exists to prevent prompt injection via system prompt interpolation in `leader-spawn.ts`, and warning against relaxing the pattern without auditing downstream sites.

### 5.3 Unvalidated `params.model` pass-through ✅

**Status:** Acknowledged — no action needed. Low risk; the value flows through `resolveTeammateModelSelection()` validation before use.

---

## 6. Maintainability Issues

### 6.1 `runLeader` — God Function ✅ COMPLETED

**Status:** Already addressed by sections 1 and 2. `leader.ts` reduced from ~998 lines to ~547 lines through extraction of:
- `enqueueHook` → `leader-hooks.ts` (section 2.1)
- `spawnTeammate` → `leader-spawn.ts` (section 2.2)
- `openWidget` callbacks → `leader-widget-callbacks.ts` (section 2.3)
- `initSession` / `startLoops` → helper closures at top of `runLeader` (sections 1.1, 1.2)

### 6.2 `leader-teams-tool.ts` — `POLICY_REMAP` duplicates knowledge ✅ COMPLETED

**Status:** Completed — Exported `POLICY_ACTIONS` from `leader-tool-policy.ts` (the single source of truth for valid policy action names). `POLICY_REMAP` in `leader-teams-tool.ts` is now derived programmatically from `POLICY_ACTIONS` using a `LEGACY_PREFIX_MAP` (`hooks` → `hooks_policy`, `model` → `model_policy`). Adding a new policy action to `POLICY_ACTIONS` will automatically generate both the legacy and canonical routing entries.

### 6.3 Inconsistent result construction across tool files ✅ COMPLETED

**Status:** Completed — All 13 raw `{ content: [...], details: {...} }` return statements in `leader-tool-task.ts` have been migrated to use the shared `compactResult(text, details)` helper, consistent with the other tool files.

### 6.4 Magic numbers

Several thresholds are hardcoded across files:

| Value | Location | Purpose |
|-------|----------|---------|
| `70` | `leader.ts` (×2) | Compaction trigger threshold (%) |
| `65`, `80`, `85` | `leader-tool-shared.ts` | Context warning thresholds (%) |
| `1000` | `leader.ts` (×2) | Refresh timer interval (ms) |
| `700` | `leader.ts` (×2) | Inbox poll interval (ms) |
| `5_000` | `leader.ts` | Attach claim heartbeat interval (ms) |
| `6` | `leader-tool-task.ts`, `leader-context-filter.ts` | `MAX_DEPS`, `KEEP_RECENT_TOOL_RESULTS` |
| `4` | `leader-tool-shared.ts` | `LIST_THRESHOLD` |
| `60 * 60 * 1000` | `leader-tool-member.ts` | Prune cutoff (1 hour) |

**Recommendation:** Consolidate into a `leader-constants.ts` file, or at minimum ensure each value is a named constant at the top of its file (several already are — e.g. `LIST_THRESHOLD`, `MAX_DEPS`, `KEEP_RECENT_TOOL_RESULTS` — but the timer intervals and compaction thresholds are inline).

---

## 7. Summary of Recommendations (by priority)

### High Priority (reduces bug risk / maintenance burden)

| # | Issue | Section | Effort |
|---|-------|---------|--------|
| 1 | Extract duplicated timer setup into `startLoops()` | 1.1 | Low |
| 2 | Extract duplicated session init into `initSession()` | 1.2 | Low |
| 3 | Extract shared task-mutation helpers (widget + tool duplication) | 1.3 | Low |
| 4 | Clear `seenHookEvents` on `session_switch` | 3.1 | Trivial |
| 5 | Add error handling to fire-and-forget promises | 4.1 | Low |

### Medium Priority (improves maintainability / readability)

| # | Issue | Section | Effort |
|---|-------|---------|--------|
| 6 | Extract `enqueueHook` into `leader-hooks.ts` | 2.1 | Medium |
| 7 | Migrate raw returns in `leader-tool-task.ts` to `compactResult()` | 6.3 | Low |
| 8 | Replace silent `catch {}` with logged warnings where appropriate | 4.2 | Low |
| 9 | Hoist `builtInToolSet` to module scope | 3.2 | Trivial |
| 10 | Consolidate magic numbers into named constants | 6.4 | Low |

### Low Priority (further cleanup)

| # | Issue | Section | Effort |
|---|-------|---------|--------|
| 11 | Extract `spawnTeammate` into `leader-spawn.ts` | 2.2 | Medium |
| 12 | Extract `openWidget` callbacks into controller | 2.3 | Medium |
| 13 | Cache `teamConfig` in tool opts to avoid per-call `ensureTeamConfig` | 3.3 | Low |
| 14 | Make `POLICY_REMAP` derivable from the policy action schema | 6.2 | Low |
| 15 | Add trust-boundary comment on `sanitizeName` → system prompt path | 5.2 | Trivial |
