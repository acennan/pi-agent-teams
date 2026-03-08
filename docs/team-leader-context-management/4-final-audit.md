# Final Code Audit: Leader Extension (`leader.ts` and Associated Files)

**Date:** 2026-03-08
**Scope:** `extensions/teams/leader.ts`, `extensions/teams/leader-teams-tool.ts`, and all associated files extracted during the prior audit:

| File | Lines | Purpose |
|------|------:|---------|
| `leader.ts` | 547 | Orchestration hub — session lifecycle, event wiring, closure state |
| `leader-teams-tool.ts` | 157 | Legacy `teams` tool shim for resumed sessions |
| `leader-spawn.ts` | 260 | Teammate spawning + onClose handling |
| `leader-hooks.ts` | 353 | Hook/quality-gate processing pipeline |
| `leader-widget-callbacks.ts` | 173 | Interactive widget callback bag |
| `leader-inbox.ts` | 214 | Leader mailbox polling (idle, shutdown, plan approval) |
| `leader-tool-shared.ts` | 176 | Shared types, helpers, schema fragments for tool files |
| `leader-tool-delegate.ts` | 220 | `teams_delegate` tool handler |
| `leader-tool-task.ts` | 208 | `teams_task` tool handler |
| `leader-tool-message.ts` | 155 | `teams_message` tool handler |
| `leader-tool-member.ts` | 263 | `teams_member` tool handler |
| `leader-tool-policy.ts` | 369 | `teams_policy` tool handler |
| `leader-context-filter.ts` | 203 | Stale tool-result replacement (context event) |
| `leader-compaction.ts` | 58 | Team-aware compaction instructions |
| `task-mutations.ts` | 40 | Shared task-mutation updaters |
| `fire-and-forget.ts` | 14 | `fireAndForget` helper |

**Context:** This audit follows a comprehensive refactoring driven by the findings in `code-audit-leader-and-legacy-tool.md`. That audit identified issues across six categories (duplication, complexity, performance, error handling, security, maintainability) — all of which have been addressed. This final audit evaluates the post-refactoring state.

---

## Executive Summary

The codebase is in good shape. The prior audit's recommendations have been thoroughly implemented: `leader.ts` is down from ~998 to ~547 lines, duplicated logic has been centralised, fire-and-forget promises are handled, and the module decomposition is clean and navigable. The remaining findings are minor — mostly consistency gaps in `compactResult()` adoption across tool files, a few stray `void` fire-and-forget calls in files outside the original audit scope, and some low-value style nits. Nothing here rises to a priority that would block shipping.

---

## 1. Residual `compactResult()` Inconsistency

**Severity:** Low
**Files:** `leader-tool-message.ts` (7 raw returns, 3 `compactResult`), `leader-tool-member.ts` (9 raw, 6 `compactResult`), `leader-tool-policy.ts` (8 raw, 7 `compactResult`), `leader-tool-delegate.ts` (1 raw, 2 `compactResult`)

The prior audit (section 6.3) migrated `leader-tool-task.ts` to use `compactResult()` consistently. However, the other tool files still mix raw `{ content: [...], details: {...} }` returns with `compactResult()` calls. The same inconsistency the audit identified in `leader-tool-task.ts` exists in the sibling files.

**Recommendation:** Mechanical migration — same pattern as section 6.3. Low effort, improves cross-cutting change safety. Not urgent.

---

## 2. Remaining Fire-and-Forget `void` Calls

**Severity:** Low
**Files:** `leader-tool-delegate.ts` (line 177), `leader-lifecycle-commands.ts` (lines 283, 299, 385)

Three files still use bare `void promise` without `.catch()` or `fireAndForget()`:

```typescript
// leader-tool-delegate.ts:177
void opts.refreshTasks().finally(opts.renderWidget);

// leader-lifecycle-commands.ts:283
void setMemberStatus(teamDir, name, "online", { ... });

// leader-lifecycle-commands.ts:385
void setMemberStatus(teamDir, m.name, "offline", { ... });
```

These are the same class of issue addressed in audit section 4.1 for `leader-spawn.ts` and `leader-widget-callbacks.ts`, but in files that were outside the original audit scope.

**Recommendation:** Replace with `fireAndForget()`. Trivial effort. The `leader-lifecycle-commands.ts` instances are in slash command handlers where `ctx` is readily available.

---

## 3. Import Ordering in `leader-widget-callbacks.ts`

**Severity:** Trivial (style)
**File:** `leader-widget-callbacks.ts` line 168

```typescript
// ... (all other imports at top of file, lines 8-20) ...

// Line 168 — after the main exports
import { getTeamDir } from "./paths.js";
```

The `getTeamDir` import is placed at the bottom of the file after all exports, separated from the other imports by ~148 lines. This appears to be a refactoring artifact.

**Recommendation:** Move to the import block at the top of the file.

---

## 4. Magic Numbers — Still Inline

**Severity:** Low
**File:** `leader.ts` (lines 157, 163, 173, 210)

The prior audit (section 6.4) recommended consolidating magic numbers into named constants. The following are still inline:

| Value | Line | Purpose |
|-------|------|---------|
| `70` | 157 | Compaction trigger threshold (%) |
| `1000` | 163 | Refresh timer interval (ms) |
| `700` | 173 | Inbox poll interval (ms) |
| `5_000` | 210 | Attach claim heartbeat interval (ms) |

The prior audit marked section 6.4 as out of scope for implementation ("no action" was taken). These values are used exactly once each and are adequately contextualised by surrounding comments, so the practical risk is low.

**Recommendation:** Extract to named constants at the top of `runLeader` or to a shared `leader-constants.ts`. Low effort, marginal value at current codebase size.

---

## 5. `leader-inbox.ts` — Long Function

**Severity:** Low
**File:** `leader-inbox.ts` — `pollLeaderInbox` (214 lines, single function)

The `pollLeaderInbox` function handles five distinct message types (shutdown approved, shutdown rejected, plan approval request, peer DM, idle notification) in a single `for` loop with sequential `if/continue` branches. The idle-notification branch alone is ~80 lines. This is the same structural pattern that the prior audit flagged in `runLeader` (section 6.1), albeit at a smaller scale.

The function is not duplicated and each branch is self-contained, so the practical impact is low. However, it is the longest single function remaining in the leader subsystem.

**Recommendation:** No immediate action. If the idle-notification branch grows further (e.g. new sub-cases), consider extracting `handleIdleNotification(...)` as a named helper.

---

## 6. `leader-lifecycle-commands.ts` — Not Audited Previously

**Severity:** Informational
**File:** `leader-lifecycle-commands.ts` (559 lines)

This file is the largest in the leader subsystem (larger than `leader.ts` itself) and was outside the scope of the original audit. It handles `/team spawn`, `/team kill`, `/team shutdown`, `/team start`, `/team stop`, and related slash commands. A quick scan shows:

- Three bare `void` fire-and-forget calls (covered in finding #2 above).
- Four `catch (err)` blocks, all of which log or return errors — no silent swallowing.
- No duplicated logic with the tool handlers (the tool handlers call `spawnTeammateImpl` etc., while the commands have their own UX-oriented flows).

**Recommendation:** No action required. Noting for completeness that it was not part of the original or current audit scope.

---

## 7. `hookChain` — Unbounded Promise Chain

**Severity:** Low (theoretical)
**File:** `leader.ts` lines 253–283

The `hookChain` variable links each hook invocation as a `.then()` on the previous promise. In a long-running session with many hook invocations, this creates a linked list of resolved promises. V8 should GC resolved promises in such chains, but the pattern is unusual.

The `seenHookEvents` deduplication set (cleared on `session_switch`) bounds the number of distinct hook invocations. In practice, the chain rarely exceeds a few dozen links per session.

**Recommendation:** No action. The current approach is functionally correct and the theoretical GC concern has no observed impact. If profiling ever shows memory growth from long sessions, consider periodically resetting the chain: `hookChain = hookChain.then(() => { hookChain = Promise.resolve(); })`.

---

## 8. Positive Observations

The following aspects of the codebase are well-implemented and worth preserving:

1. **Clean module boundaries.** Each extracted file (`leader-hooks.ts`, `leader-spawn.ts`, `leader-widget-callbacks.ts`) has a clear interface type (`ProcessHookOpts`, `SpawnContext`, `WidgetCallbackContext`) that documents exactly what closure state it needs. This makes the dependency graph explicit despite the closure-based architecture.

2. **Consistent tool registration pattern.** All five tool files follow the same structure: schema → exported handler → registration function with `appendContextWarning`. The legacy shim (`leader-teams-tool.ts`) correctly routes to the same handlers.

3. **`POLICY_REMAP` derivation.** The programmatic derivation from `POLICY_ACTIONS` is clean and eliminates the duplicated-knowledge risk. Adding a new policy action now requires a single-location change.

4. **`fireAndForget` helper.** Simple, correct, and consistently applied in the files that were in scope. The warning-level notification is appropriate for background operations.

5. **`task-mutations.ts` shared helpers.** The `applyStatusChange`, `applyUnassign`, and `applyReassign` functions are pure, immutable updaters — easy to test and impossible to use incorrectly.

6. **Context filter (`leader-context-filter.ts`).** The stale-result replacement logic is well-structured with clear classification functions and a sensible `KEEP_RECENT_TOOL_RESULTS` threshold.

7. **Error handling in `leader-hooks.ts`.** The `processHookResult` orchestrator correctly sequences log persistence → quality-gate metadata → follow-up creation → remediation messaging, with UI notifications at each stage.

---

## Summary of Findings

| # | Finding | Severity | Effort | Recommendation |
|---|---------|----------|--------|----------------|
| 1 | `compactResult()` inconsistency in message/member/policy/delegate tool files | Low | Low | Migrate remaining raw returns |
| 2 | Bare `void` fire-and-forget in `leader-tool-delegate.ts` and `leader-lifecycle-commands.ts` | Low | Trivial | Replace with `fireAndForget()` |
| 3 | Misplaced import in `leader-widget-callbacks.ts` | Trivial | Trivial | Move to top of file |
| 4 | Inline magic numbers in `leader.ts` | Low | Low | Extract to named constants |
| 5 | `pollLeaderInbox` length (214 lines) | Low | Medium | Extract idle handler if it grows |
| 6 | `leader-lifecycle-commands.ts` not audited | Informational | — | Note for future audit scope |
| 7 | Theoretical unbounded promise chain in `hookChain` | Low | Trivial | No action needed |

**Overall assessment:** The codebase is clean, well-decomposed, and maintainable. All high-priority and medium-priority findings from the original audit have been resolved. The remaining items are low-severity consistency and style issues that pose no functional risk.
